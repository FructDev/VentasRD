import { canProveAbsence, coverageFor, effectiveCoverage } from '../coverage';
import type { EntityName, FindingDraft, ReconciliationRequest, SourceSnapshot } from '../types';

function evidence(snapshot: SourceSnapshot, entity: EntityName, id: string, field?: string, observedValue?: string | number | boolean) {
    const coverage = coverageFor(snapshot.coverage, entity);
    return { sourceId: snapshot.source.sourceId, entity, id, ...(field && { field }), ...(observedValue !== undefined && { observedValue }), capturedAt: snapshot.capture.finishedAt, coverageStatus: coverage ? effectiveCoverage(coverage) : 'UNAVAILABLE' as const };
}
function sameScope(a: { negocioId: string; sucursalId?: string }, b: { negocioId: string; sucursalId?: string }): boolean { return a.negocioId === b.negocioId && a.sucursalId === b.sucursalId; }
function observedAfter(later: SourceSnapshot, earlier: SourceSnapshot): boolean { return later.capture.observedAfterSourceIds?.includes(earlier.source.sourceId) === true; }
function rowIsScoped(row: { negocioId: string; sucursalId?: string }, request: ReconciliationRequest): boolean { return row.negocioId === request.negocioId && (!request.sucursalId || row.sucursalId === request.sucursalId); }

