import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { DevolucionLocal, SerialLocal } from '@/types/database';
import type { EfectosVentaLocal } from '@/lib/domain/ventas/contrato';
import { commandHash, moneyCents } from '@/lib/domain/local/command';
import { normalizeInventoryInteger } from '@/lib/sync/inventory/canonical-payload';
import { requireProductAtScope } from '@/lib/sync/inventory/scope-stock';
import { registrarMovimientoStockEn } from '@/lib/db/stock';
import { v5 as uuidv5 } from 'uuid';
import { buscarCargoFiadoDeVenta, calcularMontoDevolucion, cantidadesDisponiblesParaDevolver } from './devoluciones';
import {sharedReturnStockBasis} from '@/lib/sync/shared-history-basis';

export interface DevolucionEntrada {
    operationId: string; negocioId: string; sucursalId?: string; originDeviceId: string;
    fecha: number; ventaId: string; razon: string;
    /** Ausente = devolver todo lo pendiente, leyendo los hechos persistidos. */
    cantidades?: { productoId: string; cantidad: number }[];
    serialIds?: string[];
}

export async function confirmarDevolucionLocal(database: VentaRDDatabase, entrada: DevolucionEntrada): Promise<{
    devolucion: DevolucionLocal; reutilizada: boolean;
}> {
    entrada = structuredClone(entrada);
    if (!entrada.operationId || !entrada.originDeviceId || !Number.isSafeInteger(entrada.fecha) || entrada.fecha <= 0) throw new Error('refund_command_invalid');
    const hash = commandHash({ kind: 'REFUND', contractVersion: 1, ...entrada });
    const journalId = `${entrada.negocioId}:REFUND:${entrada.operationId}`;
    return database.transaction('rw', [database.ventas, database.venta_detalles, database.devoluciones,
        database.productos, database.movimientos_stock, database.transacciones_fiado, database.seriales,
        database.operaciones_locales, database.cajas, database.shared_entities], async () => {
        const previous = await database.devoluciones.get(entrada.operationId);
        const journal = await database.operaciones_locales.get(journalId);
        if (previous || journal) {
            if (!previous || previous.negocio_id !== entrada.negocioId || !journal || journal.payload_hash !== hash) throw new Error('operacion_id_conflicto');
            return { devolucion: journal.resultado as DevolucionLocal, reutilizada: true };
        }
        const venta = await database.ventas.get(entrada.ventaId);
        if (!venta || venta.negocio_id !== entrada.negocioId || (venta.sucursal_id && !entrada.sucursalId) || (venta.sucursal_id && entrada.sucursalId && venta.sucursal_id !== entrada.sucursalId)) throw new Error('refund_ambito_invalido');
        if (entrada.fecha < venta.fecha_creacion) throw new Error('refund_fecha_invalida');
        const detalles = await database.venta_detalles.where('venta_id').equals(venta.id).toArray();
        if (!detalles.length || detalles.some(d => d.negocio_id !== entrada.negocioId)) throw new Error('refund_sale_basis_unavailable');
        const previas = await database.devoluciones.where('negocio_id').equals(entrada.negocioId).filter(d => d.venta_id === venta.id).toArray();
        const disponibles = cantidadesDisponiblesParaDevolver(detalles, previas);
        const cantidades = entrada.cantidades ? new Map(entrada.cantidades.map(i => [i.productoId, i.cantidad])) : disponibles;
        if (entrada.cantidades && cantidades.size !== entrada.cantidades.length) throw new Error('refund_quantity_invalid');
        if (![...cantidades.values()].some(c => c > 0)) throw new Error('refund_nothing_remaining');
        const monto = calcularMontoDevolucion({ venta, detalles, devolucionesPrevias: previas, cantidades });
        moneyCents(monto);
        const saleJournal = await database.operaciones_locales.get(`${entrada.negocioId}:SALE:${venta.id}`);
        const efectos = saleJournal?.resultado as EfectosVentaLocal | undefined;
        const vendidos = new Map<string, number>();
        for (const d of detalles) vendidos.set(d.producto_id, (vendidos.get(d.producto_id) ?? 0) + d.cantidad);
        let bases = efectos?.stockPorItem ?? await sharedReturnStockBasis(database,venta.id);
        if (!bases) {
            const movimientos = efectos?.movimientosStock ?? await database.movimientos_stock.where('negocio_id')
                .equals(entrada.negocioId).filter(m => m.tipo === 'venta' && m.referencia_id === venta.id).toArray();
            const stockVendidos = new Map([...vendidos].filter(([id]) => !detalles.some(d => d.producto_id === id && d.sin_stock)));
            if (movimientos.length > 0) {
                const consumidos = new Map<string, number>();
                for (const m of movimientos) {
                    if (m.delta >= 0 || m.valor_absoluto != null || (m.sucursal_id && venta.sucursal_id && m.sucursal_id !== venta.sucursal_id)) throw new Error('refund_stock_basis_unavailable');
                    consumidos.set(m.producto_id, (consumidos.get(m.producto_id) ?? 0) - m.delta);
                }
                if (consumidos.size !== stockVendidos.size || [...stockVendidos].some(([id, qty]) => consumidos.get(id) !== qty)) throw new Error('refund_stock_basis_unavailable');
            } else {
                // If local stock movements are absent (e.g. sale synced from another computer or older than retention),
                // simple products have an exact 1:1 stock basis from venta_detalles; combos still require historical recipe evidence.
                const prods = await database.productos.bulkGet([...stockVendidos.keys()]);
                if (prods.some(p => !p || p.tipo === 'combo')) throw new Error('refund_stock_basis_unavailable');
            }
            bases = [...vendidos].map(([productoId, cantidadVendida]) => ({ productoId, cantidadVendida,
                consumos: stockVendidos.has(productoId) ? [{ productoId, cantidad: cantidadVendida }] : [] }));
        }
        const recetas = new Map<string, string>();
        for (const base of bases) {
            if (!Number.isSafeInteger(base.cantidadVendida) || base.cantidadVendida <= 0) throw new Error('refund_stock_basis_unavailable');
            const unitarios = new Map<string, number>();
            if (!base.consumos.length && !detalles.some(d => d.producto_id === base.productoId && d.sin_stock)) throw new Error('refund_stock_basis_unavailable');
            for (const c of base.consumos) {
                normalizeInventoryInteger(c.cantidad);
                if (c.cantidad <= 0) throw new Error('refund_stock_basis_unavailable');
                unitarios.set(c.productoId, (unitarios.get(c.productoId) ?? 0) + c.cantidad / base.cantidadVendida);
            }
            const signature = commandHash([...unitarios].sort(([a], [b]) => a.localeCompare(b)));
            const qty = cantidades.get(base.productoId) ?? 0;
            if (qty > 0 && qty < vendidos.get(base.productoId)! && recetas.has(base.productoId) && recetas.get(base.productoId) !== signature) {
                throw new Error('refund_stock_basis_ambiguous');
            }
            recetas.set(base.productoId, signature);
        }
        const deltas = new Map<string, number>();
        for (const base of bases) {
            const qty = cantidades.get(base.productoId) ?? 0;
            if (qty <= 0) continue;
            const total = vendidos.get(base.productoId);
            if (!total || !Number.isInteger(qty)) throw new Error('refund_stock_basis_unavailable');
            for (const c of base.consumos) deltas.set(c.productoId, (deltas.get(c.productoId) ?? 0) + c.cantidad * qty / total);
        }
        if (!deltas.size && [...cantidades].some(([id, qty]) => qty > 0 && !detalles.some(d => d.producto_id === id && d.sin_stock))) throw new Error('refund_stock_basis_unavailable');
        for (const [id, delta] of deltas) {
            normalizeInventoryInteger(delta);
            const p = await database.productos.get(id);
            if (!p || p.negocio_id !== entrada.negocioId) throw new Error('producto_ambito_invalido');
            const projected = requireProductAtScope(p, { negocioId: entrada.negocioId, sucursalId: entrada.sucursalId ?? null });
            normalizeInventoryInteger(projected.stock_actual); normalizeInventoryInteger(projected.stock_actual + delta);
        }
        const returnedIds = new Set(previas.flatMap(d => d.serial_ids_devueltos ?? []));
        const seriales = efectos?.seriales.length ? await database.seriales.bulkGet(efectos.seriales.filter(s => !returnedIds.has(s.serialId)).map(s => s.serialId))
            : await database.seriales.where('negocio_id').equals(entrada.negocioId).filter(s => s.venta_id === venta.id).toArray();
        if (seriales.some(s => !s)) throw new Error('refund_serial_owner_invalid');
        const disponiblesSerial = seriales.filter((s): s is SerialLocal => !!s);
        const selected = new Set(entrada.serialIds ?? []);
        if (selected.size !== (entrada.serialIds?.length ?? 0) || [...selected].some(id => !disponiblesSerial.some(s => s.id === id))) throw new Error('refund_serial_owner_invalid');
        const liberar: SerialLocal[] = [];
        for (const [pid, qty] of cantidades) {
            if (qty <= 0) continue;
            const propios = disponiblesSerial.filter(s => s.producto_id === pid);
            if (!propios.length) {
                const p = await database.productos.get(pid);
                if (p?.serializable || efectos?.seriales.some(s => s.productoId === pid)) throw new Error('refund_serial_owner_invalid');
                continue;
            }
            const elegidos = entrada.serialIds ? propios.filter(s => selected.has(s.id)) : propios;
            if (elegidos.length !== qty) throw new Error('refund_serial_selection_required');
            for (const s of elegidos) {
                if (s.negocio_id !== entrada.negocioId || s.venta_id !== venta.id || s.estado !== 'vendido') throw new Error('refund_serial_owner_invalid');
                liberar.push(s);
            }
        }
        if (entrada.serialIds && liberar.length !== selected.size) throw new Error('refund_serial_owner_invalid');
        const turnos = (await database.cajas.where('negocio_id').equals(entrada.negocioId)
            .filter(c => c.estado === 'abierta' && (c.sucursal_id ?? null) === (entrada.sucursalId ?? null)).toArray())
            .sort((a, b) => (b.fecha_apertura || 0) - (a.fecha_apertura || 0));
        const turnoActivo = turnos[0] && entrada.fecha >= turnos[0].fecha_apertura ? turnos[0] : undefined;
        const devolucion: DevolucionLocal = { id: entrada.operationId, negocio_id: entrada.negocioId, venta_id: venta.id,
            sucursal_id: entrada.sucursalId, ...(turnoActivo ? { caja_id: turnoActivo.id } : {}),
            items_devueltos: [...cantidades].filter(([, qty]) => qty > 0).map(([id, qty]) => ({ producto_id: id,
                cantidad: qty, precio_unitario: detalles.find(d => d.producto_id === id)!.precio_unitario })),
            monto_devuelto: monto, razon: entrada.razon, fecha_creacion: entrada.fecha, estado_sincronizacion: 0,
            serial_ids_devueltos: liberar.map(s => s.id).sort() };
        const effectId = (suffix: string) => uuidv5(`${entrada.operationId}:${suffix}`, 'db162c3d-cdd3-4c54-a165-7be13f5f00b7');
        for (const [id, delta] of [...deltas].sort(([a], [b]) => a.localeCompare(b))) await registrarMovimientoStockEn(database,
            { negocioId: entrada.negocioId, sucursalId: entrada.sucursalId, originDeviceId: entrada.originDeviceId,
                now: entrada.fecha, operationId: effectId(id) }, { productoId: id, tipo: 'devolucion', delta, referenciaId: devolucion.id });
        for (const s of liberar) await database.seriales.update(s.id, { estado: 'disponible', venta_id: null,
            fecha_venta: null, garantia_dias: null, garantia_hasta: null, cliente_nombre: null, precio_venta: null,
            estado_sincronizacion: 0, fecha_actualizacion: entrada.fecha });
        if (venta.metodo_pago === 'fiado') {
            const cargo = await buscarCargoFiadoDeVenta(database, entrada.negocioId, venta.id);
            const clienteFiadoId = cargo?.cliente_id ?? venta.cliente_id;
            if (!clienteFiadoId || (cargo && venta.cliente_id && cargo.cliente_id !== venta.cliente_id)) throw new Error('refund_credit_basis_unavailable');
            // Ajuste comercial legacy de deuda, NO recepción de efectivo. No caja/método inventados.
            await database.transacciones_fiado.add({ id: effectId('fiado'), negocio_id: entrada.negocioId,
                sucursal_id: entrada.sucursalId, cliente_id: clienteFiadoId, venta_id: venta.id, tipo: 'abono',
                monto, concepto: `Devolución — ${entrada.razon}`, fecha_creacion: entrada.fecha,
                fecha_actualizacion: entrada.fecha, estado_sincronizacion: 0 });
        }
        await database.devoluciones.add(devolucion);
        await database.operaciones_locales.add({ id: journalId, negocio_id: entrada.negocioId, operation_id: entrada.operationId,
            tipo: 'REFUND', contract_version: 1, payload_hash: hash, estado_local: 'COMMITTED', estado_remoto: 'NOT_ENABLED',
            fecha_origen: entrada.fecha, resultado: devolucion });
        return { devolucion, reutilizada: false };
    });
}
