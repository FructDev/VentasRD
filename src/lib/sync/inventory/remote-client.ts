import type {
    InventoryErrorClass,
    InventoryOperationPayload,
    InventoryOutcomeCode,
    InventorySyncOperation,
    RemoteInventoryReceipt,
    InventoryFeedPage,
    InventoryScope,
} from './contract';
import { INVENTORY_OUTCOME_CODES, INVENTORY_WARNING_CODES } from './contract';
import { classifyInventoryError } from './classify-error';
import { normalizeInventoryInteger, normalizeInventoryPayload } from './canonical-payload';
import { inventoryPayloadFromOperation } from './operation-factory';
import { validateExactReceipt } from './state-machine';

interface RpcResult { data: unknown; error: unknown; status?: number; retryAfterMs?: number }
interface InventorySupabaseClient {
    rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
    from?: (table: string) => unknown;
}

interface ReceiptQuery {
    select(columns: string): ReceiptQuery;
    eq(column: string, value: string): ReceiptQuery;
    maybeSingle(): PromiseLike<RpcResult>;
}

function receiptFromLedgerRow(value: unknown): RemoteInventoryReceipt {
    if (typeof value !== 'object' || value === null) {
        throw new InventoryRemoteError('REMOTE_RESPONSE_INVALID', 'PERMANENT');
    }
    const row = value as Record<string, unknown>;
    return parseReceipt({
        contractVersion: row.payload_version === 2 ? '2.0' : row.contractVersion,
        outcome: 'ALREADY_APPLIED',
        operationId: row.operacion_id,
        negocioId: row.negocio_id,
        productoId: row.producto_id,
        sucursalId: row.sucursal_id ?? null,
        payloadHash: row.payload_hash,
        authority: row.authority_kind,
        stockAfter: row.stock_after === undefined ? undefined : String(row.stock_after),
        remoteSequence: row.remote_sequence === undefined ? undefined : String(row.remote_sequence),
        appliedAt: row.applied_at,
        warningCodes: row.warning_codes ?? [],
    });
}

export class InventoryRemoteError extends Error {
    readonly retryable: boolean;

    constructor(
        readonly code: InventoryOutcomeCode,
        readonly errorClass: InventoryErrorClass,
        retryable = errorClass === 'TEMPORARY',
        readonly retryAfterMs?: number,
    ) {
        super(code);
        this.name = 'InventoryRemoteError';
        this.retryable = retryable;
    }
}

function parseReceipt(value: unknown): RemoteInventoryReceipt {
    if (typeof value !== 'object' || value === null) throw new InventoryRemoteError('REMOTE_RESPONSE_INVALID', 'PERMANENT');
    const row = value as Record<string, unknown>;
    const requiredStrings = [
        'operationId', 'negocioId', 'productoId', 'payloadHash',
        'authority', 'stockAfter', 'remoteSequence', 'appliedAt',
    ];
    if (row.contractVersion !== '2.0'
        || (row.outcome !== 'APPLIED' && row.outcome !== 'ALREADY_APPLIED')
        || requiredStrings.some(key => typeof row[key] !== 'string')
        || (row.sucursalId !== null && typeof row.sucursalId !== 'string')
        || !Array.isArray(row.warningCodes)
        || row.warningCodes.some(code => !INVENTORY_WARNING_CODES.includes(code as never))) {
        throw new InventoryRemoteError('REMOTE_RESPONSE_INVALID', 'PERMANENT');
    }
    try {
        if (normalizeInventoryInteger(row.stockAfter as string) !== row.stockAfter
            || (row.authority !== 'BRANCH' && row.authority !== 'GLOBAL')) {
            throw new Error('inventory_receipt_integer_or_authority_invalid');
        }
    } catch {
        throw new InventoryRemoteError('REMOTE_RESPONSE_INVALID', 'PERMANENT');
    }
    if (!isSequence(row.remoteSequence) || !/^[a-f0-9]{64}$/.test(row.payloadHash as string)
        || !Number.isFinite(Date.parse(row.appliedAt as string))
        || row.authority !== (row.sucursalId === null ? 'GLOBAL' : 'BRANCH')) {
        throw new InventoryRemoteError('REMOTE_RESPONSE_INVALID', 'PERMANENT');
    }
    return row as unknown as RemoteInventoryReceipt;
}

