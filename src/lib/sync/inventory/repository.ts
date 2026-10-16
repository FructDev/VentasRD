import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { InventarioSyncCursorLocal, MovimientoStockLocal } from '@/types/database';
import type {
    ClassifiedInventoryError,
    InventoryScope,
    InventorySyncOperation,
    RemoteInventoryReceipt,
} from './contract';
import { initialInventorySyncState, validateExactReceipt } from './state-machine';
import { isInventoryInt4 } from './canonical-payload';

function hasV2CompatibleEffect(operation: Pick<InventorySyncOperation, 'delta' | 'valor_absoluto' | 'expected_remote_sequence'>): boolean {
    if (operation.valor_absoluto !== undefined) {
        return isInventoryInt4(operation.valor_absoluto)
            && operation.delta === 0
            && typeof operation.expected_remote_sequence === 'string';
    }
    return isInventoryInt4(operation.delta);
}

export function inventoryCursorId(scope: InventoryScope): string {
    return `${scope.negocioId}:${scope.sucursalId ?? 'GLOBAL'}:inventory-v2`;
}

function assertOperation(operation: InventorySyncOperation): void {
    if (!Number.isInteger(operation.attempt_count) || (operation.attempt_count ?? -1) < 0) {
        throw new Error('inventory_attempt_count_invalid');
    }
    if (operation.sync_state === 'APPLIED' && !operation.remote_receipt) {
        throw new Error('inventory_applied_receipt_required');
    }
    if (operation.sync_state === 'APPLIED'
        && operation.remote_receipt
        && !validateExactReceipt(operation, operation.remote_receipt).ok) {
        throw new Error('inventory_applied_receipt_mismatch');
    }
    if (operation.valor_absoluto !== undefined && !operation.expected_remote_sequence) {
        throw new Error('inventory_absolute_sequence_required');
    }
    if (operation.sync_protocol_version === 2 && !operation.payload_hash) {
        throw new Error('inventory_payload_hash_required');
    }
    if (operation.sync_protocol_version === 2 && !hasV2CompatibleEffect(operation)) {
        throw new Error('inventory_integer_invalid');
    }
}

export class InventoryOperationRepository {
    constructor(private readonly database: VentaRDDatabase,
        private readonly retryPolicy: { random?: () => number } = {}) {}

    async create(operation: InventorySyncOperation): Promise<InventorySyncOperation> {
        assertOperation(operation);
        return this.database.transaction('rw', this.database.movimientos_stock, async () => {
            const existing = await this.database.movimientos_stock.get(operation.id);
            if (existing) {
                if (existing.payload_hash === operation.payload_hash) return existing as InventorySyncOperation;
                throw new Error('inventory_operation_identity_conflict');
            }
            await this.database.movimientos_stock.add(operation as MovimientoStockLocal);
            return operation;
        });
    }

    async get(operationId: string): Promise<InventorySyncOperation | undefined> {
        return await this.database.movimientos_stock.get(operationId) as InventorySyncOperation | undefined;
    }

    async adoptLegacy(operationId: string, now: number): Promise<InventorySyncOperation | undefined> {
        return this.database.transaction('rw', this.database.movimientos_stock, async () => {
            const operation = await this.database.movimientos_stock.get(operationId);
            if (!operation) return undefined;
            if (operation.sync_state) return operation as InventorySyncOperation;
            const syncState = hasV2CompatibleEffect(operation)
                ? initialInventorySyncState(operation)
                : 'UNKNOWN_LEGACY';
            await this.database.movimientos_stock.update(operationId, {
                sync_state: syncState,
                sync_updated_at: now,
            });
            return { ...operation, sync_state: syncState, sync_updated_at: now } as InventorySyncOperation;
        });
    }

