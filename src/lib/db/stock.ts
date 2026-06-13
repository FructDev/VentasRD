// src/lib/db/stock.ts
// ÚNICO punto de escritura de stock. Toda modificación de inventario debe pasar
// por aquí: actualiza el stock local al instante (UI responsiva) y registra el
// movimiento que el worker sube como delta atómico — así dos cajas vendiendo a
// la vez nunca se pisan el stock.
import { db } from './dexie';
import { useConfigStore } from '@/store/useConfigStore';
import { MovimientoStockLocal } from '@/types/database';
import { v4 as uuidv4 } from 'uuid';

interface RegistrarMovimientoParams {
    productoId: string;
    tipo: MovimientoStockLocal['tipo'];
    /** Cambio relativo: negativo = salida, positivo = entrada */
    delta?: number;
    /** Solo para conteos físicos: establece el stock exacto (ignora delta) */
    valorAbsoluto?: number;
    /** venta_id / devolucion_id que originó el movimiento */
    referenciaId?: string;
}

/**
 * Registra un movimiento de stock y actualiza el producto local.
 * Debe llamarse dentro de una transacción Dexie que incluya
 * db.productos y db.movimientos_stock, o fuera de toda transacción.
 */
export async function registrarMovimientoStock(params: RegistrarMovimientoParams): Promise<void> {
    const { negocioId, sucursalId } = useConfigStore.getState();
    if (!negocioId) return;

    const producto = await db.productos.get(params.productoId);
    if (!producto) return;

    const ahora = Date.now();

    // Stock local resultante
    const nuevoStock = params.valorAbsoluto !== undefined
        ? params.valorAbsoluto
        : parseFloat((producto.stock_actual + (params.delta ?? 0)).toFixed(3));

    // Nota: NO marcamos el producto con estado_sincronizacion=0 — el stock ya no
    // viaja en el upsert de productos; viaja como movimiento atómico.
    await db.productos.update(params.productoId, {
        stock_actual: nuevoStock,
        fecha_actualizacion: ahora,
    });

    await db.movimientos_stock.add({
        id: uuidv4(),
        negocio_id: negocioId,
        sucursal_id: sucursalId || undefined,
        producto_id: params.productoId,
        delta: params.valorAbsoluto !== undefined ? 0 : (params.delta ?? 0),
        ...(params.valorAbsoluto !== undefined && { valor_absoluto: params.valorAbsoluto }),
        tipo: params.tipo,
        referencia_id: params.referenciaId,
        fecha_creacion: ahora,
        estado_sincronizacion: 0,
    });
}

/** IDs de productos con movimientos aún no sincronizados (el pull no debe pisarlos) */
export async function productosConMovimientosPendientes(): Promise<Set<string>> {
    const pendientes = await db.movimientos_stock
        .where('estado_sincronizacion').equals(0)
        .toArray();
    return new Set(pendientes.map(m => m.producto_id));
}