function asRemoteError(error: unknown): InventoryRemoteError {
    if (error instanceof InventoryRemoteError) return error;
    const classified = classifyInventoryError(error);
    return new InventoryRemoteError(classified.code, classified.errorClass, classified.retryable, classified.retryAfterMs);
}

function throwIfRejected(value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    const row = value as Record<string, unknown>;
    if (row.outcome !== 'REJECTED') return;
    const code = typeof row.code === 'string' && INVENTORY_OUTCOME_CODES.includes(row.code as never)
        ? row.code as InventoryOutcomeCode
        : 'REMOTE_RESPONSE_INVALID';
    const classified = classifyInventoryError({ code });
    throw new InventoryRemoteError(classified.code, classified.errorClass, classified.retryable);
}

export interface InventoryApplyPort {
    apply(operation: InventorySyncOperation): Promise<RemoteInventoryReceipt>;
}

export interface InventoryFeedPort {
    readFeed(
        scope: { negocioId: string; sucursalId: string | null },
        afterSequence?: string,
        afterOperationId?: string | null,
        limit?: number
    ): Promise<import('./contract').InventoryFeedPage>;
}

export interface InventoryRemotePort extends InventoryApplyPort, InventoryFeedPort {}

function isSequence(value: unknown): value is string {
    return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
        && BigInt(value) <= BigInt('9223372036854775807');
}

/** Validate the entire page before a single local write, including injected ports. */
export function parseInventoryFeedPage(value: unknown, scope: InventoryScope,
    afterSequence = '0', afterOperationId: string | null = null, limit = 200): InventoryFeedPage {
    const invalid = () => { throw new InventoryRemoteError('REMOTE_RESPONSE_INVALID', 'PERMANENT'); };
    if (!isSequence(afterSequence) || !Number.isInteger(limit) || limit < 1 || limit > 200) invalid();
    if (typeof value !== 'object' || value === null) return invalid();
    const row = value as Record<string, unknown>;
    const pageScope = row.scope as InventoryFeedPage['scope'] | undefined;
    const cursor = row.cursor as InventoryFeedPage['cursor'] | undefined;
    if (row.contractVersion !== '2.0' || !pageScope || !cursor
        || pageScope.negocioId !== scope.negocioId || pageScope.sucursalId !== scope.sucursalId
        || pageScope.authority !== (scope.sucursalId === null ? 'GLOBAL' : 'BRANCH')
        || !isSequence(row.watermark) || !isSequence(cursor.remoteSequence)
        || (cursor.operationId !== null && typeof cursor.operationId !== 'string')
        || typeof row.hasMore !== 'boolean' || !Array.isArray(row.items)
        || row.items.length > limit || BigInt(row.watermark) < BigInt(afterSequence)) return invalid();
    const items = row.items.map(parseReceipt);
    let previousSequence = afterSequence, previousId = afterOperationId;
    for (const item of items) {
        if (item.negocioId !== scope.negocioId || item.sucursalId !== scope.sucursalId
            || item.authority !== pageScope.authority || BigInt(item.remoteSequence) > BigInt(row.watermark)
            || BigInt(item.remoteSequence) < BigInt(previousSequence)
            || (item.remoteSequence === previousSequence && (!previousId || item.operationId <= previousId))) return invalid();
        previousSequence = item.remoteSequence; previousId = item.operationId;
    }
    if (cursor.remoteSequence !== previousSequence || cursor.operationId !== previousId
        || (row.hasMore && items.length !== limit)) return invalid();
    return { contractVersion: '2.0', scope: { ...pageScope }, items, hasMore: row.hasMore,
        watermark: row.watermark, cursor: { ...cursor } };
}

export class InventoryRemoteClient implements InventoryRemotePort {
    /** Recibe el cliente Supabase autenticado del usuario; nunca crea service_role. */
    constructor(private readonly client: InventorySupabaseClient) {}

