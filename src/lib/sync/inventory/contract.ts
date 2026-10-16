export const INVENTORY_CONTRACT_VERSION = 2 as const;

export const INVENTORY_SYNC_STATES = [
    'PENDING',
    'IN_FLIGHT',
    'APPLIED',
    'RETRYABLE_ERROR',
    'INTERVENTION_REQUIRED',
    'CONFLICT',
    'UNKNOWN_LEGACY',
] as const;

export type InventorySyncState = typeof INVENTORY_SYNC_STATES[number];
export type InventoryErrorClass = 'TEMPORARY' | 'AUTH' | 'PERMANENT' | 'CONFLICT' | 'LEGACY';
export type InventoryEffectKind = 'DELTA' | 'ABSOLUTE';
export type InventoryAuthority = 'BRANCH' | 'GLOBAL';
export type InventoryRolloutMode = 'LEGACY' | 'SHADOW' | 'ACTIVE' | 'PAUSED';
export type InventoryMovementType =
    | 'venta'
    | 'devolucion'
    | 'entrada'
    | 'merma'
    | 'conteo'
    | 'importacion'
    | 'reparacion'
    | 'apartado';

export interface InventoryEffect {
    kind: InventoryEffectKind;
    value: string;
}

export interface InventoryOperationPayload {
    version: typeof INVENTORY_CONTRACT_VERSION;
    operationId: string;
    negocioId: string;
    sucursalId: string | null;
    productoId: string;
    effect: InventoryEffect;
    tipo: InventoryMovementType;
    referenciaId: string | null;
    fechaOrigen: number;
    expectedRemoteSequence: string | null;
}

export const INVENTORY_WARNING_CODES = ['OFFLINE_OVERSELL'] as const;
export type InventoryWarningCode = typeof INVENTORY_WARNING_CODES[number];

export interface RemoteInventoryReceipt {
    contractVersion: '2.0';
    outcome: 'APPLIED' | 'ALREADY_APPLIED';
    operationId: string;
    negocioId: string;
    productoId: string;
    sucursalId: string | null;
    payloadHash: string;
    authority: InventoryAuthority;
    stockAfter: string;
    remoteSequence: string;
    appliedAt: string;
    warningCodes: InventoryWarningCode[];
}

export const INVENTORY_OUTCOME_CODES = [
    'NETWORK_ERROR',
    'TIMEOUT',
    'REQUEST_TIMEOUT',
    'RATE_LIMITED',
    'REMOTE_UNAVAILABLE',
    'AUTH_REQUIRED',
    'SCOPE_FORBIDDEN',
    'PRODUCT_NOT_FOUND',
    'BRANCH_NOT_FOUND_OR_FORBIDDEN',
    // Conservado solo para interpretar evidencia local creada antes de T029.
    'BRANCH_NOT_FOUND_OR_INACTIVE',
    'SCOPE_NOT_INITIALIZED',
    'AUTHORITY_SCOPE_MISMATCH',
    'AUTHORITY_PROJECTION_DIVERGED',
    'INVALID_EFFECT',
    'IDENTITY_PAYLOAD_MISMATCH',
    'STALE_ABSOLUTE_BASE',
    'LEGACY_EVIDENCE_AMBIGUOUS',
    'REMOTE_RESPONSE_INVALID',
] as const;
export type InventoryOutcomeCode = typeof INVENTORY_OUTCOME_CODES[number];

export interface ClassifiedInventoryError {
    errorClass: InventoryErrorClass;
    code: InventoryOutcomeCode;
    retryable: boolean;
    retryAfterMs?: number;
}

export type InventoryConflictCode =
    | 'IDENTITY_PAYLOAD_MISMATCH'
    | 'STALE_ABSOLUTE_BASE'
    | 'LOCAL_PENDING_DIVERGENCE'
    | 'OFFLINE_OVERSELL';

export interface InventoryConflictEvidence {
    code: InventoryConflictCode;
    detected_at: number;
    local_payload_hash?: string;
    remote_payload_hash?: string;
    expected_sequence?: string;
    actual_sequence?: string;
    remote_stock?: string;
    next_action_code: string;
}

export interface InventoryOperationMetadata {
    sync_protocol_version?: 2;
    sync_state?: InventorySyncState;
    payload_hash?: string;
    origin_device_id?: string;
    attempt_count?: number;
    last_attempt_at?: number;
    next_attempt_at?: number;
    last_outcome_code?: InventoryOutcomeCode;
    error_class?: InventoryErrorClass;
    claim_id?: string;
    lease_until?: number;
    remote_receipt?: RemoteInventoryReceipt;
    conflict?: InventoryConflictEvidence;
    sync_updated_at?: number;
    expected_remote_sequence?: string;
}

export interface InventorySyncOperation extends InventoryOperationMetadata {
    id: string;
    negocio_id: string;
    sucursal_id?: string;
    producto_id: string;
    delta: number;
    valor_absoluto?: number;
    tipo: InventoryMovementType;
    referencia_id?: string;
    fecha_creacion: number;
    estado_sincronizacion: 0 | 1;
}

export interface InventoryScope {
    negocioId: string;
    sucursalId: string | null;
}

export interface InventoryFeedCursor {
    id: string;
    negocio_id: string;
    sucursal_id: string | null;
    last_remote_sequence: string;
    last_operation_id?: string;
    updated_at: number;
    /** Últimas bases remotas no proyectadas. Se conservan con el cursor atómicamente. */
    deferred_receipts?: RemoteInventoryReceipt[];
    /** Última evidencia por producto, incluso proyectada; no un historial de eventos. */
    latest_receipts?: RemoteInventoryReceipt[];
}

export interface InventoryRolloutConfiguration {
    mode: InventoryRolloutMode;
    configVersion: number;
    environment: string;
    negocioId: string;
    deviceId?: string;
    evaluatedAt: number;
    source: 'CACHE' | 'REMOTE' | 'LOCAL_OVERRIDE_CONTROLLED';
}

export interface ApplyInventoryRequest {
    contractVersion: 2;
    payload: InventoryOperationPayload;
    payloadHash: string;
    originDeviceId: string;
}

export interface InventoryFeedPage {
    contractVersion: '2.0';
    scope: { negocioId: string; sucursalId: string | null; authority: InventoryAuthority };
    items: RemoteInventoryReceipt[];
    hasMore: boolean;
    watermark: string;
    cursor: { remoteSequence: string; operationId: string | null };
}
