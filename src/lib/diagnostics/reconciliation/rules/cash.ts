import { coverageFor, effectiveCoverage } from '../coverage';
import type { FindingDraft, ObservedCashRegister, ReconciliationRequest, SourceSnapshot } from '../types';
import { subtractMoney, sumMoney, moneyEqual } from './money';

export interface CashFormulaParts {
    opening: string; cashSales: string; repairCash: string; layawayCash: string; cashExpenses: string; expected: string;
}
export interface CashContextResult { observable: CashFormulaParts; persistedExpected?: string; contextualExpected?: string; contextualSalesTotal?: string; ambiguousOperationIds: string[] }

function within(date: number, cash: ObservedCashRegister, request: ReconciliationRequest): boolean {
    const end = Math.min(cash.fechaCierre ?? request.asOf, request.asOf);
    return date > cash.fechaApertura && date <= end;
}
function branchMatches(value: { sucursalId?: string }, cash: ObservedCashRegister, request: ReconciliationRequest): boolean {
    const expected = cash.sucursalId ?? request.sucursalId;
    return expected ? value.sucursalId === expected : value.sucursalId === undefined;
}
function cashCandidates(snapshot: SourceSnapshot, value: { negocioId: string; sucursalId?: string }, date: number, request: ReconciliationRequest): ObservedCashRegister[] {
    return snapshot.records.cajas.filter(cash => cash.negocioId === value.negocioId && branchMatches(value, cash, request) && within(date, cash, request));
}
function cashFromSale(sale: SourceSnapshot['records']['ventas'][number]): string {
    return sale.metodoPago === 'efectivo' ? sale.total : sale.metodoPago === 'mixto' ? sale.montoEfectivo ?? '0.00' : '0.00';
}
function parts(opening: string, sales: string[], repairs: string[], layaways: string[], expenses: string[]): CashFormulaParts {
    const cashSales = sumMoney(sales); const repairCash = sumMoney(repairs); const layawayCash = sumMoney(layaways); const cashExpenses = sumMoney(expenses);
    return { opening, cashSales, repairCash, layawayCash, cashExpenses, expected: subtractMoney(sumMoney([opening, cashSales, repairCash, layawayCash]), cashExpenses) };
}

/** Characterizes CajaModal's observable formula separately from attributable records. */
export function calculateCashContext(snapshot: SourceSnapshot, cash: ObservedCashRegister, request: ReconciliationRequest): CashContextResult {
    const opening = cash.montoApertura ?? '0.00';
    // Current behavior: sales are selected by opening time alone; the other queries use business/time, not a cash-register ID.
    const observableSales = snapshot.records.ventas.filter(row => within(row.fecha, cash, request)).map(cashFromSale);
    const observableRepairs = snapshot.records.reparaciones.filter(row => row.negocioId === cash.negocioId).flatMap(row => row.pagos.filter(p => within(p.fecha, cash, request) && p.metodo === 'efectivo').map(p => p.monto));
    const observableLayaways = snapshot.records.apartados.filter(row => row.negocioId === cash.negocioId).flatMap(row => row.abonos.filter(p => within(p.fecha, cash, request) && p.metodo === 'efectivo').map(p => p.monto));
    const observableExpenses = snapshot.records.gastos.filter(row => row.negocioId === cash.negocioId && !row.eliminado && row.metodo === 'efectivo' && row.fecha >= cash.fechaApertura && row.fecha <= (cash.fechaCierre ?? request.asOf)).map(row => row.monto);

    const ambiguous = new Set<string>();
    const assigned = <T extends { id: string; negocioId: string; sucursalId?: string }>(row: T, date: number): boolean => {
        if (row.negocioId !== cash.negocioId || !branchMatches(row, cash, request)) return false;
        const candidates = cashCandidates(snapshot, row, date, request);
        if (candidates.length !== 1) { if (within(date, cash, request)) ambiguous.add(row.id); return false; }
        return candidates[0].id === cash.id;
    };
    const contextualSales = snapshot.records.ventas.filter(row => assigned(row, row.fecha)).map(cashFromSale);
    const contextualRepairs: string[] = [];
    for (const row of snapshot.records.reparaciones) for (const [index, payment] of row.pagos.entries()) if (payment.metodo === 'efectivo' && assigned({ ...row, id: `${row.id}:p${index}` }, payment.fecha)) contextualRepairs.push(payment.monto);
    const contextualLayaways: string[] = [];
    for (const row of snapshot.records.apartados) for (const [index, payment] of row.abonos.entries()) if (payment.metodo === 'efectivo' && assigned({ ...row, id: `${row.id}:a${index}` }, payment.fecha)) contextualLayaways.push(payment.monto);
    const contextualExpenses = snapshot.records.gastos.filter(row => !row.eliminado && row.metodo === 'efectivo' && assigned(row, row.fecha)).map(row => row.monto);
    const observable = parts(opening, observableSales, observableRepairs, observableLayaways, observableExpenses);
    const contextual = parts(opening, contextualSales, contextualRepairs, contextualLayaways, contextualExpenses);
    return { observable, ...(cash.montoEsperado !== undefined && { persistedExpected: cash.montoEsperado }), contextualExpected: ambiguous.size ? undefined : contextual.expected, contextualSalesTotal: ambiguous.size ? undefined : sumMoney(snapshot.records.ventas.filter(row => assigned(row, row.fecha)).map(row => row.total)), ambiguousOperationIds: [...ambiguous].sort() };
}

