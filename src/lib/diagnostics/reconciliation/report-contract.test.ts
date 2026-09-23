import { describe, expect, it } from 'vitest';
import { analyzeLocal } from './analyze';
import { financeInput } from './fixtures/finance';
import { asOf, baseInput, branch, id, saleId, tenant } from './fixtures/local';
import { buildReport } from './report';
import type { EvidenceRef, FindingDraft } from './types';

const evidence = (sourceId: string, evidenceId: string, field: string): EvidenceRef => ({
    sourceId,
    entity: 'movimientosStock',
    id: evidenceId,
    field,
    observedValue: field === 'syncFlag' ? 1 : '-1.00',
    capturedAt: 1_800_000_000_000,
    coverageStatus: 'COMPLETE',
});

function finding(localEvidence: EvidenceRef[]): FindingDraft {
    return {
        code: 'SYNC_FALSE_CONFIRMED',
        severity: 'CRITICAL',
        category: 'SYNC',
        entity: 'movimientosStock',
        ids: { movementId: id(30), productId: id(10), saleId: id(20) },
        sources: ['supabase', 'pc-a'],
        explanation: 'La confirmación local no coincide con la evidencia remota completa.',
        localEvidence,
        remoteEvidence: [evidence('supabase', id(30), 'delta')],
        missingEvidence: [],
        interpretedSyncState: 'FALSE_CONFIRMED',
        stage: 'UPLOAD',
        verificability: 'DISCREPANT',
        diagnosticRecommendation: 'Revisar la evidencia capturada sin modificar datos.',
    };
}

describe('T043 — contrato determinista del informe', () => {
    it('mantiene findingId, códigos, orden y JSON estructural al permutar filas de evidencia', () => {
        const first = evidence('pc-a', id(31), 'delta');
        const second = evidence('pc-a', id(30), 'syncFlag');

        const a = buildReport(baseInput(), [finding([first, second])]);
        const b = buildReport(baseInput(), [finding([second, first])]);

        expect(a).toEqual(b);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        expect(a.overall).toBe('FINDINGS_PRESENT');
        expect(a.findings[0]).toMatchObject({
            code: 'SYNC_FALSE_CONFIRMED',
            severity: 'CRITICAL',
            category: 'SYNC',
            interpretedSyncState: 'FALSE_CONFIRMED',
            stage: 'UPLOAD',
        });
        expect(a.findings[0].findingId).toBe(b.findings[0].findingId);
    });

    it('cada hallazgo conserva evidencia explícita o declara qué evidencia falta', () => {
        const report = buildReport(baseInput(), [{
            ...finding([]),
            remoteEvidence: [],
            missingEvidence: [],
            verificability: 'UNVERIFIABLE',
        }]);

        const item = report.findings[0];
        expect(item.localEvidence.length + item.remoteEvidence.length + item.missingEvidence.length).toBeGreaterThan(0);
        expect(['VERIFIED', 'DISCREPANT', 'UNVERIFIABLE']).toContain(item.verificability);
    });

    it('no cambia el informe al permutar filas equivalentes de una captura', () => {
        const first = financeInput();
        first.snapshots[0].records.devoluciones = [41, 42].map(number => ({
            id: id(number), negocioId: tenant, sucursalId: branch, sourceId: 'pc-a', observedAt: asOf,
            ventaId: saleId, monto: '10.00', fecha: asOf - number,
        }));
        const second = structuredClone(first);
        second.snapshots[0].records.devoluciones.reverse();

        expect(analyzeLocal(first)).toEqual(analyzeLocal(second));
    });
});
