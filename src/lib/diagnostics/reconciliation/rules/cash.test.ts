import { describe, expect, it } from 'vitest';
import { analyzeCash, calculateCashContext } from './cash';
import { asOf, baseInput, id, sale, sourceId, tenant } from '../fixtures/local';
import { blankFinanceSnapshot, cashId, otherBranch, payment } from '../fixtures/finance';

describe('current cash formula versus contextual cash', () => {
    it('characterizes sales, mixed cash, expenses and Pro cash exactly', () => {
        const snapshot = blankFinanceSnapshot();
        snapshot.records.cajas = [{ id: cashId, negocioId: tenant, sucursalId: snapshot.source.sucursalId, sourceId, observedAt: asOf, estado: 'abierta', fechaApertura: asOf - 50_000, montoApertura: '100.00' }];
        snapshot.records.ventas = [{ ...sale(), sucursalId: snapshot.source.sucursalId }, { ...sale(), id: id(22), sucursalId: snapshot.source.sucursalId, total: '50.00', metodoPago: 'mixto', montoEfectivo: '20.00', montoTransferencia: '30.00' }];
        snapshot.records.gastos = [{ id: id(42), negocioId: tenant, sucursalId: snapshot.source.sucursalId, sourceId, observedAt: asOf, monto: '15.00', fecha: asOf - 5_000, metodo: 'efectivo' }];
        snapshot.records.reparaciones = [{ id: id(43), negocioId: tenant, sucursalId: snapshot.source.sucursalId, sourceId, observedAt: asOf, fecha: asOf - 40_000, total: '80.00', declaredPaid: '30.00', pagos: [payment('30.00', 'efectivo')] }];
        snapshot.records.apartados = [{ id: id(44), negocioId: tenant, sucursalId: snapshot.source.sucursalId, sourceId, observedAt: asOf, fecha: asOf - 40_000, total: '60.00', declaredPaid: '10.00', abonos: [payment('10.00', 'efectivo')] }];
        const result = calculateCashContext(snapshot, snapshot.records.cajas[0], baseInput(snapshot).request);
        expect(result.observable).toMatchObject({ opening: '100.00', cashSales: '120.00', repairCash: '30.00', layawayCash: '10.00', cashExpenses: '15.00', expected: '245.00' });
        expect(result.contextualExpected).toBe('245.00');
    });
    it('detects that the observable date-only sales query included another branch', () => {
        const snapshot = blankFinanceSnapshot();
        snapshot.records.cajas = [{ id: cashId, negocioId: tenant, sucursalId: snapshot.source.sucursalId, sourceId, observedAt: asOf, estado: 'cerrada', fechaApertura: asOf - 50_000, fechaCierre: asOf - 1_000, montoApertura: '100.00', montoEsperado: '250.00' }];
        snapshot.records.ventas = [{ ...sale(), sucursalId: snapshot.source.sucursalId, total: '50.00' }, { ...sale(), id: id(22), sucursalId: otherBranch, total: '100.00' }];
        const findings = analyzeCash(snapshot, { ...baseInput(snapshot).request, sucursalId: snapshot.source.sucursalId });
        expect(findings.find(f => f.code === 'CASH_CONTEXT_MISMATCH')).toMatchObject({ severity: 'ERROR', verificability: 'DISCREPANT', ids: { cashId } });
    });
    it('does not invent an assignment when cash windows overlap', () => {
        const snapshot = blankFinanceSnapshot();
        snapshot.records.cajas = [
            { id: cashId, negocioId: tenant, sucursalId: snapshot.source.sucursalId, sourceId, observedAt: asOf, estado: 'abierta', fechaApertura: asOf - 50_000, montoApertura: '0.00' },
            { id: id(45), negocioId: tenant, sucursalId: snapshot.source.sucursalId, sourceId, observedAt: asOf, estado: 'abierta', fechaApertura: asOf - 40_000, montoApertura: '0.00' },
        ];
        snapshot.records.ventas = [{ ...sale(), sucursalId: snapshot.source.sucursalId }];
        const findings = analyzeCash(snapshot, { ...baseInput(snapshot).request, sucursalId: snapshot.source.sucursalId });
        expect(findings.some(f => f.code === 'CASH_CONTEXT_MISMATCH' && f.verificability === 'UNVERIFIABLE' && f.missingEvidence.includes('UNAMBIGUOUS_CASH_ASSIGNMENT'))).toBe(true);
    });
    it('reports a missing Z cut only with complete cut coverage', () => {
        const snapshot = blankFinanceSnapshot();
        snapshot.records.cajas = [{ id: cashId, negocioId: tenant, sucursalId: snapshot.source.sucursalId, sourceId, observedAt: asOf, estado: 'cerrada', fechaApertura: asOf - 50_000, fechaCierre: asOf - 1_000, montoApertura: '0.00' }];
        expect(analyzeCash(snapshot, baseInput(snapshot).request).some(f => f.code === 'CASH_CUT_INCOMPLETE' && f.severity === 'ERROR')).toBe(true);
    });
});
