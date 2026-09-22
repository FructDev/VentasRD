import { v4 as uuidv4 } from 'uuid';
import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { ProductoLocal } from '@/types/database';
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

function reconstruirResultadoExistente(
    entrada: ConfirmarVentaLocalEntrada,
    venta: EfectosVentaLocal['venta'],
    detalles: EfectosVentaLocal['detalles'],
    movimientosStock: EfectosVentaLocal['movimientosStock'],
    cargoFiado: EfectosVentaLocal['cargoFiado'],
    seriales: EfectosVentaLocal['seriales'],
): EfectosVentaLocal {
    return {
        venta,
        detalles,
        movimientosStock,
        cargoFiado,
        seriales,
        impactoCaja: {
            efectivo: venta.metodo_pago === 'efectivo' ? venta.total : venta.metodo_pago === 'mixto' ? (venta.monto_efectivo ?? 0) : 0,
            tarjeta: venta.metodo_pago === 'tarjeta' ? venta.total : 0,
            transferencia: venta.metodo_pago === 'transferencia' ? venta.total : venta.metodo_pago === 'mixto' ? (venta.monto_transferencia ?? 0) : 0,
            fiado: venta.metodo_pago === 'fiado' ? venta.total : 0,
        },
        secuencia: {
            cajaCodigo: venta.caja_codigo ?? entrada.cajaCodigo,
            numeroTicket: venta.numero_ticket!,
            ncf: venta.ncf,
        },
    };
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

    return database.transaction('rw', [
        database.ventas,
        database.venta_detalles,
        database.productos,
        database.transacciones_fiado,
        database.movimientos_stock,
        database.seriales,
        database.secuencias,
    ], async () => {
        const existente = await database.ventas.get(entrada.operacionId);
        if (existente) {
            if (
                existente.negocio_id !== entrada.negocioId
                || existente.caja_codigo !== entrada.cajaCodigo
                || existente.metodo_pago !== entrada.metodoPago
                || Math.abs(existente.total - entrada.total) > 0.01
            ) {
                throw new Error(`operacion_id_conflicto:${entrada.operacionId}`);
            }

            const [detalles, movimientos, cargos, serialesVendidos] = await Promise.all([
                database.venta_detalles.where('venta_id').equals(entrada.operacionId).toArray(),
                database.movimientos_stock.where('negocio_id').equals(entrada.negocioId)
                    .filter(m => m.referencia_id === entrada.operacionId).toArray(),
                database.transacciones_fiado.where('negocio_id').equals(entrada.negocioId)
                    .filter(t => t.venta_id === entrada.operacionId).toArray(),
                database.seriales.where('negocio_id').equals(entrada.negocioId)
                    .filter(s => s.venta_id === entrada.operacionId).toArray(),
            ]);
            return {
                reutilizada: true,
                efectos: reconstruirResultadoExistente(
                    entrada,
                    existente,
                    detalles,
                    movimientos,
                    cargos[0] ?? null,
                    serialesVendidos.map(s => ({
                        serialId: s.id,
                        productoId: s.producto_id,
                        numeroSerial: s.numero_serial,
                        ventaId: entrada.operacionId,
                        fechaVenta: s.fecha_venta ?? existente.fecha_creacion,
                        garantiaDias: s.garantia_dias ?? 0,
                        garantiaHasta: s.garantia_hasta ?? null,
                        clienteNombre: s.cliente_nombre ?? null,
                        precioVenta: s.precio_venta ?? 0,
                    })),
                ),
            };
        }

        const secuenciaId = idSecuencia(entrada.negocioId, entrada.cajaCodigo);
        const secuencia = await database.secuencias.get(secuenciaId);
        const base = secuencia?.ultimo ?? await calcularBaseLegada(database, entrada);
        const numeroTicket = base + 1;
        const efectos = construirEfectosVenta({ ...entrada, numeroTicket }, crearId);

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
            const stockResultante = parseFloat((producto.stock_actual + delta).toFixed(3));
            if (stockResultante < 0) throw new Error(`stock_insuficiente:${productoId}`);
            productosActualizados.push({
                ...producto,
                stock_actual: stockResultante,
                fecha_actualizacion: entrada.fecha,
            });
        });

        for (const actualizacion of efectos.seriales) {
            const serial = await database.seriales.get(actualizacion.serialId);
            if (!serial) throw new Error(`serial_no_encontrado:${actualizacion.serialId}`);
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

        return { efectos, reutilizada: false };
    });
}
