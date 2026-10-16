import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { InventoryRolloutMode, InventoryScope } from './contract';
import type { InventoryFeedPort } from './remote-client';
import { parseInventoryFeedPage } from './remote-client';
import { InventoryOperationRepository } from './repository';
import { procesarInboxInventario } from './worker-inbox';
import { syncQuiescence } from '../quiescence';

export { inventoryReceiverMode } from './activation';

/** Bounded reception, independent of catalog uploads and legacy business sync. */
export async function receiveInventoryPages(input: {
    database: VentaRDDatabase; remote: InventoryFeedPort; scope: InventoryScope;
    mode: InventoryRolloutMode; isCurrentScope: () => boolean; maxPages?: number;
}): Promise<{ processed: number; hasMore: boolean }> {
    if (input.mode !== 'ACTIVE' && input.mode !== 'SHADOW') return { processed: 0, hasMore: false };
    const repository = new InventoryOperationRepository(input.database);
    let processed = 0, hasMore = false;
    let shadowCursor = await repository.getCursor(input.scope);
    for (let index = 0; index < (input.maxPages ?? 3) && input.isCurrentScope(); index++) {
        if (input.mode === 'SHADOW') {
            const sequence = shadowCursor?.last_remote_sequence ?? '0';
            const id = shadowCursor?.last_operation_id ?? null;
            const page = parseInventoryFeedPage(await input.remote.readFeed(input.scope, sequence, id, 200), input.scope, sequence, id);
            hasMore = page.hasMore; processed += page.items.length;
            shadowCursor = { id: '', negocio_id: input.scope.negocioId, sucursal_id: input.scope.sucursalId,
                last_remote_sequence: page.cursor.remoteSequence, last_operation_id: page.cursor.operationId ?? undefined, updated_at: 0 };
        } else {
            const result = await procesarInboxInventario({ ...input, repository });
            processed += result.processed; hasMore = result.hasMore;
        }
        if (!hasMore) break;
    }
    return { processed, hasMore };
}

export function startInventoryReceiver(input: {
    database: VentaRDDatabase; remote: InventoryFeedPort;
    getScope: () => InventoryScope | null; getMode: (scope: InventoryScope) => InventoryRolloutMode;
    online: () => boolean; visible: () => boolean;
    reportError: (code: 'INVENTORY_FEED_UNVERIFIED') => void;
}): { wake: () => Promise<void>; stop: () => void } {
    let stopped = false, busy = false;
    const wake = async () => {
        if (stopped || busy || !input.online() || !input.visible()) return;
        const scope = input.getScope();
        if (!scope) return;
        const mode = input.getMode(scope);
        if (mode !== 'ACTIVE' && mode !== 'SHADOW') return;
        const finishActivity = syncQuiescence.enter();
        if (!finishActivity) return;
        busy = true;
        try {
            await receiveInventoryPages({ ...input, scope, mode, isCurrentScope: () => {
                const current = input.getScope();
                return !stopped && current?.negocioId === scope.negocioId && current.sucursalId === scope.sucursalId;
            } });
        } catch { input.reportError('INVENTORY_FEED_UNVERIFIED'); }
        finally { busy = false; finishActivity(); }
    };
    const interval = setInterval(() => { void wake(); }, 15_000);
    void wake();
    return { wake, stop: () => { stopped = true; clearInterval(interval); } };
}
