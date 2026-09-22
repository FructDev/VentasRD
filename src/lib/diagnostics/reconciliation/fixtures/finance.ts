import { asOf, baseCoverage, baseInput, baseRecords, baseSnapshot, branch, id, sale, sourceId, tenant } from './local';
import type { ReconciliationInput, SourceSnapshot } from '../types';

export const otherBranch = id(3);
export const cashId = id(40);
export const reportId = id(50);

export function financeSnapshot(): SourceSnapshot {
    const snapshot = baseSnapshot({
        ventas: [{ ...sale(), sucursalId: branch, total: '100.00', metodoPago: 'efectivo' }],
        cajas: [{ id: cashId, negocioId: tenant, sucursalId: branch, sourceId, observedAt: asOf, estado: 'cerrada', fechaApertura: asOf - 50_000, fechaCierre: asOf - 1_000, montoApertura: '100.00', montoEsperado: '250.00', montoCierre: '150.00', diferencia: '-100.00' }],
        cortesCaja: [{ id: id(41), negocioId: tenant, sucursalId: branch, sourceId, observedAt: asOf, cajaId: cashId, tipo: 'Z', fecha: asOf - 1_000, montoEsperado: '250.00', montoContado: '150.00', diferencia: '-100.00' }],
        gastos: [], reparaciones: [], apartados: [], devoluciones: [],
        reportes: [{ id: reportId, negocioId: tenant, sucursalId: branch, sourceId, observedAt: asOf, tipo: 'ventas', total: '100.00', desde: asOf - 60_000, hasta: asOf, taxTotal: '18.00', taxFormula: 'CURRENT_PRODUCT_RATE', refundsIncluded: false }],
    });
    snapshot.source.sucursalId = branch;
    snapshot.coverage = baseCoverage().map(c => ({ ...c, scope: { ...c.scope, sucursalId: branch } }));
    return snapshot;
}

export function financeInput(snapshot = financeSnapshot()): ReconciliationInput {
    const input = baseInput(snapshot);
    input.request.sucursalId = branch;
    return input;
}

export function payment(monto: string, metodo: string, fecha = asOf - 10_000) { return { monto, metodo, fecha }; }
export function blankFinanceSnapshot(): SourceSnapshot {
    const snapshot = baseSnapshot({ ...baseRecords() });
    snapshot.source.sucursalId = branch;
    snapshot.coverage = baseCoverage().map(c => ({ ...c, scope: { ...c.scope, sucursalId: branch } }));
    return snapshot;
}
