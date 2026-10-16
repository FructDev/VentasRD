import type { ClassifiedInventoryError, InventoryOutcomeCode } from './contract';

const PERMANENT_CODES = new Set<InventoryOutcomeCode>([
    'PRODUCT_NOT_FOUND',
    'BRANCH_NOT_FOUND_OR_FORBIDDEN',
    'BRANCH_NOT_FOUND_OR_INACTIVE',
    'SCOPE_NOT_INITIALIZED',
    'AUTHORITY_SCOPE_MISMATCH',
    'AUTHORITY_PROJECTION_DIVERGED',
    'INVALID_EFFECT',
]);
const CONFLICT_CODES = new Set<InventoryOutcomeCode>([
    'IDENTITY_PAYLOAD_MISMATCH',
    'STALE_ABSOLUTE_BASE',
]);

function recordOf(error: unknown): Record<string, unknown> {
    return typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
}

export function classifyInventoryError(error: unknown): ClassifiedInventoryError {
    const value = recordOf(error);
    const status = typeof value.status === 'number' ? value.status : undefined;
    const code = typeof value.code === 'string' ? value.code as InventoryOutcomeCode : undefined;
    const name = typeof value.name === 'string' ? value.name : undefined;
    const retryAfterMs = typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0
        ? value.retryAfterMs : undefined;
    const retry = retryAfterMs === undefined ? {} : { retryAfterMs };

    if (error instanceof TypeError) return { errorClass: 'TEMPORARY', code: 'NETWORK_ERROR', retryable: true };
    if (name === 'AbortError') return { errorClass: 'TEMPORARY', code: 'TIMEOUT', retryable: true };
    if (status === 408) return { errorClass: 'TEMPORARY', code: 'REQUEST_TIMEOUT', retryable: true };
    if (status === 429 || code === 'RATE_LIMITED') return { errorClass: 'TEMPORARY', code: 'RATE_LIMITED', retryable: true, ...retry };
    if ((status !== undefined && status >= 500) || code === 'REMOTE_UNAVAILABLE') return { errorClass: 'TEMPORARY', code: 'REMOTE_UNAVAILABLE', retryable: true, ...retry };
    if (code === 'TIMEOUT' || code === 'REQUEST_TIMEOUT' || code === 'NETWORK_ERROR') return { errorClass: 'TEMPORARY', code, retryable: true };
    if (status === 401 || code === 'AUTH_REQUIRED') return { errorClass: 'AUTH', code: 'AUTH_REQUIRED', retryable: false };
    if (status === 403 || code === 'SCOPE_FORBIDDEN') return { errorClass: 'AUTH', code: 'SCOPE_FORBIDDEN', retryable: false };
    if (code && PERMANENT_CODES.has(code)) return { errorClass: 'PERMANENT', code, retryable: false };
    if (code && CONFLICT_CODES.has(code)) return { errorClass: 'CONFLICT', code, retryable: false };
    if (code === 'LEGACY_EVIDENCE_AMBIGUOUS') return { errorClass: 'LEGACY', code, retryable: false };
    return { errorClass: 'PERMANENT', code: 'REMOTE_RESPONSE_INVALID', retryable: false };
}
