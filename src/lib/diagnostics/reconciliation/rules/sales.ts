import { canProveAbsence, coverageFor, effectiveCoverage } from '../coverage';
import { addQuantities, normalizeMoney, normalizeQuantity } from '../normalize';
import type { EntityName, FindingDraft, ObservedSale, ReconciliationRequest, SourceSnapshot } from '../types';

function moneyCents(value: string): bigint { return BigInt(normalizeMoney(value).replace('.', '')); }
function ref(snapshot: SourceSnapshot, entity: EntityName, id: string) {
    const coverage = coverageFor(snapshot.coverage, entity);
    return { sourceId: snapshot.source.sourceId, entity, id, capturedAt: snapshot.capture.finishedAt, coverageStatus: coverage ? effectiveCoverage(coverage) : 'UNAVAILABLE' as const };
}
function saleFinding(snapshot: SourceSnapshot, sale: ObservedSale, code: FindingDraft['code'], severity: FindingDraft['severity'], verificability: FindingDraft['verificability'], explanation: string, missingEvidence: string[]): FindingDraft {
    return { code, severity, category: 'SALE', entity: 'ventas', ids: { saleId: sale.id }, sources: [snapshot.source.sourceId], explanation, localEvidence: [ref(snapshot, 'ventas', sale.id)], remoteEvidence: [], missingEvidence, verificability, diagnosticRecommendation: 'Revisar la operación y obtener la evidencia faltante; no modificar datos desde el diagnóstico.' };
}

