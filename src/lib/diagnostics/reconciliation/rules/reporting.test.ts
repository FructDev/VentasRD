import { describe, expect, it } from 'vitest';
import { analyzeReporting } from './reporting';
import { asOf, baseInput, id, sale, sourceId, tenant } from '../fixtures/local';
import { branch, baseCoverage } from '../fixtures/local';
import { financeSnapshot, reportId } from '../fixtures/finance';

describe('current historical report limitations', () => {
    it('marks ITBIS reconstructed from a current product rate as irreproducible', () => {
        const snapshot = financeSnapshot();
        expect(analyzeReporting(snapshot, baseInput(snapshot).request).find(f => f.code === 'REPORT_TAX_UNVERIFIABLE')).toMatchObject({ severity: 'WARNING', verificability: 'UNVERIFIABLE', ids: { operationId: reportId } });
    });
    it('detects a refund omitted from a report only with complete refund evidence', () => {
        const snapshot = financeSnapshot();
        snapshot.records.devoluciones = [{ id: id(74), negocioId: tenant, sucursalId: branch, sourceId, observedAt: asOf, ventaId: sale().id, monto: '10.00', fecha: asOf - 5_000 }];
        expect(analyzeReporting(snapshot, baseInput(snapshot).request).find(f => f.code === 'REPORT_REFUND_GAP')).toMatchObject({ severity: 'ERROR', verificability: 'DISCREPANT' });
    });
    it('reports purged history instead of treating an empty period as zero', () => {
        const snapshot = financeSnapshot();
        snapshot.records.ventas = [];
        snapshot.coverage = baseCoverage().map(c => c.entity === 'ventas' ? { ...c, scope: { negocioId: tenant, sucursalId: branch, desde: asOf - 100 * 86_400_000, hasta: asOf }, status: 'PARTIAL' as const, exhausted: false, retentionHorizon: asOf - 90 * 86_400_000, reason: 'LOCAL_RETENTION_WINDOW' } : c);
        const request = { ...baseInput(snapshot).request, sucursalId: branch, desde: asOf - 100 * 86_400_000 };
        expect(analyzeReporting(snapshot, request).find(f => f.code === 'REPORT_HISTORY_PARTIAL')).toMatchObject({ severity: 'WARNING', verificability: 'UNVERIFIABLE' });
    });
});
