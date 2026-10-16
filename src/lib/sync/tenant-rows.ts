import type { Table } from 'dexie';
import type { InventoryScope } from './inventory/contract';
import { readCompletePages } from './read-complete-pages';

export interface BusinessSyncRow {
    id: string;
    negocio_id: string;
    sucursal_id?: string | null;
    estado_sincronizacion?: 0 | 1;
    fecha_creacion?: number;
    fecha_actualizacion?: number;
}

// In-memory comparison only. Never persist or log these snapshots (they can
// contain financial information/PII). Include all fields, not just a timestamp:
// two local changes may share a millisecond or have nested payment updates.
function revision(row: BusinessSyncRow): string {
    return JSON.stringify(Object.entries(row).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

export function historyPullFloor(cursor: number, asOf: number, reconcile: boolean): number {
    return reconcile ? Math.min(cursor, Math.max(0, asOf - 90 * 24 * 60 * 60 * 1000)) : cursor;
}

export async function pendingTenantRows<T extends BusinessSyncRow>(table: Table<T>, negocioId: string, includeLegacyWithoutFlag = false): Promise<T[]> {
    return table.where('negocio_id').equals(negocioId)
        .filter(row => row.estado_sincronizacion === 0 || (includeLegacyWithoutFlag && row.estado_sincronizacion === undefined))
        .toArray();
}

/** A successful upload only acknowledges the unchanged snapshot that was sent. */
export async function acknowledgeSyncedSnapshot<T extends BusinessSyncRow>(table: Table<T>, sent: T): Promise<boolean> {
    return table.db.transaction('rw', table, async () => {
        const current = await table.get(sent.id);
        if (!current || current.negocio_id !== sent.negocio_id || revision(current) !== revision(sent)) return false;
        await table.put({ ...current, estado_sincronizacion: 1 });
        return true;
    });
}

/** Local cleanup after a successful remote delete must also match its snapshot. */
export async function removeSyncedSnapshot<T extends BusinessSyncRow>(table: Table<T>, sent: T): Promise<boolean> {
    return table.db.transaction('rw', table, async () => {
        const current = await table.get(sent.id);
        if (!current || current.negocio_id !== sent.negocio_id || revision(current) !== revision(sent)) return false;
        await table.delete(sent.id);
        return true;
    });
}

export async function pullTenantRows<T extends BusinessSyncRow>(input: {
    table: Table<T>;
    scope: InventoryScope;
    readPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; count: number | null; error: unknown }>;
    isCurrentScope?: () => boolean;
    branchOnly?: boolean;
    preserveLegacyWithoutFlag?: boolean;
    merge?: (remote: T, local: T | undefined) => T;
}): Promise<{ rows: T[]; written: number; deferred: number }> {
    const { table, scope } = input;
    const locals = await table.where('negocio_id').equals(scope.negocioId).toArray();
    const baseline = new Map(locals.map(row => [row.id, revision(row)]));
    const rows = await readCompletePages(input.readPage, row => row.id);
    const validScope = (row: BusinessSyncRow) => row.negocio_id === scope.negocioId
        && (!input.branchOnly || scope.sucursalId === null || row.sucursal_id === scope.sucursalId);
    if (rows.some(row => !validScope(row))) throw new Error('row_sync_scope_mismatch');

    return table.db.transaction('rw', table, async () => {
        if (input.isCurrentScope && !input.isCurrentScope()) return { rows, written: 0, deferred: rows.length };
        const currentRows = await table.bulkGet(rows.map(row => row.id));
        const updates: T[] = [];
        let deferred = 0;
        for (const [index, remote] of rows.entries()) {
            const current = currentRows[index];
            if (current && !validScope(current)) throw new Error('row_sync_scope_mismatch');
            if (current?.estado_sincronizacion === 0
                || (current && input.preserveLegacyWithoutFlag && current.estado_sincronizacion === undefined)
                || (current ? revision(current) : undefined) !== baseline.get(remote.id)) {
                deferred++;
                continue;
            }
            const merged = input.merge ? input.merge(remote, current) : remote;
            if (merged.id !== remote.id || !validScope(merged)) throw new Error('row_sync_scope_mismatch');
            updates.push({ ...merged, estado_sincronizacion: 1 });
        }
        if (input.isCurrentScope && !input.isCurrentScope()) return { rows, written: 0, deferred: rows.length };
        if (updates.length) await table.bulkPut(updates);
        return { rows, written: updates.length, deferred };
    });
}
