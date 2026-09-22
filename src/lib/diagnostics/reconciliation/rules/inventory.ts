import { canProveAbsence, coverageFor, effectiveCoverage } from '../coverage';
import { addQuantities, normalizeQuantity } from '../normalize';
import type { FindingDraft, ObservedProduct, ObservedStockMovement, ReconciliationRequest, SourceSnapshot } from '../types';

function finding(snapshot: SourceSnapshot, code: FindingDraft['code'], severity: FindingDraft['severity'], verificability: FindingDraft['verificability'], productId: string, movementId: string | undefined, explanation: string, missingEvidence: string[]): FindingDraft {
    const coverage = coverageFor(snapshot.coverage, movementId ? 'movimientosStock' : 'productos');
    return { code, severity, category: 'INVENTORY', entity: movementId ? 'movimientosStock' : 'productos', ids: { productId, ...(movementId && { movementId }) }, sources: [snapshot.source.sourceId], explanation, localEvidence: movementId ? [{ sourceId: snapshot.source.sourceId, entity: 'movimientosStock', id: movementId, capturedAt: snapshot.capture.finishedAt, coverageStatus: coverage ? effectiveCoverage(coverage) : 'UNAVAILABLE' }] : [{ sourceId: snapshot.source.sourceId, entity: 'productos', id: productId, capturedAt: snapshot.capture.finishedAt, coverageStatus: coverage ? effectiveCoverage(coverage) : 'UNAVAILABLE' }], remoteEvidence: [], missingEvidence, verificability, diagnosticRecommendation: 'Comprobar conteo, secuencia causal y cobertura; no ajustar stock desde el diagnóstico.' };
}

function trustedExpected(product: ObservedProduct, movements: readonly ObservedStockMovement[], snapshot: SourceSnapshot, request: ReconciliationRequest): string | undefined {
    const coverage = coverageFor(snapshot.coverage, 'movimientosStock');
    if (!coverage || effectiveCoverage(coverage) !== 'COMPLETE') return undefined;
    if (request.hasta < snapshot.capture.finishedAt || (coverage.scope.hasta !== undefined && coverage.scope.hasta < snapshot.capture.finishedAt)) return undefined;
    if (request.sucursalId && product.sucursalId !== request.sucursalId) return undefined;
    const ordered = movements.filter(row => row.productoId === product.id);
    if (ordered.some(row => row.causalOrder === undefined)) return undefined;
    const ordinals = new Set(ordered.map(row => row.causalOrder));
    if (ordinals.size !== ordered.length) return undefined;
    const counts = ordered.filter(row => row.valorAbsoluto !== undefined).sort((a, b) => (a.causalOrder ?? 0) - (b.causalOrder ?? 0));
    const lastCount = counts.at(-1);
    if (!lastCount || !canProveAbsence(coverage, { negocioId: product.negocioId, sucursalId: product.sucursalId, fecha: lastCount.fecha })) return undefined;
    const after = ordered.filter(row => (row.causalOrder ?? -1) > (lastCount.causalOrder ?? -1)).sort((a, b) => (a.causalOrder ?? 0) - (b.causalOrder ?? 0));
    if (after.some(row => row.valorAbsoluto !== undefined)) return undefined;
    return addQuantities([lastCount.valorAbsoluto!, ...after.map(row => row.delta ?? '0')]);
}

export function analyzeInventory(snapshot: SourceSnapshot, request: ReconciliationRequest): FindingDraft[] {
    const findings: FindingDraft[] = [];
    const products = new Map(snapshot.records.productos.map(row => [row.id, row]));
    const productCoverage = coverageFor(snapshot.coverage, 'productos');
    const movementsByProduct = new Map<string, ObservedStockMovement[]>();
    for (const movement of snapshot.records.movimientosStock) {
        const group = movementsByProduct.get(movement.productoId) ?? []; group.push(movement); movementsByProduct.set(movement.productoId, group);
        if (!products.has(movement.productoId)) {
            const proven = canProveAbsence(productCoverage, { negocioId: movement.negocioId, sucursalId: movement.sucursalId, id: movement.productoId });
            findings.push(finding(snapshot, 'STOCK_PRODUCT_MISSING', proven ? 'ERROR' : 'WARNING', proven ? 'DISCREPANT' : 'UNVERIFIABLE', movement.productoId, movement.id, 'Movimiento de stock cuyo producto no aparece en la captura local.', proven ? [] : ['COMPLETE_PRODUCT_COVERAGE']));
        }
    }
    for (const product of snapshot.records.productos) {
        const moves = movementsByProduct.get(product.id) ?? [];
        const expected = trustedExpected(product, moves, snapshot, request);
        if (expected === undefined) {
            findings.push(finding(snapshot, 'STOCK_BASE_UNVERIFIABLE', 'INFO', 'UNVERIFIABLE', product.id, undefined, 'No hay base, secuencia causal y cobertura suficientes para reconstruir este stock.', ['TRUSTED_BASELINE', 'CAUSAL_ORDER', 'COMPLETE_MOVEMENT_HISTORY']));
        } else if (normalizeQuantity(product.stockMaterializado) !== expected) {
            findings.push(finding(snapshot, 'STOCK_MATERIALIZED_MISMATCH', 'ERROR', 'DISCREPANT', product.id, undefined, `Stock materializado ${product.stockMaterializado}; reconstrucción auditable ${expected}.`, []));
        }
        const groups = new Map<string, ObservedStockMovement[]>();
        for (const row of moves) if (row.referenciaOperacionId) {
            const key = [row.referenciaOperacionId, row.tipo, row.delta ?? '', row.valorAbsoluto ?? ''].join('|');
            const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
        }
        for (const group of groups.values()) if (new Set(group.map(row => row.id)).size > 1) {
            const verified = group.some(row => row.duplicateEffectVerified === true);
            findings.push(finding(snapshot, verified ? 'MOVEMENT_DOUBLE_APPLIED' : 'MOVEMENT_DUPLICATE_SUSPECTED', verified ? 'CRITICAL' : 'WARNING', verified ? 'DISCREPANT' : 'UNVERIFIABLE', product.id, group.map(row => row.id).sort()[0], verified ? 'Dos movimientos distintos tienen efecto duplicado demostrado.' : 'Referencias similares; no prueban por sí solas doble aplicación.', verified ? [] : ['DOUBLE_EFFECT_PROOF']));
        }
    }
    return findings;
}
