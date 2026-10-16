import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { InventoryScope } from './inventory/contract';
import { summarizeLocalQueues } from './queue-status';
import {getSharedCaptureContext} from './shared-capture';
import type {LocalQueueSummary} from './queue-status';

/** Indexed local reads only. No worker, network, retry, writes or adoption of legacy rows. */
export function readLocalQueues(database: VentaRDDatabase, scope: InventoryScope) {
    const c=getSharedCaptureContext(database);
    if(c?.tenantId===scope.negocioId&&c.branchId===scope.sucursalId)return database.transaction('r',database.shared_mutations,database.shared_outbox,async()=>{
        const rows=await database.shared_mutations.filter(row=>row.context.tenantId===scope.negocioId&&row.context.branchId===scope.sucursalId).toArray(),ops=await database.shared_outbox.filter(row=>row.context.tenantId===scope.negocioId&&row.context.branchId===scope.sucursalId).toArray();
        const summary:LocalQueueSummary={scope:{...scope},protocol:'SHARED_JOURNAL',salesPending:0,inventoryPending:0,attention:0,unknown:0,unscoped:0};
        for(const raw of rows){if(raw.state==='APPLIED')continue;const isSale=raw.changes.some(change=>change.table==='ventas');if(isSale)summary.salesPending++;else summary.inventoryPending++;if(raw.state==='BLOCKED'||ops.some(op=>op.sourceMutationId===raw.id&&op.state==='BLOCKED'))summary.attention++}return summary;
    });
    return database.transaction('r', [database.ventas, database.movimientos_stock], async () => {
        // Bulk indexed read avoids a per-row IndexedDB cursor/filter round trip.
        // Scope and pending flags are classified by the pure reducer below.
        const sales = await database.ventas.where('negocio_id').equals(scope.negocioId).toArray();
        const movements = await database.movimientos_stock.where('negocio_id').equals(scope.negocioId).toArray();
        return summarizeLocalQueues(scope, sales, movements);
    });
}
