// src/lib/db/stock.ts
// ÚNICO punto de escritura de stock. Toda modificación de inventario debe pasar
// por aquí: actualiza el stock local al instante (UI responsiva) y registra el
// movimiento que el worker sube como delta atómico — así dos cajas vendiendo a
// la vez nunca se pisan el stock.
import { db, type VentaRDDatabase } from './dexie';
import { getDispositivoId, useConfigStore } from '@/store/useConfigStore';
import { MovimientoStockLocal } from '@/types/database';
import { v4 as uuidv4 } from 'uuid';
import { createInventoryOperation } from '@/lib/sync/inventory/operation-factory';
import { normalizeInventoryInteger } from '@/lib/sync/inventory/canonical-payload';
import { inventoryScopeKey, requireProductAtScope, withScopeStock } from '@/lib/sync/inventory/scope-stock';

export interface RegistrarMovimientoParams {
    productoId: string;
    tipo: MovimientoStockLocal['tipo'];
    /** Cambio relativo: negativo = salida, positivo = entrada */
    delta?: number;
    /** Solo para conteos físicos: establece el stock exacto (ignora delta) */
    valorAbsoluto?: number;
    /** venta_id / devolucion_id que originó el movimiento */
    referenciaId?: string;
    /** Base remota conocida, obligatoria para un conteo v2 enviable. */
    expectedRemoteSequence?: string;
    /** Dependencias ya resueltas por un flujo transaccional superior. */
    operationId?: string;
    originDeviceId?: string;
    now?: number;
}

export interface RegistrarMovimientoContext {
    negocioId: string;
    sucursalId?: string | null;
    originDeviceId: string;
    now: number;
    operationId: string;
}

function createLegacyAbsoluteWithoutBase(
    context: RegistrarMovimientoContext,
    params: RegistrarMovimientoParams,
): MovimientoStockLocal {
    return {
        id: context.operationId,
        negocio_id: context.negocioId,
        sucursal_id: context.sucursalId ?? undefined,
        producto_id: params.productoId,
        delta: 0,
        valor_absoluto: params.valorAbsoluto!,
        tipo: params.tipo,
        referencia_id: params.referenciaId,
        fecha_creacion: context.now,
        estado_sincronizacion: 0,
        // No se fabrica una base remota. El worker legacy mantiene su conducta;
        // el motor v2 verá evidencia insuficiente en lugar de un hash falso.
        sync_state: 'UNKNOWN_LEGACY',
        sync_updated_at: context.now,
    };
}

/** Variante inyectable usada por pruebas y por transacciones llamantes. */
export async function registrarMovimientoStockEn(
    database: VentaRDDatabase,
    context: RegistrarMovimientoContext,
    params: RegistrarMovimientoParams,
): Promise<MovimientoStockLocal> {
    return database.transaction('rw', [database.productos, database.movimientos_stock], async () => {
        const movimiento = params.valorAbsoluto !== undefined && !params.expectedRemoteSequence
            ? createLegacyAbsoluteWithoutBase(context, params)
            : createInventoryOperation({
                operationId: context.operationId,
                negocioId: context.negocioId,
                sucursalId: context.sucursalId,
                productoId: params.productoId,
                tipo: params.tipo,
                ...(params.valorAbsoluto !== undefined
                    ? { valorAbsoluto: params.valorAbsoluto }
                    : { delta: params.delta ?? 0 }),
                referenciaId: params.referenciaId ?? null,
                fechaOrigen: context.now,
                originDeviceId: context.originDeviceId,
                expectedRemoteSequence: params.expectedRemoteSequence ?? null,
            });

        const existing = await database.movimientos_stock.get(context.operationId);
        if (existing) {
            if (existing.payload_hash && movimiento.payload_hash === existing.payload_hash) return existing;
            throw new Error('inventory_operation_identity_conflict');
        }

        const producto = await database.productos.get(params.productoId);
        if (!producto) throw new Error(`producto_no_encontrado:${params.productoId}`);
        const scope = { negocioId: context.negocioId, sucursalId: context.sucursalId ?? null };
        const projected = requireProductAtScope(producto, scope);
        const isLegacyAbsolute = params.valorAbsoluto !== undefined && !params.expectedRemoteSequence;
        const nuevoStock = isLegacyAbsolute
            ? params.valorAbsoluto!
            : Number(normalizeInventoryInteger(params.valorAbsoluto !== undefined
                ? params.valorAbsoluto
                : projected.stock_actual + (params.delta ?? 0)));

        const scoped = isLegacyAbsolute && !Number.isSafeInteger(nuevoStock)
            ? { ...producto, stock_actual: nuevoStock, inventory_stock_by_scope: producto.inventory_stock_by_scope
                ? Object.fromEntries(Object.entries(producto.inventory_stock_by_scope).filter(([key]) => key !== inventoryScopeKey(scope))) : undefined }
            : withScopeStock(producto, scope, nuevoStock);
        await database.productos.update(params.productoId, {
            ...scoped,
            stock_actual: nuevoStock,
            fecha_actualizacion: context.now,
            inventory_sync_protocol_version: movimiento.sync_protocol_version,
            inventory_last_local_operation_id: movimiento.id,
        });
        await database.movimientos_stock.add(movimiento);
        return movimiento;
    });
}

/**
 * Registra un movimiento de stock y actualiza el producto local.
 * Debe llamarse dentro de una transacción Dexie que incluya
 * db.productos y db.movimientos_stock, o fuera de toda transacción.
 */
export async function registrarMovimientoStock(params: RegistrarMovimientoParams): Promise<void> {
    const { negocioId, sucursalId } = useConfigStore.getState();
    if (!negocioId) return;
    await registrarMovimientoStockEn(db, {
        negocioId,
        sucursalId,
        originDeviceId: params.originDeviceId ?? getDispositivoId(),
        now: params.now ?? Date.now(),
        operationId: params.operationId ?? uuidv4(),
    }, params);
}

/** IDs de productos con movimientos aún no sincronizados (el pull no debe pisarlos) */
export async function productosConMovimientosPendientes(): Promise<Set<string>> {
    const pendientes = await db.movimientos_stock
        .where('estado_sincronizacion').equals(0)
        .toArray();
    return new Set(pendientes.map(m => m.producto_id));
}
