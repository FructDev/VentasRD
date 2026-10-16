import type { InventoryScope } from './inventory/contract';
import { inventorySyncPresentation, type SyncPresentationEntity } from './inventory/presentation';

type QueueSale = { negocio_id: string; sucursal_id?: string; estado_sincronizacion?: 0 | 1 };
type QueueMovement = SyncPresentationEntity & { negocio_id: string; sync_protocol_version?: 2 };
export interface LocalQueueSummary {
    protocol?: 'SHARED_JOURNAL';
    scope: InventoryScope;
    salesPending: number;
    inventoryPending: number;
    attention: number;
    unknown: number;
    /** History with no provable branch: never assign it to the selected branch. */
    unscoped: number;
}

/** Pure counts, not a receipt for a complete sale, backend health or PC B. */
export function summarizeLocalQueues(scope: InventoryScope, sales: readonly QueueSale[], movements: readonly QueueMovement[]): LocalQueueSummary {
    const result: LocalQueueSummary = { scope: { ...scope }, salesPending: 0, inventoryPending: 0, attention: 0, unknown: 0, unscoped: 0 };
    for (const sale of sales) {
        if (sale.negocio_id !== scope.negocioId || sale.estado_sincronizacion !== 0) continue;
        if (sale.sucursal_id === undefined && scope.sucursalId !== null) result.unscoped++;
        else if ((sale.sucursal_id ?? null) === scope.sucursalId) result.salesPending++;
    }
    for (const movement of movements) {
        if (movement.negocio_id !== scope.negocioId) continue;
        if (movement.sucursal_id === undefined && movement.sync_protocol_version !== 2 && scope.sucursalId !== null) {
            result.unscoped++;
            continue;
        }
        if ((movement.sucursal_id ?? null) !== scope.sucursalId) continue;
        // State outranks a contradictory commercial flag: unresolved work stays visible.
        if (['PENDING', 'IN_FLIGHT', 'RETRYABLE_ERROR'].includes(movement.sync_state ?? '')) {
            result.inventoryPending++;
            continue;
        }
        const presentation = inventorySyncPresentation(movement);
        if (presentation.kind === 'ATTENTION') result.attention++;
        else if (presentation.kind === 'UNKNOWN') result.unknown++;
        else if (presentation.kind !== 'CONFIRMED') result.inventoryPending++;
    }
    return result;
}

/** navigator.onLine is only a browser signal, not a successful backend request. */
export function browserConnectivityLabel(online: boolean): 'Red disponible' | 'Sin red' {
    return online ? 'Red disponible' : 'Sin red';
}
