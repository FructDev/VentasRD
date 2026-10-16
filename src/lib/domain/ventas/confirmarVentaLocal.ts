import { v4 as uuidv4 } from 'uuid';
import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { ProductoLocal } from '@/types/database';
import { commandHash } from '@/lib/domain/local/command';
import { normalizeInventoryInteger } from '@/lib/sync/inventory/canonical-payload';
import { requireProductAtScope, withScopeStock } from '@/lib/sync/inventory/scope-stock';
import {
    construirEfectosVenta,
    type ConfirmarVentaEntrada,
    type CrearIdEfecto,
    type EfectosVentaLocal,
} from './contrato';

export interface ConfirmarVentaLocalEntrada extends Omit<ConfirmarVentaEntrada, 'numeroTicket'> {
    /** Respaldo del contador legado de Zustand durante la migración a v21. */
    ultimoTicketConocido?: number;
}

export interface ConfirmarVentaLocalResultado {
    efectos: EfectosVentaLocal;
    reutilizada: boolean;
}

interface DependenciasConfirmarVenta {
    crearId?: CrearIdEfecto;
}

function idSecuencia(negocioId: string, cajaCodigo: string): string {
    return `${negocioId}:${cajaCodigo}:ticket`;
}

async function calcularBaseLegada(
    database: VentaRDDatabase,
    entrada: ConfirmarVentaLocalEntrada,
): Promise<number> {
    const ventas = await database.ventas.where('negocio_id').equals(entrada.negocioId).toArray();
    const deCaja = ventas.filter(v => v.caja_codigo === entrada.cajaCodigo && v.numero_ticket != null);
    const maxCaja = deCaja.reduce((max, venta) => Math.max(max, venta.numero_ticket ?? 0), 0);

    // Primera venta de una caja nueva: conservar continuidad visual con el máximo
    // global, igual que el flujo legado. Después la secuencia es independiente.
    const maxGlobal = ventas.reduce((max, venta) => Math.max(max, venta.numero_ticket ?? 0), 0);
    return Math.max(maxCaja || maxGlobal, entrada.ultimoTicketConocido ?? 0);
}

/**
 * Confirma todos los efectos locales de una venta en una sola transacción Dexie.
 * No realiza red, impresión ni cambios de UI. Repetir operacionId es idempotente.
 */
