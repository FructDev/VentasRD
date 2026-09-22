import { coverageFor, effectiveCoverage } from '../coverage';
import type { EntityName, FindingDraft, ReconciliationRequest, SourceSnapshot } from '../types';
import { moneyEqual, sumMoney } from './money';
import { calculateCashContext } from './cash';

function scoped(value: { negocioId: string; sucursalId?: string }, request: ReconciliationRequest): boolean {
    return value.negocioId === request.negocioId && (!request.sucursalId || value.sucursalId === request.sucursalId);
}
function evidence(snapshot: SourceSnapshot, entity: EntityName, id: string, field?: string, observedValue?: string) {
    const coverage = coverageFor(snapshot.coverage, entity);
    return { sourceId: snapshot.source.sourceId, entity, id, ...(field && { field }), ...(observedValue !== undefined && { observedValue }), capturedAt: snapshot.capture.finishedAt, coverageStatus: coverage ? effectiveCoverage(coverage) : 'UNAVAILABLE' as const };
}
function mismatch(snapshot: SourceSnapshot, entity: EntityName, id: string, explanation: string, ids: FindingDraft['ids'], verified: boolean, missingEvidence: string[] = []): FindingDraft {
    return { code: 'PAYMENT_CASH_MISMATCH', severity: verified ? 'ERROR' : 'WARNING', category: 'PAYMENT', entity, ids, sources: [snapshot.source.sourceId], explanation, localEvidence: [evidence(snapshot, entity, id)], remoteEvidence: [], missingEvidence, verificability: verified ? 'DISCREPANT' : 'UNVERIFIABLE', diagnosticRecommendation: 'Revisar venta, método, desglose y registro de pago; no ajustar importes desde el diagnóstico.' };
}

export function analyzePayments(snapshot: SourceSnapshot, request: ReconciliationRequest): FindingDraft[] {
    const findings: FindingDraft[] = [];
    for (const sale of snapshot.records.ventas) {
        if (!scoped(sale, request)) continue;
        if (sale.metodoPago === 'mixto') {
            if (sale.montoEfectivo === undefined || sale.montoTransferencia === undefined) findings.push(mismatch(snapshot, 'ventas', sale.id, 'La venta mixta no conserva el desglose completo de efectivo y transferencia.', { saleId: sale.id }, false, ['COMPLETE_MIXED_PAYMENT_SPLIT']));
            else {
                const split = sumMoney([sale.montoEfectivo, sale.montoTransferencia]);
                if (!moneyEqual(split, sale.total)) findings.push(mismatch(snapshot, 'ventas', sale.id, `El desglose mixto suma ${split}, distinto del total persistido ${sale.total}.`, { saleId: sale.id }, true));
            }
        }
        if (sale.metodoPago !== 'fiado') continue;
        const charges = snapshot.records.transaccionesFiado.filter(row => scoped(row, request) && row.ventaId === sale.id && row.tipo === 'cargo');
        const chargeTotal = sumMoney(charges.map(row => row.monto));
        if (moneyEqual(chargeTotal, sale.total)) continue;
        const coverage = coverageFor(snapshot.coverage, 'transaccionesFiado'); const complete = coverage ? effectiveCoverage(coverage) === 'COMPLETE' : false;
        findings.push(mismatch(snapshot, 'transaccionesFiado', charges[0]?.id ?? sale.id, complete ? `La venta fiada totaliza ${sale.total}, pero los cargos persistidos totalizan ${chargeTotal}.` : 'No hay cobertura suficiente para comparar la venta fiada con sus cargos.', { saleId: sale.id }, complete, complete ? [] : ['COMPLETE_CREDIT_TRANSACTION_COVERAGE']));
    }
    for (const repair of snapshot.records.reparaciones) {
        if (!scoped(repair, request) || repair.declaredPaid === undefined || repair.paymentHistoryComplete !== true) continue;
        const sum = sumMoney(repair.pagos.map(p => p.monto));
        if (!moneyEqual(sum, repair.declaredPaid)) findings.push(mismatch(snapshot, 'reparaciones', repair.id, `Los pagos de reparación suman ${sum}, distinto del abonado persistido ${repair.declaredPaid}.`, { operationId: repair.id }, true));
    }
    for (const layaway of snapshot.records.apartados) {
        if (!scoped(layaway, request) || layaway.declaredPaid === undefined || layaway.paymentHistoryComplete !== true) continue;
        const sum = sumMoney(layaway.abonos.map(p => p.monto));
        if (!moneyEqual(sum, layaway.declaredPaid)) findings.push(mismatch(snapshot, 'apartados', layaway.id, `Los abonos del apartado suman ${sum}, distinto del abonado persistido ${layaway.declaredPaid}.`, { operationId: layaway.id }, true));
    }
    for (const refund of snapshot.records.devoluciones) {
        const linkedSale = snapshot.records.ventas.find(sale => sale.id === refund.ventaId);
        const refundInScope = refund.negocioId === request.negocioId && (!request.sucursalId || refund.sucursalId === request.sucursalId || linkedSale?.sucursalId === request.sucursalId);
        if (!refundInScope || refund.settlementMethod) continue;
        findings.push({ code: 'REFUND_SETTLEMENT_UNVERIFIABLE', severity: 'WARNING', category: 'CASH', entity: 'devoluciones', ids: { saleId: refund.ventaId, refundId: refund.id }, sources: [snapshot.source.sourceId], explanation: 'La devolución conserva importe y efectos de inventario, pero no el método ni la evidencia de liquidación monetaria.', localEvidence: [evidence(snapshot, 'devoluciones', refund.id, 'monto', refund.monto)], remoteEvidence: [], missingEvidence: ['REFUND_SETTLEMENT_METHOD', 'REFUND_CASH_OR_BANK_EVIDENCE'], verificability: 'UNVERIFIABLE', diagnosticRecommendation: 'Obtener evidencia del reembolso por separado; no asumir salida de efectivo ni liquidación bancaria.' });
    }
    for (const cut of snapshot.records.cortesCaja) {
        if (!scoped(cut, request) || cut.tipo !== 'Z' || cut.totalVentas === undefined) continue;
        const cash = snapshot.records.cajas.find(row => row.id === cut.cajaId && scoped(row, request));
        if (!cash || cash.fechaApertura < request.desde || (cash.fechaCierre ?? request.asOf) > request.hasta) continue;
        const contextualTotal = calculateCashContext(snapshot, cash, request).contextualSalesTotal;
        if (contextualTotal !== undefined && !moneyEqual(contextualTotal, cut.totalVentas)) findings.push(mismatch(snapshot, 'cortesCaja', cut.id, `El corte registra ventas por ${cut.totalVentas}, pero las ventas atribuibles al turno totalizan ${contextualTotal}.`, { cashId: cash.id, operationId: cut.id }, true));
    }
    return findings;
}
