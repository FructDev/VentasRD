import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { ApartadoLocal, ReparacionLocal, ClienteLocal, ProductoLocal } from '@/types/database';
import { v5 as uuidv5 } from 'uuid';
import { registrarMovimientoStockEn } from '@/lib/db/stock';
import { normalizeInventoryInteger } from '@/lib/sync/inventory/canonical-payload';
import { requireProductAtScope } from '@/lib/sync/inventory/scope-stock';
import { prepareNewLocalProduct } from '@/lib/sync/inventory/bootstrap';
import { commandHash, moneyCents } from './command';
import {getSharedCaptureContext} from '@/lib/sync/shared-capture';

const EFFECT_NAMESPACE = '99999999-9999-4999-8999-999999999999';
type Documento = ApartadoLocal | ReparacionLocal;
export interface ServicioEntrada {
    operationId: string; negocioId: string; sucursalId?: string; originDeviceId: string; fecha: number;
    tipo: 'APARTADO' | 'REPARACION'; accion: 'GUARDAR' | 'CANCELAR' | 'COMPLETAR' | 'DESPIECE';
    documento: ApartadoLocal | ReparacionLocal; previo?: ApartadoLocal | ReparacionLocal;
    clienteNuevo?: ClienteLocal; productosNuevos?: ProductoLocal[];
    entradasDespiece?: { productoId: string; cantidad: number }[];
    garantiaDias?: number;
}
/** Versionar contenido comercial, sin interpretar el flag de upload como versión. */
export function documentVersion(documento: Documento): string {
    const { estado_sincronizacion: _sync, ...facts } = documento;
    void _sync;
    return commandHash(facts);
}
function reservation(documento: Documento | undefined,shared=false): Map<string, number> {
    const result = new Map<string, number>();
    if (!documento) return result;
    if(shared&&!('items'in documento)&&['cancelado','no_reparado','abandonado'].includes(documento.estado))return result;
    if ('items' in documento) {
        if (documento.estado === 'cancelado') return result;
        for (const item of documento.items) {
            if (Number(normalizeInventoryInteger(item.cantidad)) <= 0) throw new Error('cantidad_invalida');
            result.set(item.producto_id, (result.get(item.producto_id) ?? 0) + item.cantidad);
        }
    } else {
        for (const part of documento.repuestos) {
            if (!Number.isFinite(part.cantidad) || part.cantidad <= 0) throw new Error('cantidad_invalida');
            if (part.desde_inventario && part.producto_id && part.stock_aplicado) {
                normalizeInventoryInteger(part.cantidad);
                result.set(part.producto_id, (result.get(part.producto_id) ?? 0) + part.cantidad);
            }
        }
    }
    return result;
}

/** Solo hechos locales. Todos los reads dependientes y writes comparten un lock.
 * Versión esperada impide que un formulario viejo reemplace abonos/stock actuales.
 * No decide reglas de refund ni envía el agregado al worker legacy. */
