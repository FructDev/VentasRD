import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { VentaRDDatabase } from '@/lib/db/dexie';
import { analyzeLocal } from './analyze';
import { captureLocalSnapshot } from './readers/local';
import { asOf, id, productId, saleId, tenant } from './fixtures/local';

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

vi.mock('@/lib/db/worker', () => { throw new Error('diagnostic imported worker'); });

describe('diagnóstico al iniciar sin conexión', () => {
    it('analiza venta válida/incompleta y pendiente sin mutar ninguna tabla ni llamar red', async () => {
        const database = new VentaRDDatabase(`VentaRD_Offline_${crypto.randomUUID()}`);
        await database.open();
        try {
            await database.productos.add({ id: productId, negocio_id: tenant, nombre: 'Equipo', codigo_barras: '1', precio_venta: 100, costo: 60, stock_actual: 4, stock_minimo: 1, tasa_itbis: 0.18, tipo: 'simple', estado_sincronizacion: 1 });
            await database.ventas.bulkAdd([
                { id: saleId, negocio_id: tenant, total: 100, metodo_pago: 'efectivo', estado_sincronizacion: 0, fecha_creacion: asOf - 10_000 },
                { id: id(22), negocio_id: tenant, total: 50, metodo_pago: 'efectivo', estado_sincronizacion: 0, fecha_creacion: asOf - 9_000 },
            ]);
            await database.venta_detalles.add({ id: id(21), venta_id: saleId, producto_id: productId, negocio_id: tenant, cantidad: 1, precio_unitario: 100, subtotal: 100, estado_sincronizacion: 0, fecha_creacion: asOf - 10_000 });
            await database.movimientos_stock.add({ id: id(30), negocio_id: tenant, producto_id: productId, delta: -1, tipo: 'venta', referencia_id: saleId, fecha_creacion: asOf - 10_000, estado_sincronizacion: 0 });
            const before = JSON.stringify(await Promise.all(database.tables.map(t => t.toArray())));
            const fetchSpy = vi.fn(() => { throw new Error('offline'); });
            vi.stubGlobal('fetch', fetchSpy);
            const request = { negocioId: tenant, desde: asOf - 60_000, hasta: asOf, asOf, pendingThresholdMs: 300_000 };
            const snapshot = await captureLocalSnapshot(database, request, { sourceId: 'pc-a', deviceLabel: 'PC A', clock: () => asOf, connectivityObserved: false });
            const input = deepFreeze({ contractVersion: '1.0' as const, request, snapshots: [snapshot] });
            const report = analyzeLocal(input);
            const again = analyzeLocal(input);
            expect(report).toEqual(again);
            expect(report.findings.some(f => f.code === 'SALE_MISSING_REQUIRED_EFFECT' && f.ids.saleId === id(22))).toBe(true);
            expect(report.findings.some(f => f.code === 'SYNC_PENDING')).toBe(true);
            expect(report.findings.some(f => f.code === 'STOCK_BASE_UNVERIFIABLE')).toBe(true);
            expect(report.findings.some(f => f.code === 'STOCK_MATERIALIZED_MISMATCH')).toBe(false);
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(JSON.stringify(await Promise.all(database.tables.map(t => t.toArray())))).toBe(before);
        } finally { vi.unstubAllGlobals(); database.close(); await database.delete(); }
    });
});
