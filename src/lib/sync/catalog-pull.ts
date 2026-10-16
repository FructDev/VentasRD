import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { ProductoLocal } from '@/types/database';
import type { InventoryScope } from './inventory/contract';
import { productAtScope, withScopeStock } from './inventory/scope-stock';

export type CatalogBaseline = ReadonlyMap<string, string>;
type RemoteStockRow = Pick<ProductoLocal, 'id' | 'negocio_id' | 'stock_actual' | 'eliminado'>;

function revision(product: ProductoLocal): string {
    // Include local operation identity and edits, even if another tab already
    // acknowledged their sync flag while this network request was in progress.
    return JSON.stringify(Object.entries(product).sort(([a], [b]) => a.localeCompare(b)));
}

function mergeCatalogMetadata(remote: ProductoLocal, local: ProductoLocal | undefined): ProductoLocal {
    return { ...remote,
        inventory_stock_by_scope: local?.inventory_stock_by_scope ?? {},
        inventory_bootstrap: local?.inventory_bootstrap,
        estado_sincronizacion: 1,
        ...(local?.inventory_sync_protocol_version && { inventory_sync_protocol_version: local.inventory_sync_protocol_version }),
        ...(local?.inventory_last_local_operation_id && { inventory_last_local_operation_id: local.inventory_last_local_operation_id }),
    };
}

export async function captureCatalogBaseline(database: VentaRDDatabase, scope: InventoryScope, productIds?: string[]): Promise<CatalogBaseline> {
    const rows = productIds
        ? await database.productos.bulkGet(productIds)
        : await database.productos.where('negocio_id').equals(scope.negocioId).toArray();
    return new Map(rows.filter((row): row is ProductoLocal => !!row && row.negocio_id === scope.negocioId)
        .map(row => [row.id, revision(row)]));
}

export async function persistRemoteCatalog(input: {
    database: VentaRDDatabase;
    scope: InventoryScope;
    baseline: CatalogBaseline;
    branchStocks?: ReadonlyMap<string, number>;
    /** ACTIVE v2 only: catalog metadata can arrive before stock authority.
     * Never makes an unknown stock sellable or advances past a local edit. */
    metadataWithoutAuthority?: boolean;
    isCurrentScope?: () => boolean;
} & ({ mode?: 'CATALOG'; products: ProductoLocal[] } | { mode: 'STOCK_ONLY'; products: RemoteStockRow[] })): Promise<{ written: number; deleted: number; deferred: number }> {
    const { database, scope, baseline, products } = input;
    if (products.some(product => product.negocio_id !== scope.negocioId)) throw new Error('catalog_scope_mismatch');
    return database.transaction('rw', database.productos, database.movimientos_stock, database.composiciones, async () => {
        if (input.isCurrentScope && !input.isCurrentScope()) return { written: 0, deleted: 0, deferred: products.length };
        const localRows = await database.productos.bulkGet(products.map(product => product.id));
        // Re-read inside the same transaction as the writes. A sale committed
        // during the network request must win over this downloaded snapshot.
        const movements = await database.movimientos_stock.where('negocio_id').equals(scope.negocioId)
            .filter(row => row.estado_sincronizacion === 0).toArray();
        const localsById = new Map(localRows.filter(product => !!product).map(product => [product!.id, product!]));
        const pending = new Set(movements.filter(row => (row.sucursal_id ?? null) === scope.sucursalId
            || !localsById.get(row.producto_id)?.inventory_stock_by_scope).map(row => row.producto_id));
        const updates: ProductoLocal[] = [];
        const deleted: string[] = [];
        let deferred = 0;

        for (const [index, remote] of products.entries()) {
            const local = localRows[index];
            if (local && local.negocio_id !== scope.negocioId) throw new Error('catalog_scope_mismatch');
            if ((local ? revision(local) : undefined) !== baseline.get(remote.id)
                || local?.estado_sincronizacion === 0) {
                deferred++;
                continue;
            }
            if (remote.eliminado) {
                if (pending.has(remote.id)) { deferred++; continue; }
                if (local) deleted.push(local.id);
                continue;
            }
            if (input.mode === 'STOCK_ONLY' && !local) continue;
            // A missing/denied branch row is not evidence of GLOBAL stock.
            const authoritativeStock = scope.sucursalId === null
                ? remote.stock_actual
                : input.branchStocks?.get(remote.id);
            if (authoritativeStock === undefined || !Number.isSafeInteger(authoritativeStock)) {
                if (authoritativeStock === undefined && scope.sucursalId !== null
                    && input.mode !== 'STOCK_ONLY' && input.metadataWithoutAuthority) {
                    const metadata = mergeCatalogMetadata(input.products[index], local);
                    // Preserve any previous local scalar, without assigning it
                    // to this branch. Empty scope metadata means unknown stock.
                    if (local) metadata.stock_actual = local.stock_actual;
                    if (!local || revision(metadata) !== revision(local)) updates.push(metadata);
                    continue;
                }
                deferred++;
                continue;
            }
            if (input.mode === 'STOCK_ONLY') {
                if (!pending.has(remote.id) && local && productAtScope(local, scope, true)?.stock_actual !== authoritativeStock) {
                    updates.push(withScopeStock(local, scope, authoritativeStock));
                }
                continue;
            }
            const catalogProduct = input.products[index];
            const localStock = local ? productAtScope(local, scope)?.stock_actual : undefined;
            if (pending.has(remote.id) && localStock === undefined) { deferred++; continue; }
            const next = withScopeStock(mergeCatalogMetadata(catalogProduct, local), scope,
                pending.has(remote.id) && localStock !== undefined ? localStock : authoritativeStock);
            if (!local || revision(next) !== revision(local)) updates.push(next);
        }
        if (input.isCurrentScope && !input.isCurrentScope()) return { written: 0, deleted: 0, deferred: products.length };
        if (updates.length) await database.productos.bulkPut(updates);
        if (deleted.length) {
            await database.productos.bulkDelete(deleted);
            await database.composiciones.where('producto_padre_id').anyOf(deleted).delete();
        }
        return { written: updates.length, deleted: deleted.length, deferred };
    });
}