export function analyzeSales(snapshot: SourceSnapshot, request: ReconciliationRequest): FindingDraft[] {
    if (snapshot.source.negocioId !== request.negocioId) throw new Error('sale scope mismatch');
    const findings: FindingDraft[] = [];
    const sales = new Map(snapshot.records.ventas.map(row => [row.id, row]));
    const linesBySale = new Map<string, typeof snapshot.records.ventaDetalles>();
    for (const row of snapshot.records.ventaDetalles) {
        const group = linesBySale.get(row.ventaId) ?? []; group.push(row); linesBySale.set(row.ventaId, group);
    }
    const movesBySale = new Map<string, typeof snapshot.records.movimientosStock>();
    for (const row of snapshot.records.movimientosStock) if (row.referenciaOperacionId) {
        const group = movesBySale.get(row.referenciaOperacionId) ?? []; group.push(row); movesBySale.set(row.referenciaOperacionId, group);
    }
    const creditsBySale = new Map<string, typeof snapshot.records.transaccionesFiado>();
    for (const row of snapshot.records.transaccionesFiado) if (row.ventaId) {
        const group = creditsBySale.get(row.ventaId) ?? []; group.push(row); creditsBySale.set(row.ventaId, group);
    }
    const serialsBySale = new Map<string, typeof snapshot.records.seriales>();
    for (const row of snapshot.records.seriales) if (row.ventaId) {
        const group = serialsBySale.get(row.ventaId) ?? []; group.push(row); serialsBySale.set(row.ventaId, group);
    }
    const products = new Map(snapshot.records.productos.map(row => [row.id, row]));
    const refunds = new Set(snapshot.records.devoluciones.map(row => row.ventaId));
    const complete = (entity: EntityName) => { const c = coverageFor(snapshot.coverage, entity); return !!c && effectiveCoverage(c) === 'COMPLETE'; };

    for (const line of snapshot.records.ventaDetalles) if (!sales.has(line.ventaId)) {
        const proven = canProveAbsence(coverageFor(snapshot.coverage, 'ventas'), { negocioId: line.negocioId, sucursalId: line.sucursalId, id: line.ventaId });
        findings.push({ code: 'SALE_ORPHAN_LINE', severity: proven ? 'ERROR' : 'WARNING', category: 'SALE', entity: 'ventaDetalles', ids: { saleId: line.ventaId, operationId: line.id }, sources: [snapshot.source.sourceId], explanation: 'Línea sin venta observada en el ámbito capturado.', localEvidence: [ref(snapshot, 'ventaDetalles', line.id)], remoteEvidence: [], missingEvidence: proven ? [] : ['COMPLETE_SALE_ID_LOOKUP'], verificability: proven ? 'DISCREPANT' : 'UNVERIFIABLE', diagnosticRecommendation: 'Comprobar cobertura histórica de ventas y la identidad de la operación.' });
    }
    for (const sale of snapshot.records.ventas) {
        const lines = linesBySale.get(sale.id) ?? [];
        if (!lines.length) findings.push(saleFinding(snapshot, sale, 'SALE_MISSING_REQUIRED_EFFECT', complete('ventaDetalles') ? 'ERROR' : 'WARNING', complete('ventaDetalles') ? 'DISCREPANT' : 'UNVERIFIABLE', 'Venta sin líneas observadas; la causa no se infiere de la ausencia.', ['SALE_LINES']));
        if (sale.metodoPago === 'fiado') {
            const charges = (creditsBySale.get(sale.id) ?? []).filter(row => row.tipo === 'cargo');
            if (!charges.length || charges.reduce((sum, row) => sum + moneyCents(row.monto), BigInt(0)) !== moneyCents(sale.total)) {
                findings.push(saleFinding(snapshot, sale, 'SALE_MISSING_REQUIRED_EFFECT', complete('transaccionesFiado') ? 'ERROR' : 'WARNING', complete('transaccionesFiado') ? 'DISCREPANT' : 'UNVERIFIABLE', 'No se observa el cargo de fiado requerido por la venta.', ['CREDIT_CHARGE']));
            }
        }
        for (const line of lines) {
            const product = products.get(line.productoId);
            if (!product || product.eliminado) continue;
            const applied = (movesBySale.get(sale.id) ?? []).filter(row => row.productoId === line.productoId && row.tipo === 'venta');
            if (!applied.length || addQuantities(applied.map(row => row.delta ?? '0')) !== normalizeQuantity(`-${line.cantidad}`)) {
                const proven = line.stockEffectRequiredAtSale === true && complete('movimientosStock');
                findings.push(saleFinding(snapshot, sale, 'SALE_MISSING_REQUIRED_EFFECT', proven ? 'ERROR' : 'WARNING', proven ? 'DISCREPANT' : 'UNVERIFIABLE', proven ? 'El descuento local históricamente requerido no está respaldado por movimientos observados.' : 'No se observa descuento directo, pero falta la composición histórica para saber si esta línea consumía otro producto.', proven ? [`STOCK_EFFECT:${line.productoId}`] : [`COMPOSITION_HISTORY:${line.productoId}`]));
            }
            if (product.serializable && !refunds.has(sale.id) && !(serialsBySale.get(sale.id) ?? []).some(row => row.productoId === line.productoId)) {
                const proven = line.serialRequiredAtSale === true && complete('seriales');
                findings.push(saleFinding(snapshot, sale, 'SALE_MISSING_REQUIRED_EFFECT', proven ? 'ERROR' : 'WARNING', proven ? 'DISCREPANT' : 'UNVERIFIABLE', proven ? 'Serial históricamente requerido sin asociación observada.' : 'El producto es serializable hoy, pero no consta si lo era al venderse.', proven ? [`SERIAL_EFFECT:${line.productoId}`] : [`HISTORICAL_SERIAL_POLICY:${line.productoId}`]));
            }
        }
        if (lines.length && sale.historicalTotalFactsComplete === true && sale.historicalDiscount !== undefined && sale.historicalTax !== undefined && complete('ventaDetalles')) {
            const detailTotal = lines.reduce((sum, line) => sum + moneyCents(line.subtotal), BigInt(0));
            const expected = detailTotal - moneyCents(sale.historicalDiscount) + moneyCents(sale.historicalTax);
            if (expected !== moneyCents(sale.total)) findings.push(saleFinding(snapshot, sale, 'SALE_TOTAL_MISMATCH', 'ERROR', 'DISCREPANT', 'El total persistido difiere del reconstruido con hechos monetarios históricos completos.', []));
        } else if (lines.length) {
            findings.push(saleFinding(snapshot, sale, 'SALE_TOTAL_UNVERIFIABLE', 'INFO', 'UNVERIFIABLE', 'El total exacto no puede reconstruirse sin descuento e impuesto históricos completos.', ['HISTORICAL_DISCOUNT', 'HISTORICAL_TAX']));
        }
    }
    return findings;
}
