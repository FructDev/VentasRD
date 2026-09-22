import type { FindingDraft, ReconciliationRequest, SourceSnapshot } from '../types';

/** Cross-device concurrent/offline conflicts are warnings absent comparable causal versions. */
export function analyzeConflicts(a: SourceSnapshot, remote: SourceSnapshot | undefined, b: SourceSnapshot | undefined, request: ReconciliationRequest): FindingDraft[] {
    const findings: FindingDraft[] = [];
    if (!b) return findings;
    const bByProduct = new Map<string, typeof b.records.movimientosStock>();
    for (const move of b.records.movimientosStock) { const list = bByProduct.get(move.productoId) ?? []; list.push(move); bByProduct.set(move.productoId, list); }
    for (const move of a.records.movimientosStock) {
        if (move.negocioId !== request.negocioId || (request.sucursalId && move.sucursalId !== request.sucursalId) || !move.delta?.startsWith('-')) continue;
        for (const peer of bByProduct.get(move.productoId) ?? []) {
            if (peer.id === move.id || peer.referenciaOperacionId === move.referenciaOperacionId || !peer.delta?.startsWith('-') || peer.sucursalId !== move.sucursalId || (request.sucursalId && peer.sucursalId !== request.sucursalId)) continue;
            findings.push({ code: 'DEVICE_PROPAGATION_GAP', severity: 'WARNING', category: 'SYNC', entity: 'movimientosStock', ids: { productId: move.productoId, movementId: move.id }, sources: [a.source.sourceId, b.source.sourceId], stage: 'DEVICE_RECEIVE', explanation: 'Dos PCs registraron salidas distintas del mismo producto. Sin reserva global ni base causal comparable no se puede probar pérdida o sobreventa.', localEvidence: [{ sourceId: a.source.sourceId, entity: 'movimientosStock', id: move.id, capturedAt: a.capture.finishedAt, coverageStatus: 'PARTIAL' }, { sourceId: b.source.sourceId, entity: 'movimientosStock', id: peer.id, capturedAt: b.capture.finishedAt, coverageStatus: 'PARTIAL' }], remoteEvidence: [], missingEvidence: ['GLOBAL_RESERVATION_OR_CAUSAL_STOCK_BASELINE'], interpretedSyncState: 'UNKNOWN', verificability: 'UNVERIFIABLE', diagnosticRecommendation: 'Revisar ambas ventas y stock con evidencia causal; no corregir automáticamente.' });
            break;
        }
    }
    if (!remote) return findings;
    const remoteProducts = new Map(remote.records.productos.map(p => [p.id, p]));
    for (const product of a.records.productos) {
        if (product.syncFlag !== 0 || !product.pendingEditEvidence) continue;
        const remotelySeen = remoteProducts.get(product.id);
        if (!remotelySeen || remotelySeen.stockMaterializado === product.pendingEditEvidence.intendedValue) continue;
        findings.push({ code: 'PRODUCT_PENDING_EDIT_CONFLICT', severity: 'WARNING', category: 'SYNC', entity: 'productos', ids: { productId: product.id }, sources: [a.source.sourceId, remote.source.sourceId], stage: 'REMOTE_APPLY', explanation: 'La edición local pendiente difiere del valor remoto; sin versiones causales comparables no demuestra que se haya perdido.', localEvidence: [{ sourceId: a.source.sourceId, entity: 'productos', id: product.id, capturedAt: a.capture.finishedAt, coverageStatus: 'PARTIAL' }], remoteEvidence: [{ sourceId: remote.source.sourceId, entity: 'productos', id: remotelySeen.id, capturedAt: remote.capture.finishedAt, coverageStatus: 'PARTIAL' }], missingEvidence: ['COMPARABLE_EDIT_VERSION'], interpretedSyncState: 'UNKNOWN', verificability: 'UNVERIFIABLE', diagnosticRecommendation: 'Comparar versiones de edición fuera del diagnóstico; no sobrescribir stock.' });
    }
    return findings;
}
