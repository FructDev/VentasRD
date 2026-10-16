import type { InventoryErrorClass, InventoryOutcomeCode, InventorySyncState } from './contract';

interface LegacyRpcError {
    code?: string | null;
}

export interface LegacyWorkerPatch {
    estado_sincronizacion: 0 | 1;
    sync_state: InventorySyncState;
    error_class: InventoryErrorClass;
    last_outcome_code: InventoryOutcomeCode;
}

export interface LegacyWorkerDecision {
    patch: LegacyWorkerPatch;
    bloquearProducto: boolean;
    continuarConOtrosProductos: boolean;
}

const ERRORES_PERMANENTES = new Set(['23503', '23502', '23514', '22P02']);

/**
 * Política conservadora del puente temporal hacia RPC v1. Nunca convierte un
 * error en éxito ni fabrica un recibo v2 que la RPC legacy no puede devolver.
 */
export function resolverResultadoRpcLegacy(error: LegacyRpcError | null): LegacyWorkerDecision {
    if (!error) {
        return {
            patch: {
                estado_sincronizacion: 1,
                sync_state: 'UNKNOWN_LEGACY',
                error_class: 'LEGACY',
                last_outcome_code: 'LEGACY_EVIDENCE_AMBIGUOUS',
            },
            bloquearProducto: false,
            continuarConOtrosProductos: true,
        };
    }

    if (ERRORES_PERMANENTES.has(error.code ?? '')) {
        return {
            patch: {
                estado_sincronizacion: 0,
                sync_state: 'INTERVENTION_REQUIRED',
                error_class: 'PERMANENT',
                last_outcome_code: 'REMOTE_RESPONSE_INVALID',
            },
            bloquearProducto: true,
            continuarConOtrosProductos: true,
        };
    }

    return {
        patch: {
            estado_sincronizacion: 0,
            sync_state: 'RETRYABLE_ERROR',
            error_class: 'TEMPORARY',
            last_outcome_code: 'REMOTE_UNAVAILABLE',
        },
        bloquearProducto: true,
        continuarConOtrosProductos: false,
    };
}