export function analyzePropagation(a: SourceSnapshot, remote: SourceSnapshot | undefined, b: SourceSnapshot | undefined, request: ReconciliationRequest): FindingDraft[] {
    const findings: FindingDraft[] = [];
    if (!remote) return findings;
    const remoteMovements = new Map(remote.records.movimientosStock.filter(row => rowIsScoped(row, request)).map(row => [row.id, row]));
    const bMovements = new Map(b?.records.movimientosStock.filter(row => rowIsScoped(row, request)).map(row => [row.id, row]) ?? []);
    const remoteSales = new Map(remote.records.ventas.filter(row => rowIsScoped(row, request)).map(row => [row.id, row]));
    const entries = [
        ...a.records.ventas.filter(row => rowIsScoped(row, request)).map(row => ({ entity: 'ventas' as const, id: row.id, productId: undefined as string | undefined, saleId: row.id, date: row.fecha, syncFlag: row.syncFlag })),
        ...a.records.movimientosStock.filter(row => rowIsScoped(row, request)).map(row => ({ entity: 'movimientosStock' as const, id: row.id, productId: row.productoId, saleId: row.referenciaOperacionId, date: row.fecha, syncFlag: row.syncFlag })),
    ];
    for (const row of entries) {
        if (row.syncFlag === undefined || row.syncFlag === 0) continue; // local pending upload is reported by US1
        const remoteRow = row.entity === 'ventas' ? remoteSales.get(row.id) : remoteMovements.get(row.id);
        const remoteCoverage = coverageFor(remote.coverage, row.entity);
        const ids = { ...(row.saleId && { saleId: row.saleId }), ...(row.productId && { productId: row.productId }), ...(row.entity === 'movimientosStock' && { movementId: row.id }) };
        const localEvidence = [evidence(a, row.entity, row.id, 'syncFlag', row.syncFlag)];
        if (!remoteRow) {
            const absenceProven = remote.source.serverIdentityVerified === true && sameScope(a.source, remote.source) && observedAfter(remote, a)
                && remote.capture.temporalConsistency !== 'UNKNOWN'
                && canProveAbsence(remoteCoverage, { negocioId: request.negocioId, sucursalId: request.sucursalId, id: row.id, fecha: row.date });
            findings.push({ code: absenceProven ? 'SYNC_FALSE_CONFIRMED' : 'SYNC_REMOTE_UNVERIFIABLE', severity: absenceProven ? 'CRITICAL' : 'INFO', category: 'SYNC', entity: row.entity, ids, sources: [a.source.sourceId, remote.source.sourceId], stage: 'REMOTE_APPLY', explanation: absenceProven ? 'Marca local sync=1, pero el ID no existe en una lectura remota autorizada, completa y posterior a PC A.' : 'La marca local sync=1 no prueba aplicación remota; falta cobertura autorizada, completa o secuencia de captura confiable.', localEvidence, remoteEvidence: remoteCoverage ? [evidence(remote, row.entity, row.id)] : [], missingEvidence: absenceProven ? [] : ['AUTHORIZED_COMPLETE_REMOTE_ID_LOOKUP', 'REMOTE_CAPTURE_AFTER_PC_A'], interpretedSyncState: absenceProven ? 'FALSE_CONFIRMED' : 'UNKNOWN', verificability: absenceProven ? 'DISCREPANT' : 'UNVERIFIABLE', diagnosticRecommendation: 'Revisar evidencia y logs de sincronización; no reparar ni reintentar automáticamente.' });
            continue;
        }
        if (!b || row.entity !== 'movimientosStock') continue;
        const bRow = bMovements.get(row.id);
        if (bRow) {
            const remoteProduct = remote.records.productos.find(p => p.id === row.productId && rowIsScoped(p, request));
            const bProduct = b.records.productos.find(p => p.id === row.productId && rowIsScoped(p, request));
            const comparable = observedAfter(b, remote) && sameScope(remote.source, b.source) && remoteProduct && bProduct && effectiveCoverage(coverageFor(remote.coverage, 'productos')!) === 'COMPLETE' && effectiveCoverage(coverageFor(b.coverage, 'productos')!) === 'COMPLETE';
            if (comparable && remoteProduct.stockMaterializado !== bProduct.stockMaterializado) {
                findings.push({ code: 'DEVICE_PROPAGATION_GAP', severity: 'WARNING', category: 'SYNC', entity: 'productos', ids, sources: [remote.source.sourceId, b.source.sourceId], stage: 'DEVICE_UPDATE', explanation: 'PC B contiene el movimiento, pero el stock materializado difiere de la lectura remota de la misma sucursal.', localEvidence: [evidence(b, 'productos', bProduct.id)], remoteEvidence: [evidence(remote, 'productos', remoteProduct.id)], missingEvidence: ['CAUSAL_STOCK_BASELINE'], interpretedSyncState: 'APPLIED_VERIFIED', verificability: 'UNVERIFIABLE', diagnosticRecommendation: 'Verificar base y orden causal antes de atribuir una pérdida de stock.' });
            }
            continue;
        }
        const bCoverage = coverageFor(b.coverage, 'movimientosStock');
        const bAbsence = observedAfter(b, remote) && sameScope(remote.source, b.source) && canProveAbsence(bCoverage, { negocioId: request.negocioId, sucursalId: request.sucursalId, id: row.id, fecha: row.date });
        findings.push({ code: 'DEVICE_PROPAGATION_GAP', severity: bAbsence ? 'WARNING' : 'INFO', category: 'SYNC', entity: 'movimientosStock', ids, sources: [a.source.sourceId, remote.source.sourceId, b.source.sourceId], stage: 'DEVICE_RECEIVE', explanation: bAbsence ? 'Movimiento aplicado remotamente, pero ausente en una captura posterior y completa de PC B; recepción atrasada al momento observado.' : 'Movimiento remoto presente, pero falta evidencia suficiente para concluir si PC B ya lo recibió.', localEvidence: [evidence(a, 'movimientosStock', row.id), evidence(b, 'movimientosStock', row.id)], remoteEvidence: [evidence(remote, 'movimientosStock', row.id)], missingEvidence: bAbsence ? [] : ['PC_B_CAPTURE_AFTER_REMOTE', 'COMPLETE_PC_B_ID_COVERAGE'], interpretedSyncState: 'APPLIED_VERIFIED', verificability: bAbsence ? 'DISCREPANT' : 'UNVERIFIABLE', diagnosticRecommendation: 'Revisar ventana de actualización de PC B sin disparar sincronización desde el diagnóstico.' });
    }
    return findings;
}
