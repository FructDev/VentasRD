import type { MovimientoStockLocal } from '@/types/database';
import type { InventoryApplyPort } from './remote-client';
import { executeInventoryOperation } from './execute-operation';
import { resolverResultadoRpcLegacy } from './legacy-worker-policy';
import { InventoryOperationRepository } from './repository';
import type { InventorySyncOperation, InventorySyncState, InventoryRolloutMode } from './contract';
import type { LegacyWorkerPatch } from './legacy-worker-policy';

interface LegacyRpcError {
    code?: string | null;
}

export interface InventoryOutboxResult {
    applied: number;
    pending: number;
    skipped: number;
    states: Map<string, InventorySyncState>;
}

function authorityKey(operation: MovimientoStockLocal): string {
    return `${operation.negocio_id}:${operation.sucursal_id ?? 'GLOBAL'}:${operation.producto_id}`;
}

function isV2(operation: MovimientoStockLocal): boolean {
    return operation.sync_protocol_version === 2 && typeof operation.payload_hash === 'string';
}

/**
 * Frontera única entre el outbox local y los transportes remoto v1/v2.
 * Una operación v2 nunca puede caer al RPC legacy: si falla permanece visible.
 */
export async function procesarColaInventario(input: {
    operations: MovimientoStockLocal[];
    repository: InventoryOperationRepository;
    remote: InventoryApplyPort;
    mode?: InventoryRolloutMode;
    applyLegacy: (operation: MovimientoStockLocal) => Promise<LegacyRpcError | null>;
    persistLegacyPatch?: (operationId: string, patch: LegacyWorkerPatch & { sync_updated_at: number }) => Promise<void>;
    now?: () => number;
}): Promise<InventoryOutboxResult> {
    const states = new Map<string, InventorySyncState>();
    if (input.mode === 'PAUSED' || input.mode === 'SHADOW') {
        input.operations.forEach(operation => states.set(operation.id, operation.sync_state ?? 'UNKNOWN_LEGACY'));
        return { applied: 0, pending: 0, skipped: input.operations.length, states };
    }
    const blocked = new Set<string>();
    let applied = 0;
    let pending = 0;
    let skipped = 0;

    const operations = [...input.operations]
        .sort((a, b) => a.fecha_creacion - b.fecha_creacion || a.id.localeCompare(b.id));

    for (const operation of operations) {
        const key = authorityKey(operation);
        if (operation.sync_state === 'INTERVENTION_REQUIRED' || operation.sync_state === 'CONFLICT') {
            blocked.add(key);
            states.set(operation.id, operation.sync_state);
            skipped++;
            continue;
        }
        if (blocked.has(key)) {
            states.set(operation.id, operation.sync_state ?? 'PENDING');
            skipped++;
            continue;
        }

        if (isV2(operation)) {
            const operationV2 = operation as InventorySyncOperation;
            const state = await executeInventoryOperation({
                repository: input.repository,
                operationId: operationV2.id,
                remote: input.remote,
                now: input.now,
            });
            states.set(operationV2.id, state);
            if (state === 'APPLIED') {
                applied++;
            } else {
                pending++;
                blocked.add(key);
            }
            continue;
        }

        const error = await input.applyLegacy(operation);
        const decision = resolverResultadoRpcLegacy(error);
        if (!input.persistLegacyPatch) throw new Error('legacy_patch_persistence_required');
        const patch = {
            ...decision.patch,
            sync_updated_at: (input.now ?? Date.now)(),
        };
        await input.persistLegacyPatch(operation.id, patch);
        states.set(operation.id, patch.sync_state);
        if (patch.estado_sincronizacion === 1) applied++;
        else pending++;
        if (decision.bloquearProducto) blocked.add(key);
        if (!decision.continuarConOtrosProductos) break;
    }

    return { applied, pending, skipped, states };
}
