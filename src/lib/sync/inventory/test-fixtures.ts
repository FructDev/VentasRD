import type {
    InventoryOperationPayload,
    InventorySyncOperation,
    RemoteInventoryReceipt,
} from './contract';

export const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
export const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';
export const BRANCH_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const BRANCH_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const PRODUCT_A_ID = '33333333-3333-4333-8333-333333333333';
export const OPERATION_A_ID = '44444444-4444-4444-8444-444444444444';

export function buildPayload(
    overrides: Partial<InventoryOperationPayload> = {},
): InventoryOperationPayload {
    return {
        version: 2,
        operationId: OPERATION_A_ID,
        negocioId: TENANT_A_ID,
        sucursalId: BRANCH_A_ID,
        productoId: PRODUCT_A_ID,
        effect: { kind: 'DELTA', value: '-1' },
        tipo: 'venta',
        referenciaId: '55555555-5555-4555-8555-555555555555',
        fechaOrigen: 1_780_000_000_000,
        expectedRemoteSequence: null,
        ...overrides,
    };
}

export function buildReceipt(
    payload: InventoryOperationPayload = buildPayload(),
    overrides: Partial<RemoteInventoryReceipt> = {},
): RemoteInventoryReceipt {
    return {
        contractVersion: '2.0',
        outcome: 'APPLIED',
        operationId: payload.operationId,
        negocioId: payload.negocioId,
        productoId: payload.productoId,
        sucursalId: payload.sucursalId,
        payloadHash: 'a'.repeat(64),
        authority: payload.sucursalId === null ? 'GLOBAL' : 'BRANCH',
        stockAfter: '9',
        remoteSequence: '1042',
        appliedAt: '2026-09-22T15:00:00.000Z',
        warningCodes: [],
        ...overrides,
    };
}

export function buildOperation(
    overrides: Partial<InventorySyncOperation> = {},
): InventorySyncOperation {
    return {
        id: OPERATION_A_ID,
        negocio_id: TENANT_A_ID,
        sucursal_id: BRANCH_A_ID,
        producto_id: PRODUCT_A_ID,
        delta: -1,
        tipo: 'venta',
        referencia_id: '55555555-5555-4555-8555-555555555555',
        fecha_creacion: 1_780_000_000_000,
        estado_sincronizacion: 0,
        sync_protocol_version: 2,
        sync_state: 'PENDING',
        payload_hash: 'a'.repeat(64),
        origin_device_id: 'device-test-a',
        attempt_count: 0,
        sync_updated_at: 1_780_000_000_000,
        ...overrides,
    };
}

export function buildProduct(overrides: Record<string, unknown> = {}) {
    return {
        id: PRODUCT_A_ID,
        negocio_id: TENANT_A_ID,
        nombre: 'Producto sintetico',
        codigo_barras: 'SYNTH-001',
        precio_venta: 100,
        costo: 50,
        stock_actual: 10,
        stock_minimo: 1,
        tasa_itbis: 0.18,
        tipo: 'simple' as const,
        estado_sincronizacion: 1 as const,
        ...overrides,
    };
}

export function buildBranch(overrides: Record<string, unknown> = {}) {
    return {
        id: BRANCH_A_ID,
        negocio_id: TENANT_A_ID,
        nombre: 'Sucursal sintetica A',
        ...overrides,
    };
}
