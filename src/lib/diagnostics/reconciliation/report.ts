import { effectiveCoverage } from './coverage';
import { sanitizeCoverageReason, sanitizeFindingDraft, sanitizeText } from './privacy';
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

function stableValue(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(',')}}`;
    return JSON.stringify(value);
}

function uniqueSorted<T>(items: readonly T[], key: (item: T) => string): T[] {
    const unique = new Map<string, T>();
    for (const item of items) unique.set(key(item), item);
    return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
}

export function buildReport(input: ReconciliationInput, drafts: readonly FindingDraft[]): ReconciliationReport {
    const findings: Finding[] = drafts.map(rawDraft => {
        const sanitized = sanitizeFindingDraft(rawDraft);
        const draft: FindingDraft = {
            ...sanitized,
            sources: uniqueSorted(sanitized.sources, value => value),
            localEvidence: uniqueSorted(sanitized.localEvidence, stableValue),
            remoteEvidence: uniqueSorted(sanitized.remoteEvidence, stableValue),
            missingEvidence: uniqueSorted(sanitized.missingEvidence.length || sanitized.localEvidence.length || sanitized.remoteEvidence.length ? sanitized.missingEvidence : ['NO_EVIDENCE_REFERENCE'], value => value),
        };
        return { ...draft, findingId: stableFindingId(draft, input.request) };
    });
    findings.sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)
        || a.category.localeCompare(b.category) || a.code.localeCompare(b.code)
        || a.entity.localeCompare(b.entity) || primaryId(a).localeCompare(primaryId(b))
        || a.sources.join(',').localeCompare(b.sources.join(',')) || a.findingId.localeCompare(b.findingId)
        || stableValue(a).localeCompare(stableValue(b)));

    const coverage: Coverage[] = input.snapshots.flatMap(s => s.coverage.map(c => ({
        ...c,
        scope: { ...c.scope, ...(c.scope.requestedIds && { requestedIds: [...c.scope.requestedIds].sort() }) },
        status: effectiveCoverage(c),
        ...(c.reason && { reason: sanitizeCoverageReason(c.reason) }),
    })));
    coverage.sort((a, b) => a.entity.localeCompare(b.entity) || a.scope.negocioId.localeCompare(b.scope.negocioId) || a.startedAt - b.startedAt || stableValue(a).localeCompare(stableValue(b)));
    const bySeverity = Object.fromEntries(severityOrder.map(level => [level, 0])) as Record<Severity, number>;
    const byCategory = Object.fromEntries(categories.map(category => [category, 0])) as Record<Category, number>;
    for (const finding of findings) { bySeverity[finding.severity]++; byCategory[finding.category]++; }
    const incomplete = coverage.some(c => c.status !== 'COMPLETE') || input.snapshots.some(s => s.capture.temporalConsistency === 'UNKNOWN');
    return {
        contractVersion: '1.0', asOf: input.request.asOf,
        scope: { negocioId: input.request.negocioId, ...(input.request.sucursalId && { sucursalId: input.request.sucursalId }), desde: input.request.desde, hasta: input.request.hasta, deviceLabels: uniqueSorted(input.snapshots.map(s => s.source.deviceLabel).filter((label): label is string => !!label).map(sanitizeText), value => value) },
        overall: findings.length ? 'FINDINGS_PRESENT' : incomplete ? 'INCOMPLETE_EVIDENCE' : 'CONSISTENT_WITH_EVIDENCE',
        sources: input.snapshots.map(s => ({ sourceId: sanitizeText(s.source.sourceId), kind: s.source.kind, captureWindow: { startedAt: s.capture.startedAt, finishedAt: s.capture.finishedAt }, coverageSummary: s.coverage.reduce<CoverageStatus>((worst, c) => coverageRank[effectiveCoverage(c)] > coverageRank[worst] ? effectiveCoverage(c) : worst, 'COMPLETE') })).sort((a, b) => a.sourceId.localeCompare(b.sourceId) || stableValue(a).localeCompare(stableValue(b))),
        coverage, counts: { bySeverity, byCategory, unverifiable: findings.filter(f => f.verificability === 'UNVERIFIABLE').length }, findings,
    };
}
