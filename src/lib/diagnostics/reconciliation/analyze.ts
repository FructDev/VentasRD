import { parseReconciliationInput } from './schema';
import { buildReport } from './report';
import { analyzeSales } from './rules/sales';
import { analyzeInventory } from './rules/inventory';
import { analyzeLocalSync } from './rules/local-sync';
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
