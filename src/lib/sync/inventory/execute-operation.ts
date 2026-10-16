import { classifyInventoryError } from './classify-error';
import type { InventorySyncState } from './contract';
import { InventoryRemoteError, type InventoryApplyPort } from './remote-client';
import { InventoryOperationRepository } from './repository';

export interface ExecuteInventoryOperationInput {
    repository: InventoryOperationRepository;
    operationId: string;
    remote: InventoryApplyPort;
    now?: () => number;
    timeoutMs?: number;
}

async function applyWithTimeout<T>(request: () => Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([request(), new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new InventoryRemoteError('TIMEOUT', 'TEMPORARY')), milliseconds);
        })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function executeInventoryOperation({
    repository,
    operationId,
    remote,
    now = Date.now,
    timeoutMs = 8000,
}: ExecuteInventoryOperationInput): Promise<InventorySyncState> {
    const claimedAt = now();
    const claimed = await repository.claimForExecution(operationId, claimedAt);

    if (!claimed) {
        const op = await repository.get(operationId);
        if (!op) throw new Error('inventory_operation_not_found');
        if (op.sync_state === 'APPLIED') return 'APPLIED';
        if (op.sync_protocol_version !== 2 || !op.payload_hash) {
            return op.sync_state ?? 'UNKNOWN_LEGACY';
        }
        return op.sync_state ?? 'IN_FLIGHT'; // Return existing state if skipped
    }

    try {
        const receipt = await applyWithTimeout(() => remote.apply(claimed), timeoutMs);
        const persisted = await repository.applyReceipt(operationId, receipt, now(), claimed.claim_id);
        return persisted.sync_state!;
    } catch (error) {
        const failure = error instanceof InventoryRemoteError
            ? { errorClass: error.errorClass, code: error.code, retryable: error.retryable, retryAfterMs: error.retryAfterMs }
            : classifyInventoryError(error);
        const persisted = await repository.recordFailure(operationId, failure, now(), claimed.claim_id);
        return persisted.sync_state!;
    }
}

export async function executeInventoryBatch(input: {
    repository: InventoryOperationRepository;
    operationIds: string[];
    remote: InventoryApplyPort;
    now?: () => number;
}): Promise<{ applied: number; failed: number }> {
    const results: InventorySyncState[] = [];
    for (const operationId of input.operationIds) {
        try {
            results.push(await executeInventoryOperation({ ...input, operationId }));
        } catch {
            results.push('INTERVENTION_REQUIRED');
        }
    }
    const applied = results.filter(state => state === 'APPLIED').length;
    return { applied, failed: results.length - applied };
}
