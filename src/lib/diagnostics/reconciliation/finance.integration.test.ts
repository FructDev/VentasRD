import { describe, expect, it } from 'vitest';
import { analyzeReconciliation } from './analyze';
import { blankFinanceSnapshot, financeInput } from './fixtures/finance';
import { asOf, id, sale, sourceId, tenant } from './fixtures/local';

describe('read-only finance acceptance', () => {
    it('explains cash, refund and report limitations without changing any capture', () => {
        const input = financeInput();
        input.snapshots[0].records.ventas.push({ ...sale(), id: id(76), sucursalId: id(3), total: '100.00' });
        input.snapshots[0].records.devoluciones.push({ id: id(77), negocioId: tenant, sucursalId: input.request.sucursalId, sourceId, observedAt: asOf, ventaId: sale().id, monto: '10.00', fecha: asOf - 5_000 });
        const remote = blankFinanceSnapshot();
        remote.source = { sourceId: 'supabase', kind: 'REMOTE', negocioId: tenant, sucursalId: input.request.sucursalId, serverIdentityVerified: true };
        remote.capture.observedAfterSourceIds = ['pc-a'];
        input.snapshots.push(remote);
        const beforeLocal = JSON.stringify(input.snapshots[0]); const beforeRemote = JSON.stringify(input.snapshots[1]);
        const report = analyzeReconciliation(input);
        expect(report.findings.map(f => f.code)).toEqual(expect.arrayContaining(['CASH_CONTEXT_MISMATCH', 'REFUND_SETTLEMENT_UNVERIFIABLE', 'REPORT_TAX_UNVERIFIABLE', 'REPORT_REFUND_GAP']));
        expect(report.findings.some(f => f.code === 'REFUND_SETTLEMENT_UNVERIFIABLE' && f.verificability === 'UNVERIFIABLE')).toBe(true);
        expect(JSON.stringify(input.snapshots[0])).toBe(beforeLocal);
        expect(JSON.stringify(input.snapshots[1])).toBe(beforeRemote);
    });
});