    async claimForExecution(
        operationId: string,
        now: number,
        leaseDurationMs: number = 30000,
    ): Promise<InventorySyncOperation | null> {
        return this.database.transaction('rw', this.database.movimientos_stock, async () => {
            const current = await this.database.movimientos_stock.get(operationId) as InventorySyncOperation | undefined;
            if (!current) throw new Error('inventory_operation_not_found');
            if (current.sync_state === 'APPLIED') return null;
            if (current.sync_protocol_version !== 2 || !current.payload_hash) return null;
            if (!['PENDING', 'RETRYABLE_ERROR', 'IN_FLIGHT'].includes(current.sync_state ?? '')) return null;
            if (current.last_outcome_code === 'AUTH_REQUIRED') return null;
            if ((current.attempt_count ?? 0) >= 10) {
                await this.database.movimientos_stock.put({ ...current, sync_state: 'INTERVENTION_REQUIRED',
                    estado_sincronizacion: 0, claim_id: undefined, lease_until: undefined, sync_updated_at: now });
                return null;
            }

            if (current.lease_until && current.lease_until > now) return null;
            if (current.next_attempt_at && current.next_attempt_at > now) return null;

            const next: InventorySyncOperation = {
                ...current,
                sync_state: 'IN_FLIGHT',
                estado_sincronizacion: 0,
                attempt_count: (current.attempt_count ?? 0) + 1,
                last_attempt_at: now,
                sync_updated_at: now,
                lease_until: now + leaseDurationMs,
                claim_id: crypto.randomUUID(),
            };
            assertOperation(next);
            await this.database.movimientos_stock.put(next);
            return next;
        });
    }

    async update(
        operationId: string,
        changes: Partial<MovimientoStockLocal>,
    ): Promise<InventorySyncOperation> {
        return this.database.transaction('rw', this.database.movimientos_stock, async () => {
            const current = await this.database.movimientos_stock.get(operationId);
            if (!current) throw new Error('inventory_operation_not_found');
            const next = { ...current, ...changes } as InventorySyncOperation;
            assertOperation(next);
            await this.database.movimientos_stock.put(next);
            return next;
        });
    }

    async applyReceipt(
        operationId: string,
        receipt: RemoteInventoryReceipt,
        now: number,
        claimId?: string,
    ): Promise<InventorySyncOperation> {
        return this.database.transaction('rw', this.database.movimientos_stock, async () => {
            const current = await this.database.movimientos_stock.get(operationId) as InventorySyncOperation | undefined;
            if (!current) throw new Error('inventory_operation_not_found');
            if (!validateExactReceipt(current, receipt).ok) throw new Error('inventory_receipt_mismatch');
            if (claimId !== undefined && (current.claim_id !== claimId || current.sync_state !== 'IN_FLIGHT')) return current;
            const next: InventorySyncOperation = {
                ...current,
                sync_state: 'APPLIED',
                estado_sincronizacion: 1,
                remote_receipt: receipt,
                sync_updated_at: now,
                claim_id: undefined,
                lease_until: undefined,
                next_attempt_at: undefined,
            };
            assertOperation(next);
            await this.database.movimientos_stock.put(next);
            return next;
        });
    }

