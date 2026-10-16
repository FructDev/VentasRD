import type { ProductoLocal } from '@/types/database';
import type { InventoryScope } from './contract';
import { normalizeInventoryInteger } from './canonical-payload';
import { inventoryReceiverMode } from './activation';

export function scopedInventoryActive(scope: InventoryScope): boolean {
    return inventoryReceiverMode(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_VENTARD_INVENTORY_FEED_MODE, scope) === 'ACTIVE';
}

export function catalogAtScope(products: ProductoLocal[], scope: InventoryScope, requireKnown = scopedInventoryActive(scope)): ProductoLocal[] {
    return products.flatMap(product => {
        if (product.negocio_id !== scope.negocioId || product.eliminado) return [];
        if (product.tipo === 'combo') return [{ ...product, stock_actual: 0 }]; // Recipes, not stock authority.
        const projected = productAtScope(product, scope, requireKnown);
        return projected ? [projected] : [];
    });
}

export function inventoryScopeKey(scope: InventoryScope): string {
    return `${scope.negocioId}:${scope.sucursalId ?? 'GLOBAL'}`;
}

/** Legacy scalar is un-attributed compatibility data, never remote evidence. */
export function productAtScope(product: ProductoLocal, scope: InventoryScope, requireKnown = false): ProductoLocal | undefined {
    if (product.negocio_id !== scope.negocioId) return undefined;
    const snapshots = product.inventory_stock_by_scope;
    if (!snapshots) return requireKnown ? undefined : product;
    const stock = snapshots[inventoryScopeKey(scope)];
    if (stock === undefined) return undefined;
    return { ...product, stock_actual: Number(normalizeInventoryInteger(stock)) };
}

export function requireProductAtScope(product: ProductoLocal, scope: InventoryScope): ProductoLocal {
    const projected = productAtScope(product, scope);
    if (!projected) throw new Error('inventory_scope_stock_unavailable');
    return projected;
}

/** Writes a local projection, not a remote receipt. Call inside the effect transaction. */
export function withScopeStock(product: ProductoLocal, scope: InventoryScope, stock: number): ProductoLocal {
    if (product.negocio_id !== scope.negocioId) throw new Error('inventory_stock_tenant_mismatch');
    return { ...product, stock_actual: Number(normalizeInventoryInteger(stock)),
        inventory_stock_by_scope: { ...product.inventory_stock_by_scope, [inventoryScopeKey(scope)]: stock } };
}
