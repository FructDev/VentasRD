import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { VentaRDDatabase } from '@/lib/db/dexie';
import type { MovimientoStockLocal } from '@/types/database';
import { buildOperation, buildReceipt } from './test-fixtures';
import { InventoryOperationRepository, inventoryCursorId } from './repository';

const databases: VentaRDDatabase[] = [];

afterEach(async () => {
    for (const database of databases.splice(0)) {
        database.close();
        await Dexie.delete(database.name);
    }
});

async function openDatabase(name = `InventoryRepo_${crypto.randomUUID()}`) {
    const database = new VentaRDDatabase(name);
    databases.push(database);
    await database.open();
    return database;
}

describe('repositorio de operaciones de inventario', () => {
    it('abre datos v21 con índices v22 y journal v23 sin perder registros', async () => {
        const name = `InventoryUpgrade_${crypto.randomUUID()}`;
        const legacyDb = new Dexie(name);
        legacyDb.version(21).stores({
            productos: 'id, negocio_id, estado_sincronizacion',
            movimientos_stock: 'id, negocio_id, producto_id, tipo, estado_sincronizacion, fecha_creacion',
            secuencias: 'id, negocio_id, caja_codigo, tipo',
        });
        await legacyDb.open();
        await legacyDb.table('movimientos_stock').add({
            id: 'legacy-1', negocio_id: 'tenant', producto_id: 'product', delta: -1,
            tipo: 'venta', fecha_creacion: 1, estado_sincronizacion: 0,
        });
        legacyDb.close();

        const database = await openDatabase(name);
        expect(await database.movimientos_stock.get('legacy-1')).toMatchObject({ delta: -1 });
        expect(database.verno).toBe(24);
        expect(database.movimientos_stock.schema.indexes.map(index => index.name)).toEqual(expect.arrayContaining([
            '[negocio_id+sync_state]',
            '[negocio_id+next_attempt_at]',
            '[negocio_id+sucursal_id+producto_id]',
        ]));
        expect(database.tables.map(table => table.name)).toContain('inventario_sync_cursors');
    });

    it('adopta legacy perezosamente sin fabricar recibos', async () => {
        const database = await openDatabase();
        const repository = new InventoryOperationRepository(database);
        const base: MovimientoStockLocal = {
            id: 'legacy-pending', negocio_id: 'tenant', producto_id: 'product', delta: -1,
            tipo: 'venta', fecha_creacion: 1, estado_sincronizacion: 0,
        };
        await database.movimientos_stock.bulkAdd([
            base,
            { ...base, id: 'legacy-claimed', estado_sincronizacion: 1 },
        ]);

        expect((await repository.adoptLegacy('legacy-pending', 10))?.sync_state).toBe('PENDING');
        const claimed = await repository.adoptLegacy('legacy-claimed', 10);
        expect(claimed?.sync_state).toBe('UNKNOWN_LEGACY');
        expect(claimed?.remote_receipt).toBeUndefined();
        expect(claimed?.sync_protocol_version).toBeUndefined();
    });

    it('conserva cantidades legacy decimales como UNKNOWN_LEGACY sin convertirlas', async () => {
        const database = await openDatabase();
        const repository = new InventoryOperationRepository(database);
        await database.movimientos_stock.add({
            id: 'legacy-decimal', negocio_id: 'tenant', producto_id: 'product', delta: -1.5,
            tipo: 'venta', fecha_creacion: 1, estado_sincronizacion: 0,
        });

        const adopted = await repository.adoptLegacy('legacy-decimal', 10);
        expect(adopted).toMatchObject({ delta: -1.5, sync_state: 'UNKNOWN_LEGACY' });
        expect(adopted?.sync_protocol_version).toBeUndefined();
        expect(adopted?.payload_hash).toBeUndefined();
    });

    it('solo persiste APPLIED y flag 1 con recibo exacto', async () => {
        const database = await openDatabase();
        const repository = new InventoryOperationRepository(database);
        const operation = buildOperation({ sync_state: 'IN_FLIGHT' });
        await repository.create(operation);
        const incompatible = buildReceipt(undefined, { payloadHash: 'b'.repeat(64) });
        await expect(repository.applyReceipt(operation.id, incompatible, 20)).rejects.toThrow('inventory_receipt_mismatch');
        expect(await repository.get(operation.id)).toMatchObject({
            sync_state: 'IN_FLIGHT', estado_sincronizacion: 0,
        });

        const exact = buildReceipt(undefined, { payloadHash: operation.payload_hash! });
        await repository.applyReceipt(operation.id, exact, 30);
        expect(await repository.get(operation.id)).toMatchObject({
            sync_state: 'APPLIED', estado_sincronizacion: 1, remote_receipt: exact,
        });
    });

    it('rechaza cantidad o recibo v2 fraccionario sin mutar la fila', async () => {
        const database = await openDatabase();
        const repository = new InventoryOperationRepository(database);
        const invalid = buildOperation({ delta: -1.5 });
        await expect(repository.create(invalid)).rejects.toThrow('inventory_integer_invalid');
        expect(await repository.get(invalid.id)).toBeUndefined();

        const operation = buildOperation();
        await repository.create(operation);
        const receipt = buildReceipt(undefined, {
            payloadHash: operation.payload_hash!, stockAfter: '8.5',
        });
        await expect(repository.applyReceipt(operation.id, receipt, 20))
            .rejects.toThrow('inventory_receipt_mismatch');
        const unchanged = await repository.get(operation.id);
        expect(unchanged).toMatchObject({ sync_state: 'PENDING', estado_sincronizacion: 0 });
        expect(unchanged?.remote_receipt).toBeUndefined();
    });

    it('mantiene cursores separados por tenant y sucursal', async () => {
        const database = await openDatabase();
        const repository = new InventoryOperationRepository(database);
        await repository.advanceCursor({ negocioId: 'tenant-a', sucursalId: 'branch-a' }, {
            lastRemoteSequence: '10', lastOperationId: 'op-a', updatedAt: 10,
        });
        await repository.advanceCursor({ negocioId: 'tenant-a', sucursalId: null }, {
            lastRemoteSequence: '20', lastOperationId: 'op-b', updatedAt: 20,
        });

        expect(inventoryCursorId({ negocioId: 'tenant-a', sucursalId: 'branch-a' }))
            .toBe('tenant-a:branch-a:inventory-v2');
        expect((await repository.getCursor({ negocioId: 'tenant-a', sucursalId: 'branch-a' }))?.last_remote_sequence)
            .toBe('10');
        expect((await repository.getCursor({ negocioId: 'tenant-a', sucursalId: null }))?.last_remote_sequence)
            .toBe('20');
    });
});
