import { effectiveCoverage } from './coverage';
import type { Category, Coverage, CoverageStatus, Finding, FindingDraft, ReconciliationInput, ReconciliationReport, Severity } from './types';

const severityOrder: Severity[] = ['CRITICAL', 'ERROR', 'WARNING', 'INFO'];
const categories: Category[] = ['SALE', 'INVENTORY', 'SYNC', 'PAYMENT', 'CASH', 'REPORTING', 'COMPATIBILITY', 'UNKNOWN'];
const coverageRank: Record<CoverageStatus, number> = { COMPLETE: 0, PARTIAL: 1, UNAVAILABLE: 2, DENIED: 3 };

function stableFindingId(draft: FindingDraft, request: ReconciliationInput['request']): string {
    const ids = Object.entries(draft.ids).filter((entry): entry is [string, string] => typeof entry[1] === 'string').sort(([a], [b]) => a.localeCompare(b));
    return `1.0:${draft.code}:${request.negocioId}:${request.sucursalId ?? ''}:${ids.map(([key, value]) => `${key}=${value}`).join(',')}:${[...draft.sources].sort().join(',')}:${[...draft.missingEvidence].sort().join(',')}`;
}

function primaryId(finding: Finding): string {
    return Object.values(finding.ids).sort()[0] ?? '';
}

export function buildReport(input: ReconciliationInput, drafts: readonly FindingDraft[]): ReconciliationReport {
    const findings: Finding[] = drafts.map(draft => ({ ...draft, ids: { ...draft.ids }, sources: [...draft.sources].sort(), localEvidence: [...draft.localEvidence], remoteEvidence: [...draft.remoteEvidence], missingEvidence: [...draft.missingEvidence].sort(), findingId: stableFindingId(draft, input.request) }));
    findings.sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)
        || a.category.localeCompare(b.category) || a.code.localeCompare(b.code)
        || a.entity.localeCompare(b.entity) || primaryId(a).localeCompare(primaryId(b))
        || a.sources.join(',').localeCompare(b.sources.join(',')) || a.findingId.localeCompare(b.findingId));

    const coverage: Coverage[] = input.snapshots.flatMap(s => s.coverage.map(c => ({ ...c, scope: { ...c.scope }, status: effectiveCoverage(c) })));
    coverage.sort((a, b) => a.entity.localeCompare(b.entity) || a.scope.negocioId.localeCompare(b.scope.negocioId) || a.startedAt - b.startedAt);
    const bySeverity = Object.fromEntries(severityOrder.map(level => [level, 0])) as Record<Severity, number>;
    const byCategory = Object.fromEntries(categories.map(category => [category, 0])) as Record<Category, number>;
    for (const finding of findings) { bySeverity[finding.severity]++; byCategory[finding.category]++; }
    const incomplete = coverage.some(c => c.status !== 'COMPLETE') || input.snapshots.some(s => s.capture.temporalConsistency === 'UNKNOWN');
    return {
        contractVersion: '1.0', asOf: input.request.asOf,
        scope: { negocioId: input.request.negocioId, ...(input.request.sucursalId && { sucursalId: input.request.sucursalId }), desde: input.request.desde, hasta: input.request.hasta, deviceLabels: input.snapshots.map(s => s.source.deviceLabel).filter((label): label is string => !!label).sort() },
        overall: findings.length ? 'FINDINGS_PRESENT' : incomplete ? 'INCOMPLETE_EVIDENCE' : 'CONSISTENT_WITH_EVIDENCE',
        sources: input.snapshots.map(s => ({ sourceId: s.source.sourceId, kind: s.source.kind, captureWindow: { startedAt: s.capture.startedAt, finishedAt: s.capture.finishedAt }, coverageSummary: s.coverage.reduce<CoverageStatus>((worst, c) => coverageRank[effectiveCoverage(c)] > coverageRank[worst] ? effectiveCoverage(c) : worst, 'COMPLETE') })).sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
        coverage, counts: { bySeverity, byCategory, unverifiable: findings.filter(f => f.verificability === 'UNVERIFIABLE').length }, findings,
    };
}
