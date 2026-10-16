import type { InventoryFeedPort } from './remote-client';
import { parseInventoryFeedPage } from './remote-client';
import type { InventoryOperationRepository } from './repository';
import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { InventoryScope, RemoteInventoryReceipt } from './contract';
import { captureCatalogBaseline } from '@/lib/sync/catalog-pull';
import { withScopeStock } from './scope-stock';
import { inventoryScopeKey } from './scope-stock';
import type { ProductoLocal } from '@/types/database';

export interface InboxResult { processed: number; hasMore: boolean; watermark?: string; deferred?: number }

export async function procesarInboxInventario(input: {
    scope: InventoryScope;
    repository: InventoryOperationRepository;
    remote: InventoryFeedPort;
    database: VentaRDDatabase;
    now?: () => number;
    isCurrentScope?: () => boolean;
}): Promise<InboxResult> {
    const { scope, repository, remote, database } = input;
    const cursor = await repository.getCursor(scope);
    const afterSequence = cursor?.last_remote_sequence ?? '0';
    const afterId = cursor?.last_operation_id ?? null;
    const baseline = await captureCatalogBaseline(database, scope);
    const page = parseInventoryFeedPage(await remote.readFeed(scope, afterSequence, afterId, 200), scope, afterSequence, afterId);

    return database.transaction('rw', database.productos, database.movimientos_stock, database.inventario_sync_cursors, async () => {
        if (input.isCurrentScope && !input.isCurrentScope()) return { processed: 0, hasMore: false };
        const currentCursor = await repository.getCursor(scope);
        // Another tab may already have committed this download. Re-read instead
        // of applying a stale page against newer evidence/projections.
        if (JSON.stringify(currentCursor) !== JSON.stringify(cursor)) return { processed: 0, hasMore: true };
        const now = (input.now ?? Date.now)();
        const latest = new Map<string, RemoteInventoryReceipt>();
        const remember = (receipt: RemoteInventoryReceipt) => {
            const previous = latest.get(receipt.productoId);
            if (!previous || BigInt(receipt.remoteSequence) > BigInt(previous.remoteSequence)
                || (receipt.remoteSequence === previous.remoteSequence && receipt.operationId > previous.operationId)) {
                latest.set(receipt.productoId, receipt);
            }
        };
        (currentCursor?.latest_receipts ?? []).forEach(remember);
        (currentCursor?.deferred_receipts ?? []).forEach(remember);
        for (const item of page.items) {
            remember(item);
            const local = await repository.get(item.operationId);
            if (local) await repository.applyReceipt(item.operationId, item, now);
        }
        const movements = await database.movimientos_stock.where('negocio_id').equals(scope.negocioId).toArray();
        const productRows = await database.productos.bulkGet([...new Set(movements.map(row => row.producto_id))]);
        const scopedProducts = new Set(productRows.filter(row => !!row?.inventory_stock_by_scope).map(row => row!.id));
        const blocked = new Set<string>();
        for (const operation of movements) {
            // Legacy scalar without attribution stays conservatively blocked.
            if (operation.estado_sincronizacion === 0 && ((operation.sucursal_id ?? null) === scope.sucursalId
                || !scopedProducts.has(operation.producto_id))) blocked.add(operation.producto_id);
            if ((operation.sucursal_id ?? null) === scope.sucursalId && operation.remote_receipt
                && operation.sync_state === 'APPLIED'
                // Once consumed, an older local receipt cannot reconstruct the
                // latest product base. Old cursors may lack durable per-product
                // evidence; preserve their projection instead of inventing it.
                && BigInt(operation.remote_receipt.remoteSequence) > BigInt(afterSequence)) remember(operation.remote_receipt);
        }
        const freshBaseline = await captureCatalogBaseline(database, scope, [...latest.keys()]);
        const projectionRows = await database.productos.bulkGet([...latest.keys()]);
        const projectionProducts = new Map(projectionRows.filter((row): row is ProductoLocal => !!row).map(row => [row.id, row]));
        const updates: ProductoLocal[] = [];
        const deferred: RemoteInventoryReceipt[] = [];
        for (const receipt of latest.values()) {
            const product = projectionProducts.get(receipt.productoId);
            if (!product || product.negocio_id !== scope.negocioId || product.estado_sincronizacion === 0
                || blocked.has(receipt.productoId) || freshBaseline.get(receipt.productoId) !== baseline.get(receipt.productoId)) {
                deferred.push(receipt);
                continue;
            }
            const stock = Number(receipt.stockAfter);
            // A quiet feed must not rewrite the catalog and invalidate POS
            // live queries every 15s. Missing scope metadata still needs its
            // first projection, even when the legacy scalar already matches.
            if (product.stock_actual !== stock || product.inventory_stock_by_scope?.[inventoryScopeKey(scope)] !== stock) {
                updates.push(withScopeStock(product, scope, stock));
            }
        }
        if (updates.length) await database.productos.bulkPut(updates);
        deferred.sort((a, b) => a.productoId.localeCompare(b.productoId));
        const latestReceipts = [...latest.values()].sort((a, b) => a.productoId.localeCompare(b.productoId));
        await repository.advanceCursor(scope, { lastRemoteSequence: page.cursor.remoteSequence,
            lastOperationId: page.cursor.operationId ?? undefined, updatedAt: now,
            deferredReceipts: deferred, latestReceipts });
        return { processed: page.items.length, hasMore: page.hasMore, watermark: page.watermark, deferred: deferred.length };
    });
}