function cashEvidence(snapshot: SourceSnapshot, cash: ObservedCashRegister, field?: string, observedValue?: string) {
    const coverage = coverageFor(snapshot.coverage, 'cajas');
    return { sourceId: snapshot.source.sourceId, entity: 'cajas' as const, id: cash.id, ...(field && { field }), ...(observedValue !== undefined && { observedValue }), capturedAt: snapshot.capture.finishedAt, coverageStatus: coverage ? effectiveCoverage(coverage) : 'UNAVAILABLE' as const };
}

export function analyzeCash(snapshot: SourceSnapshot, request: ReconciliationRequest): FindingDraft[] {
    const findings: FindingDraft[] = [];
    const cashRows = snapshot.records.cajas.filter(cash => cash.negocioId === request.negocioId && (!request.sucursalId || cash.sucursalId === request.sucursalId) && cash.fechaApertura <= request.hasta && (cash.fechaCierre ?? request.asOf) >= request.desde);
    for (const cash of cashRows) {
        const context = calculateCashContext(snapshot, cash, request);
        const wholeWindowCovered = cash.fechaApertura >= request.desde && (cash.fechaCierre ?? request.asOf) <= request.hasta;
        if (!wholeWindowCovered) {
            findings.push({ code: 'CASH_CONTEXT_MISMATCH', severity: 'INFO', category: 'CASH', entity: 'cajas', ids: { cashId: cash.id }, sources: [snapshot.source.sourceId], explanation: 'La captura no cubre la ventana completa de apertura/cierre; el esperado de caja no puede reconstruirse.', localEvidence: [cashEvidence(snapshot, cash)], remoteEvidence: [], missingEvidence: ['COMPLETE_CASH_WINDOW'], verificability: 'UNVERIFIABLE', diagnosticRecommendation: 'Capturar el turno completo; no completar operaciones faltantes con valores actuales.' });
        } else if (context.ambiguousOperationIds.length) {
            findings.push({ code: 'CASH_CONTEXT_MISMATCH', severity: 'WARNING', category: 'CASH', entity: 'cajas', ids: { cashId: cash.id }, sources: [snapshot.source.sourceId], explanation: `La atribución a esta caja es ambigua para ${context.ambiguousOperationIds.length} operación(es); existen ventanas superpuestas o falta vínculo de caja.`, localEvidence: [cashEvidence(snapshot, cash)], remoteEvidence: [], missingEvidence: ['UNAMBIGUOUS_CASH_ASSIGNMENT'], verificability: 'UNVERIFIABLE', diagnosticRecommendation: 'Revisar caja, sucursal, ventana y vínculo disponible; no reasignar ni corregir cifras desde el diagnóstico.' });
        } else if (context.contextualExpected && !moneyEqual(context.persistedExpected ?? context.observable.expected, context.contextualExpected)) {
            const observed = context.persistedExpected ?? context.observable.expected;
            findings.push({ code: 'CASH_CONTEXT_MISMATCH', severity: 'ERROR', category: 'CASH', entity: 'cajas', ids: { cashId: cash.id }, sources: [snapshot.source.sourceId], explanation: `La cifra observable/persistida es ${observed}; el subconjunto atribuible por negocio, sucursal y turno produce ${context.contextualExpected}.`, localEvidence: [cashEvidence(snapshot, cash, 'montoEsperadoObservable', observed), cashEvidence(snapshot, cash, 'montoEsperadoContextual', context.contextualExpected)], remoteEvidence: [], missingEvidence: [], verificability: 'DISCREPANT', diagnosticRecommendation: 'Revisar las operaciones fuera de contexto; no modificar el cierre ni la caja.' });
        }
        if (cash.estado !== 'cerrada' || cash.fechaCierre === undefined || cash.fechaCierre < request.desde || cash.fechaCierre > request.hasta) continue;
        const zCut = snapshot.records.cortesCaja.some(cut => cut.cajaId === cash.id && cut.tipo === 'Z');
        if (zCut) continue;
        const coverage = coverageFor(snapshot.coverage, 'cortesCaja'); const proven = coverage ? effectiveCoverage(coverage) === 'COMPLETE' : false;
        findings.push({ code: 'CASH_CUT_INCOMPLETE', severity: proven ? 'ERROR' : 'INFO', category: 'CASH', entity: 'cortesCaja', ids: { cashId: cash.id }, sources: [snapshot.source.sourceId], explanation: proven ? 'La caja está cerrada y la cobertura completa no contiene un corte Z vinculado.' : 'La caja está cerrada, pero la cobertura no permite verificar si existe el corte Z.', localEvidence: [cashEvidence(snapshot, cash)], remoteEvidence: [], missingEvidence: proven ? [] : ['COMPLETE_CASH_CUT_COVERAGE'], verificability: proven ? 'DISCREPANT' : 'UNVERIFIABLE', diagnosticRecommendation: 'Comprobar el corte existente; no generarlo ni cerrar la caja desde el diagnóstico.' });
    }
    return findings;
}
