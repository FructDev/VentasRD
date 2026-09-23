import { coverageFor, effectiveCoverage } from '../coverage';
import type { EntityName, FindingDraft, ObservedReportValue, ReconciliationRequest, SourceSnapshot } from '../types';

function scoped(value: { negocioId: string; sucursalId?: string }, request: ReconciliationRequest): boolean { return value.negocioId === request.negocioId && (!request.sucursalId || value.sucursalId === request.sucursalId); }
function evidence(snapshot: SourceSnapshot, entity: EntityName, id: string, field?: string, observedValue?: string | boolean) {
    const coverage = coverageFor(snapshot.coverage, entity);
    return { sourceId: snapshot.source.sourceId, entity, id, ...(field && { field }), ...(observedValue !== undefined && { observedValue }), capturedAt: snapshot.capture.finishedAt, coverageStatus: coverage ? effectiveCoverage(coverage) : 'UNAVAILABLE' as const };
}
function overlaps(report: ObservedReportValue, date: number): boolean { return date >= report.desde && date <= report.hasta; }

export function analyzeReporting(snapshot: SourceSnapshot, request: ReconciliationRequest): FindingDraft[] {
    const findings: FindingDraft[] = [];
    for (const report of snapshot.records.reportes) {
        if (!scoped(report, request)) continue;
        if (report.taxFormula === 'CURRENT_PRODUCT_RATE' || report.taxFormula === 'DEFAULT_RATE') {
            findings.push({ code: 'REPORT_TAX_UNVERIFIABLE', severity: 'WARNING', category: 'REPORTING', entity: 'reportes', ids: { operationId: report.id }, sources: [snapshot.source.sourceId], explanation: report.taxFormula === 'CURRENT_PRODUCT_RATE' ? 'El ITBIS fue reconstruido con la tasa actual del producto; la tasa histórica no está persistida por línea.' : 'El ITBIS usa una tasa predeterminada porque faltan hechos históricos.', localEvidence: [evidence(snapshot, 'reportes', report.id, 'taxFormula', report.taxFormula), ...(report.taxTotal !== undefined ? [evidence(snapshot, 'reportes', report.id, 'taxTotal', report.taxTotal)] : [])], remoteEvidence: [], missingEvidence: ['HISTORICAL_LINE_TAX_RATE'], verificability: 'UNVERIFIABLE', diagnosticRecommendation: 'Tratar el ITBIS como irreproducible con la evidencia actual; no sustituir la tasa histórica por la actual.' });
        }
        const refundCoverage = coverageFor(snapshot.coverage, 'devoluciones');
        const refundInScope = (refund: SourceSnapshot['records']['devoluciones'][number]) => refund.negocioId === request.negocioId && (!request.sucursalId || refund.sucursalId === request.sucursalId || snapshot.records.ventas.find(sale => sale.id === refund.ventaId)?.sucursalId === request.sucursalId);
        const matchingRefunds = snapshot.records.devoluciones.filter(refund => refundInScope(refund) && overlaps(report, refund.fecha)).sort((a, b) => a.id.localeCompare(b.id));
        const omitted = report.refundsIncluded === false && matchingRefunds.length > 0;
        if (omitted && refundCoverage && effectiveCoverage(refundCoverage) === 'COMPLETE') {
            const refund = matchingRefunds[0];
            findings.push({ code: 'REPORT_REFUND_GAP', severity: 'ERROR', category: 'REPORTING', entity: 'reportes', ids: { operationId: report.id, refundId: refund.id, saleId: refund.ventaId }, sources: [snapshot.source.sourceId], explanation: 'El reporte observado excluye devoluciones aunque existe una devolución cubierta dentro del mismo período.', localEvidence: [evidence(snapshot, 'reportes', report.id, 'refundsIncluded', false), evidence(snapshot, 'devoluciones', refund.id, 'monto', refund.monto)], remoteEvidence: [], missingEvidence: [], verificability: 'DISCREPANT', diagnosticRecommendation: 'Explicar la omisión del reporte actual; no modificar el reporte ni la devolución.' });
        }
        const required: EntityName[] = ['ventas', 'ventaDetalles', 'devoluciones'];
        const incomplete = required.filter(entity => {
            const coverage = coverageFor(snapshot.coverage, entity);
            return !coverage || effectiveCoverage(coverage) !== 'COMPLETE' || (coverage.retentionHorizon !== undefined && report.desde < coverage.retentionHorizon);
        });
        if (incomplete.length) findings.push({ code: 'REPORT_HISTORY_PARTIAL', severity: 'WARNING', category: 'REPORTING', entity: 'reportes', ids: { operationId: report.id }, sources: [snapshot.source.sourceId], explanation: `El histórico necesario para el reporte está incompleto en: ${incomplete.join(', ')}. Un período vacío no prueba importe cero.`, localEvidence: [evidence(snapshot, 'reportes', report.id, 'total', report.total)], remoteEvidence: [], missingEvidence: incomplete.map(entity => `COMPLETE_${entity.toUpperCase()}_HISTORY`), verificability: 'UNVERIFIABLE', diagnosticRecommendation: 'Obtener historia conservada o cobertura remota autorizada; no rellenar hechos purgados con valores actuales.' });
    }
    return findings;
}
