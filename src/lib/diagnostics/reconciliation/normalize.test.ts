import { describe, expect, it } from 'vitest';
import { normalizeMoney, normalizeQuantity, normalizeSale } from './normalize';

describe('normalización diagnóstica', () => {
    it('compara dinero en centavos exactos con redondeo half-up declarado', () => {
        expect(normalizeMoney('0.1')).toBe('0.10');
        expect(normalizeMoney('1.005')).toBe('1.01');
        expect(normalizeMoney('-1.005')).toBe('-1.01');
        expect(normalizeMoney(0.1 + 0.2)).toBe('0.30');
    });
    it('preserva la precisión de cantidad sin convertirla en entero', () => {
        expect(normalizeQuantity('0.375')).toBe('0.375');
        expect(normalizeQuantity(-2.5)).toBe('-2.5');
    });
    it('conserva ID, procedencia y ausencia de hechos fiscales históricos', () => {
        const sale = normalizeSale({ id: 'sale-1', negocio_id: 'tenant-1', total: 100, metodo_pago: 'efectivo', estado_sincronizacion: 1, fecha_creacion: 90 }, 'pc-a', 100);
        expect(sale).toMatchObject({ id: 'sale-1', negocioId: 'tenant-1', sourceId: 'pc-a', total: '100.00', syncFlag: 1 });
        expect(sale.historicalTax).toBeUndefined();
        expect(sale.historicalDiscount).toBeUndefined();
        expect(sale.historicalTotalFactsComplete).toBeUndefined();
    });
});
