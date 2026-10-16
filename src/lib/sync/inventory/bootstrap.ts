import type { ProductoLocal } from '@/types/database';
import { classifyInventoryError } from './classify-error';
import { InventoryRemoteError } from './remote-client';
import { INVENTORY_OUTCOME_CODES, type InventoryScope } from './contract';
import { scopedInventoryActive, withScopeStock } from './scope-stock';

/** Only a genuinely new zero-base product. Existing/legacy stock is never adopted. */
export function prepareNewLocalProduct(product: ProductoLocal, scope: InventoryScope, active = scopedInventoryActive(scope)): ProductoLocal {
    if (!active) return product;
    if (product.stock_actual !== 0) throw new Error('inventory_bootstrap_nonzero_base');
    return { ...withScopeStock(product, scope, 0), inventory_bootstrap: { sucursalId: scope.sucursalId, state: 'PENDING' } };
}

interface BootstrapPort {
    rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
/** Metadata prerequisite only. Never acknowledges a movement or repairs stock. */
export async function prepareInventoryProduct(client: BootstrapPort, product: ProductoLocal): Promise<void> {
    if (!product.inventory_bootstrap || product.inventory_bootstrap.state === 'READY') return;
    const result = await client.rpc('preparar_producto_inventario_v2', {
        p_negocio_id: product.negocio_id, p_producto_id: product.id, p_sucursal_id: product.inventory_bootstrap.sucursalId });
    if (result.error) {
        const failure = classifyInventoryError(result.error);
        throw new InventoryRemoteError(failure.code, failure.errorClass, failure.retryable, failure.retryAfterMs);
    }
    const row = result.data as Record<string, unknown> | null;
    if (row?.outcome === 'REJECTED' && typeof row.code === 'string' && INVENTORY_OUTCOME_CODES.includes(row.code as never)) {
        const failure = classifyInventoryError({ code: row.code });
        throw new InventoryRemoteError(failure.code, failure.errorClass, failure.retryable);
    }
    if (row?.outcome !== 'READY' || row.negocioId !== product.negocio_id || row.productoId !== product.id
        || row.sucursalId !== product.inventory_bootstrap.sucursalId) throw new InventoryRemoteError('REMOTE_RESPONSE_INVALID', 'PERMANENT');
}
