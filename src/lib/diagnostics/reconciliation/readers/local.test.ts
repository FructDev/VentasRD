import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VentaRDDatabase } from '@/lib/db/dexie';
import type { ProductoLocal, VentaLocal } from '@/types/database';
import { captureLocalSnapshot } from './local';
import { asOf, id, productId, saleId, tenant } from '../fixtures/local';

vi.mock('@/lib/db/worker', () => { throw new Error('diagnostic imported worker'); });

let database: VentaRDDatabase;
const request = { negocioId: tenant, desde: asOf - 60_000, hasta: asOf, asOf, pendingThresholdMs: 300_000 };
const product: ProductoLocal = { id: productId, negocio_id: tenant, nombre: 'Equipo', codigo_barras: '001', precio_venta: 100, costo: 60, stock_actual: 4, stock_minimo: 1, tasa_itbis: 0.18, tipo: 'simple', estado_sincronizacion: 1 };
const sale: VentaLocal = { id: saleId, negocio_id: tenant, total: 100, metodo_pago: 'efectivo', estado_sincronizacion: 0, fecha_creacion: asOf - 10_000 };

async function entireDatabase(): Promise<string> {
    const rows = await Promise.all(database.tables.map(async table => [table.name, await table.toArray()] as const));
    return JSON.stringify(rows.sort(([a], [b]) => a.localeCompare(b)));
}

beforeEach(async () => {
    database = new VentaRDDatabase(`VentaRD_Diagnostic_${crypto.randomUUID()}`);
    await database.open();
    await database.productos.add(product);
    await database.ventas.add(sale);
    await database.venta_detalles.add({ id: id(21), venta_id: saleId, producto_id: productId, negocio_id: tenant, cantidad: 1, precio_unitario: 100, subtotal: 100, estado_sincronizacion: 0, fecha_creacion: asOf - 10_000 });
    await database.movimientos_stock.add({ id: id(30), negocio_id: tenant, producto_id: productId, delta: -1, tipo: 'venta', referencia_id: saleId, fecha_creacion: asOf - 10_000, estado_sincronizacion: 0 });
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); database.close(); await database.delete(); });

describe('captura Dexie local', () => {
    it('usa una sola transacción readonly, no escribe ni llama red, worker, sync o retry', async () => {
        const before = await entireDatabase();
        const tx = vi.spyOn(database, 'transaction');
        const fetchSpy = vi.fn(() => { throw new Error('unexpected network'); });
        vi.stubGlobal('fetch', fetchSpy);
        const snapshot = await captureLocalSnapshot(database, request, { sourceId: 'pc-a', deviceLabel: 'PC A', clock: () => asOf, connectivityObserved: false });
        expect(tx).toHaveBeenCalledTimes(1);
        expect(tx.mock.calls[0][0]).toBe('r');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(await entireDatabase()).toBe(before);
        expect(snapshot.capture.temporalConsistency).toBe('COHERENT');
        expect(snapshot.source.serverIdentityVerified).toBe(false);
        expect(snapshot.records.ventas[0].id).toBe(saleId);
        expect(snapshot.records.movimientosStock[0].delta).toBe('-1');
    });

    it('registra cobertura de todas las entidades y retención parcial de histórico viejo', async () => {
        const old = { ...request, desde: asOf - 100 * 86_400_000 };
        const snapshot = await captureLocalSnapshot(database, old, { sourceId: 'pc-a', clock: () => asOf });
        expect(snapshot.coverage).toHaveLength(13);
        expect(snapshot.coverage.find(c => c.entity === 'ventas')?.status).toBe('PARTIAL');
        expect(snapshot.coverage.find(c => c.entity === 'movimientosStock')?.status).toBe('PARTIAL');
        expect(snapshot.coverage.find(c => c.entity === 'reportes')?.status).toBe('UNAVAILABLE');
    });

    it('excluye contacto, IMEI y patrón de reparación de la captura', async () => {
        await database.reparaciones.add({ id: id(80), negocio_id: tenant, folio: 'REP-1', cliente_nombre: 'Persona Privada', cliente_telefono: '809-555-0000', equipo_modelo: 'Equipo', equipo_imei: '123456789012345', patron_clave: '1234', problema_reportado: 'Pantalla', estado: 'recibido', repuestos: [], mano_obra: 0, total: 0, abono: 0, pagos: [{ monto: 10, metodo: 'efectivo', fecha: asOf - 1000 }], fecha_creacion: asOf - 1000, fecha_actualizacion: asOf - 1000 });
        const snapshot = await captureLocalSnapshot(database, request, { sourceId: 'pc-a', clock: () => asOf });
        const serialized = JSON.stringify(snapshot);
        expect(serialized).not.toContain('809-555-0000');
        expect(serialized).not.toContain('123456789012345');
        expect(serialized).not.toContain('patron_clave');
        expect(snapshot.records.reparaciones[0].pagos[0].monto).toBe('10.00');
    });
});