    private async request(name: string, args: Record<string, unknown>): Promise<RpcResult> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([Promise.resolve(this.client.rpc(name, args)), new Promise<RpcResult>((_, reject) => {
                timer = setTimeout(() => reject(new InventoryRemoteError('TIMEOUT', 'TEMPORARY')), 8000);
            })]);
            if (result.error) {
                const error = typeof result.error === 'object' && result.error !== null ? result.error : {};
                throw asRemoteError({ ...error,
                    ...(result.status !== undefined && { status: result.status }),
                    ...(result.retryAfterMs !== undefined && { retryAfterMs: result.retryAfterMs }) });
            }
            return result;
        } finally { if (timer !== undefined) clearTimeout(timer); }
    }

    async apply(operation: InventorySyncOperation): Promise<RemoteInventoryReceipt> {
        if (!operation.payload_hash || !operation.origin_device_id) {
            throw new InventoryRemoteError('REMOTE_RESPONSE_INVALID', 'PERMANENT');
        }
        let payload: InventoryOperationPayload;
        try {
            payload = normalizeInventoryPayload(inventoryPayloadFromOperation(operation));
        } catch {
            throw new InventoryRemoteError('INVALID_EFFECT', 'PERMANENT');
        }
        let result: RpcResult;
        try {
            result = await this.request('aplicar_movimiento_stock_v2', {
                p_contract_version: 2,
                p_operation_id: payload.operationId,
                p_negocio_id: payload.negocioId,
                p_sucursal_id: payload.sucursalId,
                p_producto_id: payload.productoId,
                p_effect_kind: payload.effect.kind,
                p_effect_value: payload.effect.value,
                p_tipo: payload.tipo,
                p_referencia_id: payload.referenciaId,
                p_fecha_origen: payload.fechaOrigen,
                p_expected_remote_sequence: payload.expectedRemoteSequence,
                p_payload_hash: operation.payload_hash,
                p_origin_device_id: operation.origin_device_id,
            });
        } catch (error) {
            throw asRemoteError(error);
        }
        if (result.error) throw asRemoteError(result.error);
        const response = Array.isArray(result.data) ? result.data[0] : result.data;
        throwIfRejected(response);
        const receipt = parseReceipt(response);
        if (!validateExactReceipt(operation, receipt).ok) {
            throw new InventoryRemoteError('IDENTITY_PAYLOAD_MISMATCH', 'CONFLICT');
        }
        return receipt;
    }

    async findReceipt(operation: InventorySyncOperation): Promise<RemoteInventoryReceipt | null> {
        if (!this.client.from) throw new InventoryRemoteError('REMOTE_RESPONSE_INVALID', 'PERMANENT');
        try {
            let query = this.client.from('inventario_operaciones_v2') as ReceiptQuery;
            query = query.select('payload_version,operacion_id,negocio_id,producto_id,sucursal_id,payload_hash,authority_kind,stock_after,remote_sequence,applied_at,warning_codes')
                .eq('negocio_id', operation.negocio_id)
                .eq('operacion_id', operation.id);
            const result = await query.maybeSingle();
            if (result.error) throw result.error;
            if (result.data === null) return null;
            const receipt = receiptFromLedgerRow(result.data);
            if (!validateExactReceipt(operation, receipt).ok) {
                throw new InventoryRemoteError('IDENTITY_PAYLOAD_MISMATCH', 'CONFLICT');
            }
            return receipt;
        } catch (error) {
            throw asRemoteError(error);
        }
    }

    async readFeed(
        scope: { negocioId: string; sucursalId: string | null },
        afterSequence: string = '0',
        afterOperationId: string | null = null,
        limit: number = 200
    ): Promise<import('./contract').InventoryFeedPage> {
        try {
            const result = await this.request('leer_feed_inventario_v2', {
                p_negocio_id: scope.negocioId,
                p_sucursal_id: scope.sucursalId,
                p_after_sequence: afterSequence,
                p_after_operation_id: afterOperationId,
                p_limit: limit
            });
            if (result.error) throw result.error;

            return parseInventoryFeedPage(result.data, scope, afterSequence, afterOperationId, limit);
        } catch (error) {
            throw asRemoteError(error);
        }
    }
}
