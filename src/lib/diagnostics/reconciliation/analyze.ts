import { parseReconciliationInput } from './schema';
import { buildReport } from './report';
import { analyzeSales } from './rules/sales';
import { analyzeInventory } from './rules/inventory';
import { analyzeLocalSync } from './rules/local-sync';
import { analyzePropagation } from './rules/propagation';
import { analyzeConflicts } from './rules/conflicts';
import type { ReconciliationInput, ReconciliationReport } from './types';

/** US1 only: pure, deterministic analysis of one already captured local source. */
export function analyzeLocal(rawInput: ReconciliationInput): ReconciliationReport {
    const input = parseReconciliationInput(rawInput);
    if (input.snapshots.length !== 1 || input.snapshots[0].source.kind !== 'LOCAL') throw new Error('US1_LOCAL_ONLY');
    const snapshot = input.snapshots[0];
    const findings = [
        ...analyzeSales(snapshot, input.request),
        ...analyzeInventory(snapshot, input.request),
        ...analyzeLocalSync(snapshot, input.request),
    ];
    return buildReport(input, findings);
}

/** Pure comparison of supplied captures; no network, clock, worker or implicit PC B reads. */
export function analyzeReconciliation(rawInput: ReconciliationInput): ReconciliationReport {
    const input = parseReconciliationInput(rawInput);
    const a = input.snapshots.find(s => s.source.kind === 'LOCAL')!;
    const remote = input.snapshots.find(s => s.source.kind === 'REMOTE');
    const b = input.snapshots.find(s => s.source.kind === 'LOCAL' && s.source.sourceId !== a.source.sourceId);
    const propagation = analyzePropagation(a, remote, b, input.request);
    const definitive = new Set(propagation.filter(f => f.interpretedSyncState === 'FALSE_CONFIRMED' || f.interpretedSyncState === 'APPLIED_VERIFIED').map(f => `${f.entity}:${f.ids.movementId ?? f.ids.saleId ?? ''}`));
    const localSync = analyzeLocalSync(a, input.request).filter(f => f.code !== 'SYNC_REMOTE_UNVERIFIABLE' || !definitive.has(`${f.entity}:${f.ids.movementId ?? f.ids.saleId ?? ''}`));
    return buildReport(input, [
        ...analyzeSales(a, input.request), ...analyzeInventory(a, input.request), ...localSync,
        ...propagation, ...analyzeConflicts(a, remote, b, input.request),
    ]);
}