    async recordFailure(
        operationId: string,
        failure: ClassifiedInventoryError,
        now: number,
        claimId?: string,
    ): Promise<InventorySyncOperation> {
        const syncState = failure.errorClass === 'CONFLICT'
            ? 'CONFLICT'
            : failure.errorClass === 'TEMPORARY' || (failure.errorClass === 'AUTH' && failure.code === 'AUTH_REQUIRED')
                ? 'RETRYABLE_ERROR'
                : failure.errorClass === 'LEGACY'
                    ? 'UNKNOWN_LEGACY'
                    : 'INTERVENTION_REQUIRED';

        return this.database.transaction('rw', this.database.movimientos_stock, async () => {
            const current = await this.database.movimientos_stock.get(operationId) as InventorySyncOperation | undefined;
            if (!current) throw new Error('inventory_operation_not_found');
            if (current.sync_state === 'APPLIED'
                || (claimId !== undefined && (current.claim_id !== claimId || current.sync_state !== 'IN_FLIGHT'))) return current;

            let nextAttemptAt: number | undefined = undefined;
            if (syncState === 'RETRYABLE_ERROR' && failure.code !== 'AUTH_REQUIRED') {
                const attempt = current.attempt_count ?? 1;
                const cap = Math.min(5000 * Math.pow(2, attempt - 1), 300000);
                const random = Math.min(1, Math.max(0, (this.retryPolicy.random ?? Math.random)()));
                const backoff = Math.floor(cap * random);
                nextAttemptAt = now + Math.max(backoff, failure.retryAfterMs ?? 0);
            }

            const next: InventorySyncOperation = {
                ...current,
                sync_state: syncState === 'RETRYABLE_ERROR' && (current.attempt_count ?? 0) >= 10
                    ? 'INTERVENTION_REQUIRED' : syncState,
                estado_sincronizacion: 0,
                last_outcome_code: failure.code,
                error_class: failure.errorClass,
                sync_updated_at: now,
                claim_id: undefined,
                lease_until: undefined,
                next_attempt_at: nextAttemptAt,
                ...(failure.errorClass === 'CONFLICT' && {
                    conflict: {
                        code: failure.code === 'STALE_ABSOLUTE_BASE'
                            ? 'STALE_ABSOLUTE_BASE'
                            : 'IDENTITY_PAYLOAD_MISMATCH',
                        detected_at: now,
                        next_action_code: 'REVIEW_INVENTORY_OPERATION',
                    },
                }),
            };
            assertOperation(next);
            await this.database.movimientos_stock.put(next);
            return next;
        });
    }

    /** Solo después de SIGNED_IN/TOKEN_REFRESHED, nunca en cada tick de red. */
    async resumeAfterAuthentication(negocioId: string, now: number): Promise<void> {
        await this.database.transaction('rw', this.database.movimientos_stock, async () => {
            await this.database.movimientos_stock.where('negocio_id').equals(negocioId)
                .filter(row => row.sync_state === 'RETRYABLE_ERROR' && row.last_outcome_code === 'AUTH_REQUIRED')
                .modify({ last_outcome_code: undefined, error_class: undefined, next_attempt_at: now, sync_updated_at: now });
        });
    }

    async getCursor(scope: InventoryScope): Promise<InventarioSyncCursorLocal | undefined> {
        return this.database.inventario_sync_cursors.get(inventoryCursorId(scope));
    }

    async advanceCursor(
        scope: InventoryScope,
        next: { lastRemoteSequence: string; lastOperationId?: string; updatedAt: number;
            deferredReceipts?: RemoteInventoryReceipt[]; latestReceipts?: RemoteInventoryReceipt[] },
    ): Promise<InventarioSyncCursorLocal> {
        const row: InventarioSyncCursorLocal = {
            id: inventoryCursorId(scope),
            negocio_id: scope.negocioId,
            sucursal_id: scope.sucursalId,
            last_remote_sequence: next.lastRemoteSequence,
            last_operation_id: next.lastOperationId,
            updated_at: next.updatedAt,
            ...(next.deferredReceipts !== undefined && { deferred_receipts: next.deferredReceipts }),
            ...(next.latestReceipts !== undefined && { latest_receipts: next.latestReceipts }),
        };
        await this.database.transaction('rw', this.database.inventario_sync_cursors, async () => {
            const current = await this.database.inventario_sync_cursors.get(row.id);
            if (current && BigInt(current.last_remote_sequence) > BigInt(row.last_remote_sequence)) {
                throw new Error('inventory_cursor_regression');
            }
            if (next.deferredReceipts === undefined && current?.deferred_receipts) row.deferred_receipts = current.deferred_receipts;
            if (next.latestReceipts === undefined && current?.latest_receipts) row.latest_receipts = current.latest_receipts;
            await this.database.inventario_sync_cursors.put(row);
        });
        return row;
    }
}
