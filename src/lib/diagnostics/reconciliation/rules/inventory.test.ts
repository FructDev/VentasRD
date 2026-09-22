import { describe, expect, it } from 'vitest';
import { analyzeInventory } from './inventory';
import { asOf, baseInput, baseSnapshot, id, movement, product, productId, sourceId, tenant } from '../fixtures/local';

describe('stock local', () => {
    it('verifica conteo absoluto y delta con orden causal explícito', () => {
        const count = { ...movement(), id: id(31), tipo: 'conteo', valorAbsoluto: '5', delta: '0', causalOrder: 1, fecha: asOf - 20_000 };
        const saleMovement = { ...movement(), causalOrder: 2 };
        const snapshot = baseSnapshot({ productos: [product('4')], movimientosStock: [count, saleMovement] });
        const findings = analyzeInventory(snapshot, baseInput(snapshot).request);
        expect(findings.some(f => f.code === 'STOCK_BASE_UNVERIFIABLE' || f.code === 'STOCK_MATERIALIZED_MISMATCH')).toBe(false);
    });
    it('detecta diferencia materializada solo con base, historial y orden completos', () => {
        const count = { ...movement(), id: id(31), tipo: 'conteo', valorAbsoluto: '5', delta: '0', causalOrder: 1, fecha: asOf - 20_000 };
        const snapshot = baseSnapshot({ productos: [product('3')], movimientosStock: [count, { ...movement(), causalOrder: 2 }] });
        expect(analyzeInventory(snapshot, baseInput(snapshot).request).some(f => f.code === 'STOCK_MATERIALIZED_MISMATCH' && f.verificability === 'DISCREPANT')).toBe(true);
    });
    it('sin base u orden no inventa stock esperado', () => {
        const snapshot = baseSnapshot({ productos: [product('3')], movimientosStock: [movement()] });
        const findings = analyzeInventory(snapshot, baseInput(snapshot).request);
        expect(findings.some(f => f.code === 'STOCK_BASE_UNVERIFIABLE' && f.verificability === 'UNVERIFIABLE')).toBe(true);
        expect(findings.some(f => f.code === 'STOCK_MATERIALIZED_MISMATCH')).toBe(false);
    });
    it('producto ausente requiere cobertura completa; mismo producto/operación no prueba doble efecto', () => {
        const missing = baseSnapshot({ movimientosStock: [movement()] });
        expect(analyzeInventory(missing, baseInput(missing).request).some(f => f.code === 'STOCK_PRODUCT_MISSING')).toBe(true);
        const second = { ...movement(), id: id(32), sourceId, negocioId: tenant, productoId: productId };
        const duplicates = baseSnapshot({ productos: [product()], movimientosStock: [movement(), second] });
        const findings = analyzeInventory(duplicates, baseInput(duplicates).request);
        expect(findings.some(f => f.code === 'MOVEMENT_DUPLICATE_SUSPECTED')).toBe(true);
        expect(findings.some(f => f.code === 'MOVEMENT_DOUBLE_APPLIED')).toBe(false);
    });
    it('doble efecto exige prueba explícita de aplicación repetida', () => {
        const duplicate = { ...movement(), id: id(32), duplicateEffectVerified: true };
        const snapshot = baseSnapshot({ productos: [product()], movimientosStock: [movement(), duplicate] });
        expect(analyzeInventory(snapshot, baseInput(snapshot).request).some(f => f.code === 'MOVEMENT_DOUBLE_APPLIED' && f.severity === 'CRITICAL')).toBe(true);
    });
});
