/**
 * Caracterización de totales de venta legacy (T007 parcial, FR-010/FR-011).
 *
 * Ejecuta la implementación ACTUAL `calcularTotalesExactos` sobre un corpus
 * sintético y produce `packages/contracts/fixtures/legacy-commercial.json`.
 * El core Rust verifica paridad en `crates/ventard-core/tests/legacy_commercial_parity.rs`.
 *
 *   Verificar:   npx vitest run --config scripts/native/vitest.fixtures.config.ts
 *   Regenerar:   $env:UPDATE_FIXTURES='1'; npx vitest run --config scripts/native/vitest.fixtures.config.ts
 *
 * Si el legacy cambia, la verificación falla: se revisa el cambio, no se
 * regenera a ciegas para conseguir PASS.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { calcularTotalesExactos } from '@/lib/domain/ventas/totales';
import { moneyCents } from '@/lib/domain/local/command';
import { commercialCases, turnCases } from './legacy-business';

type Item = { precio_venta: number; cantidad: number; tasa_itbis?: number };
type Case = { id: string; note: string; items: Item[]; tipo: 'porcentaje' | 'monto'; valor: number };

const CASES: Case[] = [
    { id: 'basic-18', note: 'una línea 18 %', items: [{ precio_venta: 100, cantidad: 1, tasa_itbis: 0.18 }], tipo: 'monto', valor: 0 },
    { id: 'itbis-aggregate', note: 'ITBIS agregado: 3×0.54 c = 1.62 → 2 c (por línea serían 3 c)', items: [
        { precio_venta: 0.03, cantidad: 1, tasa_itbis: 0.18 }, { precio_venta: 0.03, cantidad: 1, tasa_itbis: 0.18 }, { precio_venta: 0.03, cantidad: 1, tasa_itbis: 0.18 }], tipo: 'monto', valor: 0 },
    { id: 'half-up-boundary', note: '4.5 c de ITBIS → 5', items: [{ precio_venta: 0.25, cantidad: 1, tasa_itbis: 0.18 }], tipo: 'monto', valor: 0 },
    { id: 'mixed-rates', note: 'tasas 0, 0.16, 0.18 y ausente', items: [
        { precio_venta: 50, cantidad: 2, tasa_itbis: 0 }, { precio_venta: 33.33, cantidad: 3, tasa_itbis: 0.16 },
        { precio_venta: 19.99, cantidad: 1, tasa_itbis: 0.18 }, { precio_venta: 7.5, cantidad: 4 }], tipo: 'monto', valor: 0 },
    { id: 'fractional-qty', note: 'cantidad 0.5 con precio par', items: [{ precio_venta: 10.5, cantidad: 0.5, tasa_itbis: 0.18 }], tipo: 'monto', valor: 0 },
    { id: 'fractional-qty-1.5', note: 'cantidad 1.5', items: [{ precio_venta: 2, cantidad: 1.5, tasa_itbis: 0.18 }], tipo: 'monto', valor: 0 },
    { id: 'non-representable', note: '0.01 × 0.5 no es centavo exacto', items: [{ precio_venta: 0.01, cantidad: 0.5 }], tipo: 'monto', valor: 0 },
    { id: 'scientific-qty', note: 'cantidad 1e-7: 100000 c × 1e-7 = 0.01 c no representable', items: [{ precio_venta: 1000, cantidad: 1e-7 }], tipo: 'monto', valor: 0 },
    { id: 'scientific-qty-ok', note: 'cantidad 1e-7: 10000000 c × 1e-7 = 1 c', items: [{ precio_venta: 100000, cantidad: 1e-7 }], tipo: 'monto', valor: 0 },
    { id: 'scientific-qty-large', note: 'cantidad 1e21 (toString científico) con precio 0', items: [{ precio_venta: 0, cantidad: 1e21 }], tipo: 'monto', valor: 0 },
    { id: 'discount-pct-10', note: 'descuento sobre bruto', items: [{ precio_venta: 100, cantidad: 1, tasa_itbis: 0.18 }], tipo: 'porcentaje', valor: 10 },
    { id: 'discount-pct-12.5', note: 'porcentaje fraccionario half-up', items: [{ precio_venta: 0.99, cantidad: 1, tasa_itbis: 0.18 }], tipo: 'porcentaje', valor: 12.5 },
    { id: 'discount-pct-100', note: '100 % → total 0', items: [{ precio_venta: 100, cantidad: 1, tasa_itbis: 0.18 }], tipo: 'porcentaje', valor: 100 },
    { id: 'discount-pct-150', note: '>100 % se limita al bruto', items: [{ precio_venta: 100, cantidad: 1, tasa_itbis: 0.18 }], tipo: 'porcentaje', valor: 150 },
    { id: 'discount-amount-over', note: 'monto > bruto se limita', items: [{ precio_venta: 100, cantidad: 1, tasa_itbis: 0.18 }], tipo: 'monto', valor: 500 },
    { id: 'discount-amount', note: 'monto exacto', items: [{ precio_venta: 100, cantidad: 2, tasa_itbis: 0.18 }], tipo: 'monto', valor: 36 },
    { id: 'empty-ticket', note: 'ticket vacío: política actual devuelve 0, no error', items: [], tipo: 'monto', valor: 0 },
    { id: 'price-zero', note: 'precio 0 permitido', items: [{ precio_venta: 0, cantidad: 3, tasa_itbis: 0.18 }], tipo: 'monto', valor: 0 },
    { id: 'qty-zero', note: 'cantidad 0 rechazada', items: [{ precio_venta: 10, cantidad: 0 }], tipo: 'monto', valor: 0 },
    { id: 'tax-over-1', note: 'tasa > 1 rechazada', items: [{ precio_venta: 10, cantidad: 1, tasa_itbis: 1.5 }], tipo: 'monto', valor: 0 },
    { id: 'price-sub-cent', note: 'precio 0.001 no representable en centavos', items: [{ precio_venta: 0.001, cantidad: 1 }], tipo: 'monto', valor: 0 },
    { id: 'ieee-noise', note: '0.1+0.2 se acepta como 30 c', items: [{ precio_venta: 0.1 + 0.2, cantidad: 1 }], tipo: 'monto', valor: 0 },
    { id: 'near-max-safe', note: 'total cerca de MAX_SAFE', items: [{ precio_venta: 90071992547409.91, cantidad: 1 }], tipo: 'monto', valor: 0 },
    { id: 'over-max-safe', note: 'suma excede MAX_SAFE', items: [{ precio_venta: 90071992547409.91, cantidad: 1 }, { precio_venta: 0.01, cantidad: 1 }], tipo: 'monto', valor: 0 },
    { id: 'many-lines', note: '25 líneas con 18 %', items: Array.from({ length: 25 }, (_, i) => ({ precio_venta: 1.07 + i, cantidad: 1 + (i % 3), tasa_itbis: 0.18 })), tipo: 'porcentaje', valor: 5 },
];

const cents = (pesos: number) => String(moneyCents(pesos));

function nativeInput(c: Case) {
    // Conversión de los números JS legacy a la forma nativa: precio a centavos
    // con el mismo moneyCents legacy; cantidades/tasas como su toString, que
    // el core Rust parsea con Ratio::parse_legacy_decimal.
    try {
        return {
            lines: c.items.map(i => ({
                unitPriceCents: cents(i.precio_venta),
                quantity: String(i.cantidad),
                taxRate: String(i.tasa_itbis ?? 0),
            })),
            discount: c.tipo === 'monto' ? { kind: 'AMOUNT', cents: cents(c.valor) } : { kind: 'PERCENT', value: String(c.valor) },
        };
    } catch (e) {
        return { conversionError: (e as Error).message };
    }
}

function run(c: Case) {
    try {
        const r = calcularTotalesExactos(c.items, c.tipo, c.valor);
        return { ok: { subtotal: cents(r.subtotal), itbis: cents(r.itbis), descuento: cents(r.descuento), total: cents(r.total) } };
    } catch (e) {
        return { error: (e as Error).message };
    }
}

const FIXTURE = path.resolve(__dirname, '../../packages/contracts/fixtures/legacy-commercial.json');

describe('caracterización legacy: calcularTotalesExactos', () => {
    const generated = {
        fixture: 'legacy-commercial',
        version: 2,
        source: 'src/lib/domain/ventas/totales.ts#calcularTotalesExactos',
        commercialSource: 'src/lib/domain/ventas/contrato.ts#construirEfectosVenta',
        turnSource: 'src/lib/domain/ventas/confirmarVentaLocal.ts#confirmarVentaLocal',
        policy: 'ITBIS exacto agregado y half-up por ticket; descuento sobre bruto, limitado al bruto',
        units: 'importes en centavos (string decimal)',
        scope: 'Totales exactos y efectos de pagos/fiado/recetas/seriales; turnos caracterizados con confirmarVentaLocal en fake-indexeddb. No certifica la implementación nativa.',
        cases: CASES.map(c => ({ id: c.id, note: c.note, legacyInput: { items: c.items, tipo: c.tipo, valor: c.valor }, native: nativeInput(c), expected: run(c) })),
    };
    it('coincide con el fixture versionado', async () => {
        const json = JSON.stringify({ ...generated, commercialCases: commercialCases(), turnCases: await turnCases() }, null, 2) + '\n';
        if (process.env.UPDATE_FIXTURES === '1') {
            mkdirSync(path.dirname(FIXTURE), { recursive: true });
            writeFileSync(FIXTURE, json, 'utf8');
        }
        expect(readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n')).toBe(json);
    });

    it('el corpus incluye pagos, recetas, seriales y contexto real de turno', () => {
        const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
        const kinds = new Set(fixture.commercialCases?.map((entry: { id: string }) => entry.id));
        for (const id of ['mixed', 'mixed-invalid', 'credit', 'credit-without-client', 'recipe-exact', 'recipe-fractional', 'serial', 'serial-multiple']) {
            expect(kinds.has(id), `falta caracterización ${id}`).toBe(true);
        }
        const turns = new Set(fixture.turnCases?.map((entry: { id: string }) => entry.id));
        for (const id of ['cash-no-turn', 'transfer-no-turn', 'cash-open-turn', 'cash-ambiguous-turn', 'cash-changed-turn']) {
            expect(turns.has(id), `falta contexto ${id}`).toBe(true);
        }
        const business = (id: string) => fixture.commercialCases.find((entry: { id: string }) => entry.id === id);
        expect(business('mixed').expected.ok.cashCents).toEqual({ efectivo: '1800', tarjeta: '0', transferencia: '10000', fiado: '0' });
        expect(business('credit').expected.ok.credit).toMatchObject({ amountCents: '11800', kind: 'cargo' });
        expect(business('recipe-exact').expected.ok.movements[0].delta).toBe('-2');
        expect(business('recipe-fractional').expected.error).toContain('stock_consumo_no_entero');
        expect(business('serial').expected.ok.serials[0].numeroSerial).toBe('001234567890123');
        expect(business('serial-multiple').expected.error).toContain('serial_cantidad_invalida');
        const cash = (id: string) => fixture.turnCases.find((entry: { id: string }) => entry.id === id);
        for (const [id, error] of [['cash-no-turn', 'turno_requerido'], ['cash-ambiguous-turn', 'turno_ambiguo'], ['cash-changed-turn', 'turno_cambiado']]) {
            expect(cash(id).expected.error).toBe(error);
            expect(cash(id).after).toEqual({ sales: 0, stock: 5, movements: 0 });
        }
        expect(cash('cash-open-turn').after).toEqual({ sales: 1, stock: 4, movements: 1 });
        expect(cash('transfer-no-turn').after).toEqual({ sales: 1, stock: 4, movements: 1 });
    });
});
