import { coverageFor, effectiveCoverage } from '../coverage';
import type { EntityName, FindingDraft, ReconciliationRequest, SourceSnapshot } from '../types';

export function analyzeLocalSync(snapshot: SourceSnapshot, request: ReconciliationRequest): FindingDraft[] {
    const findings: FindingDraft[] = [];
    const entries: { entity: EntityName; id: string; date?: number; syncFlag?: 0 | 1; productId?: string; saleId?: string }[] = [
        ...snapshot.records.ventas.map(row => ({ entity: 'ventas' as const, id: row.id, date: row.fecha, syncFlag: row.syncFlag, saleId: row.id })),
        ...snapshot.records.productos.map(row => ({ entity: 'productos' as const, id: row.id, date: row.fechaActualizacion, syncFlag: row.syncFlag, productId: row.id })),
        ...snapshot.records.movimientosStock.map(row => ({ entity: 'movimientosStock' as const, id: row.id, date: row.fecha, syncFlag: row.syncFlag, productId: row.productoId })),
    ];
    for (const row of entries) {
        if (row.syncFlag === undefined) continue;
        const aged = row.syncFlag === 0 && snapshot.capture.connectivityObserved === true && row.date !== undefined && request.asOf - row.date > request.pendingThresholdMs;
        const coverage = coverageFor(snapshot.coverage, row.entity);
        findings.push({
            code: row.syncFlag === 1 ? 'SYNC_REMOTE_UNVERIFIABLE' : aged ? 'SYNC_PENDING_AGED' : 'SYNC_PENDING',
            severity: row.syncFlag === 1 ? 'INFO' : aged ? 'WARNING' : 'INFO', category: 'SYNC', entity: row.entity,
            ids: { ...(row.productId && { productId: row.productId }), ...(row.saleId && { saleId: row.saleId }), ...(row.entity === 'movimientosStock' && { movementId: row.id }) },
            sources: [snapshot.source.sourceId],
            explanation: row.syncFlag === 1 ? 'Marca local de sincronizado sin evidencia remota independiente; aplicación remota desconocida.' : aged ? 'Operación local pendiente más allá del umbral diagnóstico con conectividad observada; no demuestra pérdida.' : 'Operación local pendiente de sincronización o verificación.',
            localEvidence: [{ sourceId: snapshot.source.sourceId, entity: row.entity, id: row.id, field: 'syncFlag', observedValue: row.syncFlag, capturedAt: snapshot.capture.finishedAt, coverageStatus: coverage ? effectiveCoverage(coverage) : 'UNAVAILABLE' }], remoteEvidence: [],
            missingEvidence: row.syncFlag === 1 ? ['REMOTE_RECEIPT'] : [], interpretedSyncState: row.syncFlag === 1 ? 'UNKNOWN' : aged ? 'PENDING_AGED' : 'PENDING',
            verificability: row.syncFlag === 1 ? 'UNVERIFIABLE' : 'VERIFIED', diagnosticRecommendation: 'Obtener lectura remota autorizada por ID en una fase separada; no reintentar desde el diagnóstico.',
        });
    }
    for (const product of snapshot.records.productos) {
        const evidence = product.pendingEditEvidence;
        if (product.syncFlag !== 0 || !evidence) continue;
        const lost = evidence.versionComparable && evidence.intendedValue !== evidence.currentValue && evidence.priorValue === evidence.currentValue;
        findings.push({ code: 'PRODUCT_PENDING_EDIT_CONFLICT', severity: lost ? 'CRITICAL' : 'WARNING', category: 'SYNC', entity: 'productos', ids: { productId: product.id }, sources: [snapshot.source.sourceId], explanation: lost ? 'Una edición pendiente comprobable ya no coincide con el valor local, que volvió al valor anterior.' : 'Edición pendiente con versiones insuficientes o no comparables; pérdida no demostrada.', localEvidence: [{ sourceId: snapshot.source.sourceId, entity: 'productos', id: product.id, capturedAt: snapshot.capture.finishedAt, coverageStatus: 'COMPLETE' }], remoteEvidence: [], missingEvidence: lost ? [] : ['COMPARABLE_EDIT_VERSION'], interpretedSyncState: 'UNKNOWN', verificability: lost ? 'DISCREPANT' : 'UNVERIFIABLE', diagnosticRecommendation: 'Conservar evidencia de versiones y revisar el conflicto; no modificar el producto desde el diagnóstico.' });
    }
    return findings;
}
