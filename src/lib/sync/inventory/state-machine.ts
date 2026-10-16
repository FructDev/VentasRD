import type {
    InventorySyncOperation,
    InventorySyncState,
    RemoteInventoryReceipt,
} from './contract';
import { normalizeInventoryInteger } from './canonical-payload';

export type InventoryStateEvent =
    | { type: 'CLAIMED' }
    | { type: 'REMOTE_RECEIPT'; receipt: RemoteInventoryReceipt }
    | { type: 'TEMPORARY_FAILURE' }
    | { type: 'AUTH_REQUIRED' }
    | { type: 'PERMANENT_FAILURE' }
    | { type: 'CONFLICT_DETECTED' }
    | { type: 'LEASE_EXPIRED' };

export function initialInventorySyncState(
    operation: Pick<InventorySyncOperation, 'estado_sincronizacion' | 'sync_state'>,
): InventorySyncState {
    if (operation.sync_state) return operation.sync_state;
    return operation.estado_sincronizacion === 1 ? 'UNKNOWN_LEGACY' : 'PENDING';
}

export function validateExactReceipt(
    operation: Pick<InventorySyncOperation, 'id' | 'negocio_id' | 'sucursal_id' | 'producto_id' | 'payload_hash'>,
    receipt: RemoteInventoryReceipt,
): { ok: true } | { ok: false; code: 'IDENTITY_PAYLOAD_MISMATCH' } {
    let stockAfterIsInteger = false;
    try {
        stockAfterIsInteger = normalizeInventoryInteger(receipt.stockAfter) === receipt.stockAfter;
    } catch {
        stockAfterIsInteger = false;
    }
    const expectedAuthority = operation.sucursal_id === undefined ? 'GLOBAL' : 'BRANCH';
    const exact = receipt.contractVersion === '2.0'
        && (receipt.outcome === 'APPLIED' || receipt.outcome === 'ALREADY_APPLIED')
        && receipt.operationId === operation.id
        && receipt.negocioId === operation.negocio_id
        && receipt.productoId === operation.producto_id
        && receipt.sucursalId === (operation.sucursal_id ?? null)
        && receipt.authority === expectedAuthority
        && stockAfterIsInteger
        && typeof operation.payload_hash === 'string'
        && receipt.payloadHash === operation.payload_hash;
    return exact ? { ok: true } : { ok: false, code: 'IDENTITY_PAYLOAD_MISMATCH' };
}

export function transitionInventoryState(
    operation: InventorySyncOperation,
    event: InventoryStateEvent,
): InventorySyncState {
    const current = initialInventorySyncState(operation);
    if (event.type === 'REMOTE_RECEIPT') {
        if (current === 'APPLIED') {
            if (validateExactReceipt(operation, event.receipt).ok) return 'APPLIED';
            throw new Error('inventory_transition_forbidden:APPLIED:REMOTE_RECEIPT');
        }
        return validateExactReceipt(operation, event.receipt).ok ? 'APPLIED' : 'CONFLICT';
    }
    if (event.type === 'CONFLICT_DETECTED' && current !== 'APPLIED') return 'CONFLICT';
    if (current === 'PENDING' || current === 'RETRYABLE_ERROR') {
        if (event.type === 'CLAIMED') return 'IN_FLIGHT';
    }
    if (current === 'IN_FLIGHT') {
        if (event.type === 'TEMPORARY_FAILURE' || event.type === 'AUTH_REQUIRED' || event.type === 'LEASE_EXPIRED') {
            return 'RETRYABLE_ERROR';
        }
        if (event.type === 'PERMANENT_FAILURE') return 'INTERVENTION_REQUIRED';
    }
    throw new Error(`inventory_transition_forbidden:${current}:${event.type}`);
}