export async function confirmarVentaLocal(
    database: VentaRDDatabase,
    entrada: ConfirmarVentaLocalEntrada,
    dependencias: DependenciasConfirmarVenta = {},
): Promise<ConfirmarVentaLocalResultado> {
    const crearId = dependencias.crearId ?? (() => uuidv4());
    // Copiar antes del primer await: el llamador no puede cambiar el contexto/items
    // mientras esperamos el lock. Contadores de respaldo son resultado, no intención.
    entrada = structuredClone(entrada);
    const { ultimoTicketConocido: _counter, ...command } = entrada;
    void _counter;
    const hash = commandHash({ kind: 'SALE', contractVersion: 1, ...command });
    const journalId = `${entrada.negocioId}:SALE:${entrada.operacionId}`;

    return database.transaction('rw', [
        database.ventas,
        database.venta_detalles,
        database.productos,
        database.transacciones_fiado,
        database.movimientos_stock,
        database.seriales,
        database.secuencias,
        database.operaciones_locales,
        database.cajas,
        database.clientes,
    ], async () => {
        const existente = await database.ventas.get(entrada.operacionId);
        if (existente) {
            const journal = await database.operaciones_locales.get(journalId);
            if (existente.negocio_id !== entrada.negocioId || journal && journal.payload_hash !== hash) {
                throw new Error(`operacion_id_conflicto:${entrada.operacionId}`);
            }
            if (!journal) throw new Error(`venta_legacy_replay_no_verificable:${entrada.operacionId}`);
            return { reutilizada: true, efectos: journal.resultado as EfectosVentaLocal };
        }

        const turnos = await database.cajas.where('negocio_id').equals(entrada.negocioId)
            .filter(c => c.estado === 'abierta' && (c.sucursal_id ?? null) === (entrada.sucursalId ?? null)).toArray();
        const tieneEfectivo = entrada.metodoPago === 'efectivo' || entrada.metodoPago === 'mixto';
        if (turnos.length > 1) throw new Error('turno_ambiguo');
        if ((tieneEfectivo || entrada.cajaId) && !turnos.length) throw new Error('turno_requerido');
        const turno = turnos[0];
        if (entrada.cajaId && turno?.id !== entrada.cajaId) throw new Error('turno_cambiado');
        if (turno && entrada.fecha < turno.fecha_apertura) throw new Error('turno_fecha_invalida');
        if (entrada.clienteId) {
            const cliente = await database.clientes.get(entrada.clienteId);
            if (!cliente || cliente.eliminado || cliente.negocio_id !== entrada.negocioId) throw new Error('cliente_ambito_invalido');
        }

        const secuenciaId = idSecuencia(entrada.negocioId, entrada.cajaCodigo);
        const secuencia = await database.secuencias.get(secuenciaId);
        const base = secuencia?.ultimo ?? await calcularBaseLegada(database, entrada);
        const numeroTicket = base + 1;
        const efectos = construirEfectosVenta({ ...entrada, cajaId: turno?.id, numeroTicket }, crearId);
        for (const item of entrada.items) {
            const product = await database.productos.get(item.productoId);
            if (item.sinStock) {
                if (product) throw new Error('venta_libre_producto_existente');
                continue;
            }
            if (!product || product.negocio_id !== entrada.negocioId || product.eliminado) throw new Error(`producto_ambito_invalido:${item.productoId}`);
            if (product.serializable && !item.serial) throw new Error(`serial_requerido:${item.productoId}`);
        }

        // Validar y acumular todos los deltas antes de escribir. Un combo puede
        // afectar el mismo insumo varias veces; se comprueba el total agregado.
        const deltas = new Map<string, number>();
        for (const movimiento of efectos.movimientosStock) {
            deltas.set(movimiento.producto_id, (deltas.get(movimiento.producto_id) ?? 0) + movimiento.delta);
        }
        const productos = await database.productos.bulkGet([...deltas.keys()]);
        const productosActualizados: ProductoLocal[] = [];
        [...deltas.entries()].forEach(([productoId, delta], indice) => {
            const producto = productos[indice];
            if (!producto) throw new Error(`producto_no_encontrado:${productoId}`);
            if (producto.negocio_id !== entrada.negocioId || producto.eliminado) throw new Error(`producto_ambito_invalido:${productoId}`);
            const stockScope = { negocioId: entrada.negocioId, sucursalId: entrada.sucursalId ?? null };
            const projected = requireProductAtScope(producto, stockScope);
            normalizeInventoryInteger(projected.stock_actual);
            const stockResultante = Number(normalizeInventoryInteger(projected.stock_actual + delta));
            if (stockResultante < 0) throw new Error(`stock_insuficiente:${productoId}`);
            productosActualizados.push({
                ...withScopeStock(producto, stockScope, stockResultante),
                stock_actual: stockResultante,
                fecha_actualizacion: entrada.fecha,
            });
        });

        for (const actualizacion of efectos.seriales) {
            const serial = await database.seriales.get(actualizacion.serialId);
            if (!serial) throw new Error(`serial_no_encontrado:${actualizacion.serialId}`);
            if (serial.negocio_id !== entrada.negocioId) throw new Error(`serial_ambito_invalido:${actualizacion.serialId}`);
            if (serial.numero_serial !== actualizacion.numeroSerial) throw new Error(`serial_numero_invalido:${actualizacion.serialId}`);
            if (serial.producto_id !== actualizacion.productoId) throw new Error(`serial_producto_invalido:${actualizacion.serialId}`);
            if (serial.estado !== 'disponible') throw new Error(`serial_no_disponible:${actualizacion.serialId}`);
        }

        await database.ventas.add(efectos.venta);
        await database.venta_detalles.bulkAdd(efectos.detalles);
        if (efectos.cargoFiado) await database.transacciones_fiado.add(efectos.cargoFiado);
        await database.movimientos_stock.bulkAdd(efectos.movimientosStock);
        await database.productos.bulkPut(productosActualizados);
        for (const actualizacion of efectos.seriales) {
            await database.seriales.update(actualizacion.serialId, {
                estado: 'vendido',
                venta_id: actualizacion.ventaId,
                fecha_venta: actualizacion.fechaVenta,
                garantia_dias: actualizacion.garantiaDias,
                garantia_hasta: actualizacion.garantiaHasta,
                cliente_nombre: actualizacion.clienteNombre,
                precio_venta: actualizacion.precioVenta,
                estado_sincronizacion: 0,
                fecha_actualizacion: entrada.fecha,
            });
        }
        await database.secuencias.put({
            id: secuenciaId,
            negocio_id: entrada.negocioId,
            caja_codigo: entrada.cajaCodigo,
            tipo: 'ticket',
            ultimo: numeroTicket,
            fecha_actualizacion: entrada.fecha,
        });
        await database.operaciones_locales.add({
            id: journalId, negocio_id: entrada.negocioId, operation_id: entrada.operacionId,
            tipo: 'SALE', contract_version: 1, payload_hash: hash, estado_local: 'COMMITTED',
            estado_remoto: 'NOT_ENABLED', fecha_origen: entrada.fecha, resultado: efectos,
        });

        return { efectos, reutilizada: false };
    });
}
