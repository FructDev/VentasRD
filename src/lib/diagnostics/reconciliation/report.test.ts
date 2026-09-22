import { describe, expect, it } from 'vitest';
import { buildReport } from './report';
import { parseReconciliationReport } from './schema';
import { baseInput } from './fixtures/local';
import type { FindingDraft, ReconciliationInput } from './types';

const request: ReconciliationInput['request'] = { negocioId: 'tenant', desde: 0, hasta: 100, asOf: 101, pendingThresholdMs: 300_000 };
const emptyRecords = { ventas: [], ventaDetalles: [], productos: [], movimientosStock: [], transaccionesFiado: [], seriales: [], devoluciones: [], cajas: [], cortesCaja: [], gastos: [], reparaciones: [], apartados: [], reportes: [] };
const input: ReconciliationInput = { contractVersion: '1.0', request, snapshots: [{ contractVersion: '1.0', source: { sourceId: 'pc-a', kind: 'LOCAL', negocioId: 'tenant' }, capture: { startedAt: 100, finishedAt: 101, asOf: 101, temporalConsistency: 'COHERENT' }, coverage: [{ entity: 'ventas', scope: { negocioId: 'tenant', desde: 0, hasta: 100 }, status: 'COMPLETE', startedAt: 100, finishedAt: 101, rowsRead: 0, exhausted: true, concurrentChangePossible: false }], records: emptyRecords }] };
function draft(code: FindingDraft['code'], severity: FindingDraft['severity']): FindingDraft {
    return { code, severity, category: code.startsWith('SYNC') ? 'SYNC' : 'INVENTORY', entity: 'productos', ids: { productId: 'product-1' }, sources: ['pc-a'], explanation: 'Estado conocido', localEvidence: [], remoteEvidence: [], missingEvidence: [], verificability: 'VERIFIED', diagnosticRecommendation: 'Revisar evidencia' };
}

describe('informe determinista', () => {
    it('ordena y asigna ID estable sin depender del orden de hallazgos', () => {
        const findings = [draft('SYNC_PENDING', 'INFO'), draft('STOCK_MATERIALIZED_MISMATCH', 'ERROR')];
        const a = buildReport(input, findings);
        const b = buildReport(input, [...findings].reverse());
        expect(a).toEqual(b);
        expect(a.findings.map(f => f.severity)).toEqual(['ERROR', 'INFO']);
        expect(a.counts.bySeverity.ERROR).toBe(1);
        expect(a.findings[0].findingId).toBeTruthy();
    });
    it('no certifica consistencia cuando una fuente es parcial y no hay discrepancias', () => {
        const partial: ReconciliationInput = { ...input, snapshots: [{ ...input.snapshots[0], coverage: [{ ...input.snapshots[0].coverage[0], status: 'PARTIAL' }] }] };
        const report = buildReport(partial, []);
        expect(report.overall).toBe('INCOMPLETE_EVIDENCE');
        expect(report.coverage[0].status).toBe('PARTIAL');
    });
    it('conserva conteo no verificable incluso junto a hallazgos', () => {
        const missing = { ...draft('STOCK_BASE_UNVERIFIABLE', 'WARNING'), verificability: 'UNVERIFIABLE' as const, missingEvidence: ['TRUSTED_BASELINE'] };
        const report = buildReport(input, [missing, draft('SYNC_PENDING', 'INFO')]);
        expect(report.overall).toBe('FINDINGS_PRESENT');
        expect(report.counts.unverifiable).toBe(1);
    });
    it('valida códigos y estructura del contrato de salida 1.0', () => {
        const valid = buildReport(baseInput(), []);
        expect(parseReconciliationReport(valid).contractVersion).toBe('1.0');
        const withFinding = buildReport(baseInput(), [draft('SYNC_PENDING', 'INFO')]);
        expect(() => parseReconciliationReport({ ...withFinding, findings: [{ ...withFinding.findings[0], code: 'BOGUS' }] })).toThrow();
    });
});
