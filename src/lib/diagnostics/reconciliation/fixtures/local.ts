import { ENTITY_NAMES, type Coverage, type ReconciliationInput, type SnapshotRecords, type SourceSnapshot } from '../types';

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const tenant = id(1);
export const branch = id(2);
export const productId = id(10);
export const saleId = id(20);
export const sourceId = 'pc-a';
export const asOf = 1_800_000_000_000;

export function baseRecords(): SnapshotRecords {
    return { ventas: [], ventaDetalles: [], productos: [], movimientosStock: [], transaccionesFiado: [], seriales: [], devoluciones: [], cajas: [], cortesCaja: [], gastos: [], reparaciones: [], apartados: [], reportes: [] };
}
export function baseCoverage(status: Coverage['status'] = 'COMPLETE'): Coverage[] {
    return ENTITY_NAMES.map(entity => ({ entity, scope: { negocioId: tenant, desde: asOf - 60_000, hasta: asOf }, status, startedAt: asOf, finishedAt: asOf, rowsRead: 0, exhausted: status === 'COMPLETE', concurrentChangePossible: false }));
}
export function baseSnapshot(records: Partial<SnapshotRecords> = {}, coverage = baseCoverage()): SourceSnapshot {
    return { contractVersion: '1.0', source: { sourceId, kind: 'LOCAL', deviceLabel: 'PC A', negocioId: tenant, serverIdentityVerified: false }, capture: { startedAt: asOf, finishedAt: asOf, asOf, temporalConsistency: 'COHERENT', connectivityObserved: false }, coverage, records: { ...baseRecords(), ...records } };
}
export function baseInput(snapshot = baseSnapshot()): ReconciliationInput {
    return { contractVersion: '1.0', request: { negocioId: tenant, desde: asOf - 60_000, hasta: asOf, asOf, pendingThresholdMs: 300_000 }, snapshots: [snapshot] };
}
export function sale() {
    return { id: saleId, negocioId: tenant, sourceId, observedAt: asOf, fecha: asOf - 10_000, total: '100.00', metodoPago: 'efectivo', syncFlag: 0 as const };
}
export function line() {
    return { id: id(21), negocioId: tenant, sourceId, observedAt: asOf, ventaId: saleId, productoId: productId, cantidad: '1', precioUnitario: '100.00', subtotal: '100.00', syncFlag: 0 as const };
}
export function product(stockMaterializado = '4') {
    return { id: productId, negocioId: tenant, sourceId, observedAt: asOf, stockMaterializado, tipo: 'simple' as const, syncFlag: 1 as const };
}
export function movement() {
    return { id: id(30), negocioId: tenant, sourceId, observedAt: asOf, productoId: productId, delta: '-1', tipo: 'venta', referenciaOperacionId: saleId, fecha: asOf - 10_000, syncFlag: 0 as const };
}