export async function commitServicioLocal(db: VentaRDDatabase, entrada: ServicioEntrada): Promise<{
    documento: Documento; reutilizada: boolean;
}> {
    entrada = structuredClone(entrada);
    const hash = commandHash({ contractVersion: 1, ...entrada });
    const journalId = `${entrada.negocioId}:${entrada.tipo}:${entrada.operationId}`;
    if (!entrada.operationId || !entrada.negocioId || !entrada.originDeviceId ||
        !Number.isSafeInteger(entrada.fecha) || entrada.fecha <= 0) throw new Error('servicio_contexto_invalido');
    const doc = entrada.documento;
    if (doc.negocio_id !== entrada.negocioId || (doc.sucursal_id ?? null) !== (entrada.sucursalId ?? null)) throw new Error('documento_ambito_invalido');
    if ((entrada.tipo === 'APARTADO') !== ('items' in doc)) throw new Error('documento_tipo_invalido');
    const table = entrada.tipo === 'APARTADO' ? db.apartados : db.reparaciones;
    return db.transaction('rw', [db.apartados, db.reparaciones, db.productos, db.movimientos_stock,
        db.seriales, db.clientes, db.operaciones_locales, db.cajas], async () => {
        const journal = await db.operaciones_locales.get(journalId);
        if (journal) {
            if (journal.payload_hash !== hash) throw new Error('operacion_id_conflicto');
            return { documento: journal.resultado as Documento, reutilizada: true };
        }
        const current = await table.get(doc.id);
        if (current && (current.negocio_id !== entrada.negocioId || (current.sucursal_id ?? null) !== (entrada.sucursalId ?? null))) throw new Error('documento_ambito_invalido');
        if ((!!current !== !!entrada.previo) || current && entrada.previo && documentVersion(current) !== documentVersion(entrada.previo)) throw new Error('documento_version_conflicto');
        if ('items' in doc) {
            if (!doc.items.length) throw new Error(current ? 'apartado_items_inmutables' : 'apartado_sin_items');
            if (current && 'items' in current && commandHash(doc.items) !== commandHash(current.items)) throw new Error('apartado_items_inmutables');
        }
        if (!current && entrada.accion !== 'GUARDAR') throw new Error('documento_no_encontrado');
        if (entrada.accion === 'CANCELAR' && doc.estado !== 'cancelado') throw new Error('cancelacion_invalida');
        if (entrada.accion === 'DESPIECE' && (entrada.tipo !== 'REPARACION' || current?.estado !== 'abandonado' || doc.estado !== 'cancelado')) throw new Error('despiece_estado_invalido');
        if (entrada.accion === 'COMPLETAR' && (entrada.tipo !== 'APARTADO' || current?.estado !== 'activo' || doc.estado !== 'completado')) throw new Error('entrega_estado_invalido');
        moneyCents(doc.total);
        moneyCents('items' in doc ? doc.abonado : doc.abono);
        if ('items' in doc) {
            for (const item of doc.items) moneyCents(item.precio_unitario);
            for (const payment of doc.abonos) moneyCents(payment.monto);
        } else {
            moneyCents(doc.mano_obra);
            for (const part of doc.repuestos) { moneyCents(part.precio); moneyCents(part.costo); }
            for (const payment of doc.pagos ?? []) moneyCents(payment.monto);
        }
        const previousPayments = current ? ('items' in current ? current.abonos : current.pagos ?? []) : [];
        const payments = 'items' in doc ? doc.abonos : doc.pagos ?? [];
        if (payments.length < previousPayments.length || commandHash(payments.slice(0, previousPayments.length)) !== commandHash(previousPayments)) {
            throw new Error('pagos_historicos_no_modificables');
        }
        const newPayments = payments.slice(previousPayments.length);
        if (newPayments.length) {
            const turnos = await db.cajas.where('negocio_id').equals(entrada.negocioId)
                .filter(c => c.estado === 'abierta' && (c.sucursal_id ?? null) === (entrada.sucursalId ?? null)).toArray();
            if (turnos.length > 1) throw new Error('turno_ambiguo');
            const turno = turnos[0];
            if (newPayments.some(p => p.metodo === 'efectivo' && p.monto > 0) && !turno) throw new Error('turno_requerido');
            for (const payment of newPayments) {
                if (!['efectivo', 'tarjeta', 'transferencia'].includes(payment.metodo)) throw new Error('metodo_pago_invalido');
                if (!Number.isSafeInteger(payment.fecha) || payment.fecha !== entrada.fecha || turno && payment.fecha < turno.fecha_apertura) throw new Error('turno_fecha_invalida');
                if (turno) payment.caja_id = turno.id;
            }
        }
        // Todos los clientes se crean en la misma transacción que su documento.
        if (entrada.clienteNuevo) {
            if (entrada.clienteNuevo.negocio_id !== entrada.negocioId) throw new Error('cliente_ambito_invalido');
            await db.clientes.add(entrada.clienteNuevo);
        }
        if (doc.cliente_id) {
            const cliente = await db.clientes.get(doc.cliente_id);
            if (!cliente || cliente.eliminado || cliente.negocio_id !== entrada.negocioId) throw new Error('cliente_ambito_invalido');
        }
        if ((entrada.productosNuevos?.length || entrada.entradasDespiece?.length) && entrada.accion !== 'DESPIECE') throw new Error('despiece_entrada_invalida');
        for (const product of entrada.productosNuevos ?? []) {
            if (product.negocio_id !== entrada.negocioId || product.stock_actual !== 0 || product.tipo !== 'insumo') throw new Error('despiece_producto_invalido');
            await db.productos.add(prepareNewLocalProduct(product, { negocioId: entrada.negocioId, sucursalId: entrada.sucursalId ?? null }));
        }
        if (!current) {
            const shared=getSharedCaptureContext(db);
            const sharedWriter=shared?.tenantId===entrada.negocioId&&(shared.branchId??null)===(entrada.sucursalId??null)?shared:null;
            const prefix = (entrada.tipo === 'APARTADO' ? 'AP' : 'REP')+(sharedWriter?'-N'+sharedWriter.installationId.replaceAll('-',''):'');
            const rows = await table.where('negocio_id').equals(entrada.negocioId).toArray();
            const max = rows.reduce((value, row) => Math.max(value, Number(new RegExp(`^${prefix}-(\\d+)$`).exec(row.folio)?.[1] ?? 0)), 0);
            const reserved=sharedWriter?Number(new RegExp(`^${prefix}-(\\d+)$`).exec(doc.folio)?.[1]??0):0;
            doc.folio = `${prefix}-${String(Math.max(max+1,reserved)).padStart(3, '0')}`;
        }
        const common=getSharedCaptureContext(db);
        const shared=common?.tenantId===entrada.negocioId&&(common.branchId??null)===(entrada.sucursalId??null);
        const oldStock = reservation(current,shared);
        const newStock = reservation(doc,shared);
        const deltas = new Map<string, number>();
        for (const pid of new Set([...oldStock.keys(), ...newStock.keys()])) deltas.set(pid, (oldStock.get(pid) ?? 0) - (newStock.get(pid) ?? 0));
        for (const piece of entrada.entradasDespiece ?? []) {
            if (Number(normalizeInventoryInteger(piece.cantidad)) <= 0) throw new Error('despiece_cantidad_invalida');
            deltas.set(piece.productoId, (deltas.get(piece.productoId) ?? 0) + piece.cantidad);
        }
        // Validar TODO antes de aplicar cualquier delta. El lock también cubre seriales.
        for (const [pid, delta] of deltas) {
            const product = await db.productos.get(pid);
            if (!product || product.negocio_id !== entrada.negocioId || product.eliminado) throw new Error('producto_ambito_invalido');
            const projected = requireProductAtScope(product, { negocioId: entrada.negocioId, sucursalId: entrada.sucursalId ?? null });
            normalizeInventoryInteger(projected.stock_actual);
            if (Number(normalizeInventoryInteger(projected.stock_actual + delta)) < 0) throw new Error('stock_insuficiente');
        }
        if ('items' in doc) {
            const seen = new Set<string>();
            for (const item of doc.items) {
                if (!item.serial_id) continue;
                if (seen.has(item.serial_id) || item.cantidad !== 1) throw new Error('serial_reserva_invalida');
                seen.add(item.serial_id);
                const serial = await db.seriales.get(item.serial_id);
                if (!serial || serial.negocio_id !== entrada.negocioId || serial.producto_id !== item.producto_id || serial.numero_serial !== item.serial_numero) throw new Error('serial_ambito_invalido');
                if (serial.estado !== (current ? 'apartado' : 'disponible')) throw new Error('serial_no_disponible');
                await db.seriales.update(serial.id, {
                    estado: doc.estado === 'cancelado' ? 'disponible' : doc.estado === 'completado' ? 'vendido' : 'apartado',
                    ...(doc.estado === 'completado' ? {
                        fecha_venta: entrada.fecha, garantia_dias: entrada.garantiaDias ?? 0,
                        garantia_hasta: (entrada.garantiaDias ?? 0) > 0 ? entrada.fecha + entrada.garantiaDias! * 86_400_000 : null,
                        precio_venta: item.precio_unitario, cliente_nombre: doc.cliente_nombre,
                    } : {}), estado_sincronizacion: 0, fecha_actualizacion: entrada.fecha,
                });
            }
        }
        for (const [pid, delta] of deltas) {
            if (!delta) continue;
            await registrarMovimientoStockEn(db, { negocioId: entrada.negocioId, sucursalId: entrada.sucursalId,
                originDeviceId: entrada.originDeviceId, now: entrada.fecha,
                operationId: uuidv5(`${entrada.operationId}:${pid}`, EFFECT_NAMESPACE) },
            { productoId: pid, tipo: entrada.tipo === 'APARTADO' ? (delta > 0 ? 'devolucion' : 'apartado') : 'reparacion', delta, referenciaId: doc.id });
        }
        doc.estado_sincronizacion = 0;
        doc.fecha_actualizacion = entrada.fecha;
        // Discriminación explícita para evitar Table<Union> escribiendo DTO incorrecto.
        if ('items' in doc) await db.apartados.put(doc);
        else await db.reparaciones.put(doc);
        await db.operaciones_locales.add({ id: journalId, negocio_id: entrada.negocioId, operation_id: entrada.operationId,
            tipo: entrada.tipo, contract_version: 1, payload_hash: hash, estado_local: 'COMMITTED',
            estado_remoto: 'NOT_ENABLED', fecha_origen: entrada.fecha, resultado: doc });
        return { documento: doc, reutilizada: false };
    });
}
