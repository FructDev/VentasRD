import type { Transaction } from 'dexie';
import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { MovimientoStockLocal } from '@/types/database';
import type { InventoryRolloutMode, InventoryScope } from './contract';
import { InventoryRemoteError, type InventoryApplyPort } from './remote-client';
import { InventoryOperationRepository } from './repository';
import { procesarColaInventario, type InventoryOutboxResult } from './worker-outbox';
import { syncQuiescence } from '../quiescence';

const resource = (operation: MovimientoStockLocal) =>
    `${operation.negocio_id}:${operation.sucursal_id ?? 'GLOBAL'}:${operation.producto_id}`;

/** Owns only v2 dispatch. Legacy remains in its original dispatcher. */
export function startInventorySender(input: {
    database: VentaRDDatabase; remote: InventoryApplyPort;
    getScope: () => InventoryScope | null; getMode: (scope: InventoryScope) => InventoryRolloutMode;
    online: () => boolean; visible: () => boolean;
    reportError: (code: 'INVENTORY_SEND_UNVERIFIED') => void;
    reportResult?: (result: InventoryOutboxResult, elapsedMs: number) => void;
}): { wake: () => Promise<void>; stop: () => void } {
    let stopped = false, queued = false, job: Promise<void> | null = null;
    const repository = new InventoryOperationRepository(input.database);
    const enabled = (scope: InventoryScope) => !stopped && input.online() && input.visible()
        && input.getScope()?.negocioId === scope.negocioId && input.getMode(scope) === 'ACTIVE';
    const wake = (): Promise<void> => {
        const scope = input.getScope();
        if (!scope || !enabled(scope)) return Promise.resolve();
        if (job) { queued = true; return job; }
        const finishActivity = syncQuiescence.enter();
        if (!finishActivity) return Promise.resolve();
        job = (async () => {
            const started = performance.now();
            // Use the pending index, not the tenant's complete movement history.
            const rows = await input.database.movimientos_stock.where('estado_sincronizacion').equals(0)
                .filter(row => row.negocio_id === scope.negocioId).toArray();
            if (!enabled(scope)) return;
            const legacyBlocked = new Set<string>();
            const products = new Map((await input.database.productos.bulkGet([...new Set(rows.map(row => row.producto_id))]))
                .filter(product => !!product).map(product => [product!.id, product!]));
            const operations: MovimientoStockLocal[] = [];
            rows.sort((a, b) => a.fecha_creacion - b.fecha_creacion || a.id.localeCompare(b.id));
            for (const row of rows) {
                if (row.sync_protocol_version !== 2) legacyBlocked.add(resource(row));
                else if (!legacyBlocked.has(resource(row))) {
                    const product = products.get(row.producto_id);
                    if (!product || product.negocio_id !== row.negocio_id || product.estado_sincronizacion === 0
                        || (product.inventory_bootstrap && product.inventory_bootstrap.state !== 'READY')) legacyBlocked.add(resource(row));
                    else operations.push(row);
                }
            }
            if (!operations.length) return;
            const result = await procesarColaInventario({ operations, repository,
                remote: { apply: operation => {
                    if (!enabled(scope)) throw new InventoryRemoteError('REMOTE_UNAVAILABLE', 'TEMPORARY');
                    return input.remote.apply(operation);
                } },
                applyLegacy: () => { throw new Error('independent_sender_legacy_forbidden'); } });
            input.reportResult?.(result, performance.now() - started);
        })().catch(() => { input.reportError('INVENTORY_SEND_UNVERIFIED'); }).finally(() => {
            job = null;
            finishActivity();
            if (queued && !stopped) { queued = false; void wake(); }
        });
        return job;
    };
    // Hook only subscribes to transaction completion. Never transmit a row
    // created in a transaction that can still fail/abort.
    const observed = new WeakSet<Transaction>();
    const afterCommit = (transaction: Transaction) => {
        if (observed.has(transaction)) return;
        observed.add(transaction);
        transaction.on('complete', () => { void wake(); });
    };
    const creating = (_key: string, _row: MovimientoStockLocal, transaction: Transaction) => afterCommit(transaction);
    const updating = (_changes: object, _key: string, _row: MovimientoStockLocal, transaction: Transaction) => afterCommit(transaction);
    input.database.movimientos_stock.hook('creating').subscribe(creating);
    input.database.movimientos_stock.hook('updating').subscribe(updating);
    const productUpdating = (_changes: object, _key: string, _row: unknown, transaction: Transaction) => afterCommit(transaction);
    input.database.productos.hook('updating').subscribe(productUpdating);
    const interval = setInterval(() => { void wake(); }, 2000);
    void wake();
    return { wake, stop: () => {
        stopped = true; queued = false; clearInterval(interval);
        input.database.movimientos_stock.hook('creating').unsubscribe(creating);
        input.database.movimientos_stock.hook('updating').unsubscribe(updating);
        input.database.productos.hook('updating').unsubscribe(productUpdating);
    } };
}
