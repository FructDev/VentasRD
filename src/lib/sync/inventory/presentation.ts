import type { InventorySyncOperation } from './contract';
import { validateExactReceipt } from './state-machine';

export type SyncPresentationEntity = Partial<Pick<InventorySyncOperation,
    'id' | 'negocio_id' | 'sucursal_id' | 'producto_id' | 'payload_hash' | 'remote_receipt' | 'sync_state' | 'estado_sincronizacion'>>;
export interface SyncPresentation {
    kind: 'LOCAL' | 'PENDING' | 'CONFIRMED' | 'ATTENTION' | 'UNKNOWN';
    label: string;
}
export function inventorySyncPresentation(entity: SyncPresentationEntity): SyncPresentation {
    if (['CONFLICT', 'INTERVENTION_REQUIRED'].includes(entity.sync_state ?? '')) {
        return { kind: 'ATTENTION', label: 'Requiere atención' };
    }
    if (entity.sync_state === 'APPLIED') {
        const receipt = entity.remote_receipt;
        if (receipt && entity.id && entity.negocio_id && entity.producto_id && entity.payload_hash
            && validateExactReceipt({ id: entity.id, negocio_id: entity.negocio_id, producto_id: entity.producto_id,
                sucursal_id: entity.sucursal_id, payload_hash: entity.payload_hash }, receipt).ok) {
            return { kind: 'CONFIRMED', label: 'Confirmado en servidor' };
        }
        return { kind: 'ATTENTION', label: 'Confirmación no verificable' };
    }
    if (entity.estado_sincronizacion === 1 || entity.sync_state === 'UNKNOWN_LEGACY') {
        return { kind: 'UNKNOWN', label: 'Confirmación no verificable' };
    }
    if (entity.sync_state === 'IN_FLIGHT' || entity.sync_state === 'RETRYABLE_ERROR') {
        return { kind: 'PENDING', label: 'Pendiente de enviar' };
    }
    return { kind: 'LOCAL', label: 'Guardado en esta PC' };
}
