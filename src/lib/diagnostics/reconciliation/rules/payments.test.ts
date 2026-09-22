import { describe, expect, it } from 'vitest';
import { analyzePayments } from './payments';
import { asOf, baseInput, id, sale, sourceId, tenant } from '../fixtures/local';
import { blankFinanceSnapshot, payment } from '../fixtures/finance';

describe('recorded payment evidence', () => {
    it('proves a mixed split inconsistent with the persisted sale total using exact decimals', () => {
        const snapshot = blankFinanceSnapshot();
        snapshot.records.ventas = [{ ...sale(), sucursalId: snapshot.source.sucursalId, total: '100.00', metodoPago: 'mixto', montoEfectivo: '80.00', montoTransferencia: '30.00' }];
        expect(analyzePayments(snapshot, baseInput(snapshot).request).find(f => f.code === 'PAYMENT_CASH_MISMATCH')).toMatchObject({ severity: 'ERROR', verificability: 'DISCREPANT' });
    });
    it('accepts a matching fiado charge and partial Pro payments without inferring bank settlement', () => {
        const snapshot = blankFinanceSnapshot();
        snapshot.records.ventas = [{ ...sale(), sucursalId: snapshot.source.sucursalId, metodoPago: 'fiado', clienteId: id(70) }];
        snapshot.records.transaccionesFiado = [{ id: id(71), negocioId: tenant, sucursalId: snapshot.source.sucursalId, sourceId, observedAt: asOf, ventaId: sale().id, clienteId: id(70), tipo: 'cargo', monto: '100.00', fecha: asOf - 9_000 }];
        snapshot.records.reparaciones = [{ id: id(72), negocioId: tenant, sucursalId: snapshot.source.sucursalId, sourceId, observedAt: asOf, fecha: asOf - 20_000, total: '200.00', declaredPaid: '50.00', paymentHistoryComplete: true, pagos: [payment('50.00', 'tarjeta')] }];
        expect(analyzePayments(snapshot, baseInput(snapshot).request).some(f => f.code === 'PAYMENT_CASH_MISMATCH')).toBe(false);
    });
    it('compares a Z cut total with sales attributable to that cash window', () => {
        const snapshot = blankFinanceSnapshot();
        const cashId = id(75);
        snapshot.records.cajas = [{ id: cashId, negocioId: tenant, sucursalId: snapshot.source.sucursalId, sourceId, observedAt: asOf, estado: 'cerrada', fechaApertura: asOf - 50_000, fechaCierre: asOf - 1_000, montoApertura: '0.00' }];
        snapshot.records.ventas = [{ ...sale(), sucursalId: snapshot.source.sucursalId }];
        snapshot.records.cortesCaja = [{ id: id(76), negocioId: tenant, sucursalId: snapshot.source.sucursalId, sourceId, observedAt: asOf, cajaId: cashId, tipo: 'Z', fecha: asOf - 1_000, totalVentas: '90.00' }];
        expect(analyzePayments(snapshot, baseInput(snapshot).request).find(f => f.code === 'PAYMENT_CASH_MISMATCH')).toMatchObject({ entity: 'cortesCaja', severity: 'ERROR' });
    });
    it('never assumes a monetary refund from stock-only refund evidence', () => {
        const snapshot = blankFinanceSnapshot();
        snapshot.records.ventas = [{ ...sale(), sucursalId: snapshot.source.sucursalId }];
        snapshot.records.devoluciones = [{ id: id(73), negocioId: tenant, sourceId, observedAt: asOf, ventaId: sale().id, monto: '25.00', fecha: asOf - 5_000 }];
        expect(analyzePayments(snapshot, { ...baseInput(snapshot).request, sucursalId: snapshot.source.sucursalId }).find(f => f.code === 'REFUND_SETTLEMENT_UNVERIFIABLE')).toMatchObject({ verificability: 'UNVERIFIABLE' });
    });
});
