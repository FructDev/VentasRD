import { describe, expect, it, vi } from 'vitest';
import { baseInput, id } from './fixtures/local';
import { buildReport } from './report';
import { renderReportHuman, renderReportJson } from './render';
import type { FindingDraft } from './types';

const draft: FindingDraft = {
    code: 'DEVICE_PROPAGATION_GAP',
    severity: 'ERROR',
    category: 'SYNC',
    entity: 'productos',
    ids: { operationId: id(20), productId: id(10) },
    sources: ['pc-a', 'supabase', 'pc-b'],
    explanation: 'La operación llegó al remoto, pero el producto de PC B sigue atrasado.',
    localEvidence: [{ sourceId: 'pc-b', entity: 'productos', id: id(10), field: 'stockMaterializado', observedValue: '5.00', capturedAt: 1_800_000_000_000, coverageStatus: 'COMPLETE' }],
    remoteEvidence: [{ sourceId: 'supabase', entity: 'movimientosStock', id: id(30), field: 'delta', observedValue: '-1.00', capturedAt: 1_800_000_000_000, coverageStatus: 'COMPLETE' }],
    missingEvidence: ['PC_B_RECEIVE_ACK'],
    interpretedSyncState: 'APPLIED_VERIFIED',
    stage: 'DEVICE_RECEIVE',
    verificability: 'DISCREPANT',
    diagnosticRecommendation: `UPDATE productos SET stock=4 WHERE id='${id(10)}'`,
};

describe('T045 — renderizado humano y JSON 1.0', () => {
    it('explica ámbito, fuente, operación, producto, etapa y evidencia faltante sin comandos de reparación', () => {
        const report = buildReport(baseInput(), [draft]);
        const human = renderReportHuman(report);

        expect(human).toContain(report.scope.negocioId);
        expect(human).toContain(String(report.asOf));
        expect(human).toContain('PC A');
        expect(human).toContain(id(20));
        expect(human).toContain(id(10));
        expect(human).toContain('DEVICE_RECEIVE');
        expect(human).toContain('PC_B_RECEIVE_ACK');
        expect(human).not.toMatch(/\bUPDATE\s+productos\b/i);
    });

    it('produce JSON versionado idéntico aunque cambie el reloj del proceso', () => {
        const report = buildReport(baseInput(), [draft]);
        vi.spyOn(Date, 'now').mockReturnValue(1);
        const first = renderReportJson(report);
        vi.mocked(Date.now).mockReturnValue(9_999_999_999_999);
        const second = renderReportJson(report);
        vi.restoreAllMocks();

        expect(first).toBe(second);
        expect(JSON.parse(first)).toMatchObject({ contractVersion: '1.0', asOf: report.asOf });
        expect(first).not.toContain('generatedAt');
    });
});
