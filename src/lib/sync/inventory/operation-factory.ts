import type { MovimientoStockLocal } from '@/types/database';
import { hashInventoryPayload, normalizeInventoryInteger } from './canonical-payload';
import type { InventoryMovementType, InventoryOperationPayload } from './contract';

export interface CreateInventoryOperationInput {
    operationId: string;
    negocioId: string;
    sucursalId?: string | null;
    productoId: string;
    tipo: InventoryMovementType;
    delta?: number;
    valorAbsoluto?: number;
    referenciaId?: string | null;
    fechaOrigen: number;
    originDeviceId: string;
    expectedRemoteSequence?: string | null;
}

export function inventoryPayloadFromOperation(
    operation: Pick<MovimientoStockLocal,
        'id' | 'negocio_id' | 'sucursal_id' | 'producto_id' | 'delta' | 'valor_absoluto'
        | 'tipo' | 'referencia_id' | 'fecha_creacion' | 'expected_remote_sequence'>,
): InventoryOperationPayload {
    return {
        version: 2,
        operationId: operation.id,
        negocioId: operation.negocio_id,
        sucursalId: operation.sucursal_id ?? null,
        productoId: operation.producto_id,
        effect: operation.valor_absoluto !== undefined
            ? { kind: 'ABSOLUTE', value: String(operation.valor_absoluto) }
            : { kind: 'DELTA', value: String(operation.delta) },
        tipo: operation.tipo,
        referenciaId: operation.referencia_id ?? null,
        fechaOrigen: operation.fecha_creacion,
        expectedRemoteSequence: operation.expected_remote_sequence ?? null,
    };
}

export function createInventoryOperation(input: CreateInventoryOperationInput): MovimientoStockLocal {
    const hasDelta = input.delta !== undefined;
    const hasAbsolute = input.valorAbsoluto !== undefined;
    if (hasDelta === hasAbsolute) throw new Error('inventory_effect_exactly_one_required');
    if (!input.originDeviceId.trim()) throw new Error('inventory_origin_device_required');
    if (hasAbsolute && !input.expectedRemoteSequence) throw new Error('inventory_absolute_sequence_required');
    const normalizedEffect = Number(normalizeInventoryInteger(hasAbsolute ? input.valorAbsoluto! : input.delta!));

    const operation: MovimientoStockLocal = {
        id: input.operationId,
        negocio_id: input.negocioId,
        sucursal_id: input.sucursalId ?? undefined,
        producto_id: input.productoId,
        delta: hasAbsolute ? 0 : normalizedEffect,
        ...(hasAbsolute && { valor_absoluto: normalizedEffect }),
        tipo: input.tipo,
        referencia_id: input.referenciaId ?? undefined,
        fecha_creacion: input.fechaOrigen,
        estado_sincronizacion: 0,
        sync_protocol_version: 2,
        sync_state: 'PENDING',
        origin_device_id: input.originDeviceId,
        attempt_count: 0,
        sync_updated_at: input.fechaOrigen,
        ...(input.expectedRemoteSequence && { expected_remote_sequence: input.expectedRemoteSequence }),
    };
    operation.payload_hash = hashInventoryPayload(inventoryPayloadFromOperation(operation));
    return operation;
}
