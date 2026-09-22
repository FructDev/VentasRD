import { describe, expect, it } from 'vitest';
import { analyzeSales } from './sales';
import { asOf, baseInput, baseSnapshot, id, line, movement, product, sale, tenant } from '../fixtures/local';

describe('ventas locales', () => {
    it('no acusa venta válida con línea y movimiento; total sin hechos fiscales es no verificable', () => {
        const snapshot = baseSnapshot({ ventas: [sale()], ventaDetalles: [line()], productos: [product()], movimientosStock: [movement()] });
        const findings = analyzeSales(snapshot, baseInput(snapshot).request);
        expect(findings.some(f => f.verificability === 'DISCREPANT')).toBe(false);
        expect(findings.some(f => f.code === 'SALE_TOTAL_UNVERIFIABLE')).toBe(true);
    });
    it('detecta línea huérfana solo con cobertura completa de ventas', () => {
        const orphan = { ...line(), ventaId: id(999) };
        const completeBase = baseSnapshot({ ventaDetalles: [orphan] });
        const complete = baseSnapshot({ ventaDetalles: [orphan] }, completeBase.coverage.map(c => c.entity === 'ventas' ? { ...c, scope: { negocioId: tenant, requestedIds: [orphan.ventaId] } } : c));
        expect(analyzeSales(complete, baseInput(complete).request).some(f => f.code === 'SALE_ORPHAN_LINE' && f.verificability === 'DISCREPANT')).toBe(true);
        const partial = baseSnapshot({ ventaDetalles: [orphan] }, complete.coverage.map(c => c.entity === 'ventas' ? { ...c, status: 'PARTIAL' as const } : c));
        expect(analyzeSales(partial, baseInput(partial).request).some(f => f.code === 'SALE_ORPHAN_LINE' && f.verificability === 'DISCREPANT')).toBe(false);
    });
    it('explica línea, movimiento, cargo fiado y serial obligatorios faltantes sin atribuir causa', () => {
        const s = { ...sale(), metodoPago: 'fiado', clienteId: id(40) };
        const p = { ...product(), serializable: true };
        const snapshot = baseSnapshot({ ventas: [s], ventaDetalles: [{ ...line(), stockEffectRequiredAtSale: true, serialRequiredAtSale: true }], productos: [p] });
        const findings = analyzeSales(snapshot, baseInput(snapshot).request);
        expect(findings.filter(f => f.code === 'SALE_MISSING_REQUIRED_EFFECT').length).toBeGreaterThanOrEqual(3);
        expect(findings.every(f => f.ids.saleId === s.id || f.ids.saleId === undefined)).toBe(true);
    });
    it('solo compara total exacto con hechos históricos completos', () => {
        const s = { ...sale(), historicalTotalFactsComplete: true, historicalDiscount: '0.00', historicalTax: '0.00' };
        const good = baseSnapshot({ ventas: [s], ventaDetalles: [line()], productos: [product()], movimientosStock: [movement()] });
        expect(analyzeSales(good, baseInput(good).request).some(f => f.code === 'SALE_TOTAL_MISMATCH')).toBe(false);
        const bad = baseSnapshot({ ventas: [{ ...s, total: '99.00' }], ventaDetalles: [line()], productos: [product()], movimientosStock: [movement()] });
        expect(analyzeSales(bad, baseInput(bad).request).some(f => f.code === 'SALE_TOTAL_MISMATCH' && f.verificability === 'DISCREPANT')).toBe(true);
        const noHistory = baseSnapshot({ ventas: [{ ...s, historicalTotalFactsComplete: false }], ventaDetalles: [line()], productos: [product()], movimientosStock: [movement()] });
        expect(analyzeSales(noHistory, baseInput(noHistory).request).some(f => f.code === 'SALE_TOTAL_MISMATCH')).toBe(false);
    });
    it('no considera la purga de detalles como prueba de venta incompleta', () => {
        const snap = baseSnapshot({ ventas: [sale()] });
        const coverage = snap.coverage.map(c => c.entity === 'ventaDetalles' ? { ...c, status: 'PARTIAL' as const, retentionHorizon: asOf - 30_000 } : c);
        const partial = baseSnapshot({ ventas: [sale()] }, coverage);
        expect(analyzeSales(partial, baseInput(partial).request).some(f => f.code === 'SALE_MISSING_REQUIRED_EFFECT' && f.verificability === 'DISCREPANT')).toBe(false);
        expect(tenant).toBe(sale().negocioId);
    });
});
