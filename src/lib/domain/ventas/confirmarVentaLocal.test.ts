import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VentaRDDatabase } from '@/lib/db/dexie';
import type { ProductoLocal, SerialLocal } from '@/types/database';
import { VERSION_CONTRATO_VENTA } from './contrato';
import { confirmarVentaLocal, type ConfirmarVentaLocalEntrada } from './confirmarVentaLocal';

let database: VentaRDDatabase;

const productoBase: ProductoLocal = {
    id: 'producto-1', negocio_id: 'negocio-1', nombre: 'Teléfono', codigo_barras: '001',
    precio_venta: 100, costo: 70, stock_actual: 5, stock_minimo: 1,
    tasa_itbis: 0.18, tipo: 'simple', estado_sincronizacion: 1,
};

function entrada(overrides: Partial<ConfirmarVentaLocalEntrada> = {}): ConfirmarVentaLocalEntrada {
    return {
        version: VERSION_CONTRATO_VENTA,
        operacionId: 'venta-1',
        negocioId: 'negocio-1',
        sucursalId: 'sucursal-1',
        cajaCodigo: 'C7Q',
        fecha: 1_700_000_000_000,
        total: 118,
        metodoPago: 'efectivo',
        garantiaDias: 30,
        items: [{ productoId: 'producto-1', nombre: 'Teléfono', cantidad: 1, precioUnitario: 100 }],
        ...overrides,
    };
}

const crearId = (tipo: string, indice: number) => `${tipo}-${indice}`;

beforeEach(async () => {
    database = new VentaRDDatabase(`VentaRD_Test_${crypto.randomUUID()}`);
    await database.open();
    await database.productos.add(productoBase);
});

afterEach(async () => {
    database.close();
    await database.delete();
});

describe('confirmarVentaLocal', () => {
    it('confirma venta, detalle, stock, movimiento y secuencia en un solo commit', async () => {
        const resultado = await confirmarVentaLocal(database, entrada(), { crearId });

        expect(resultado.reutilizada).toBe(false);
        expect(resultado.efectos.venta.numero_ticket).toBe(1);
        expect(await database.ventas.count()).toBe(1);
        expect(await database.venta_detalles.count()).toBe(1);
        expect(await database.movimientos_stock.count()).toBe(1);
        expect((await database.productos.get('producto-1'))?.stock_actual).toBe(4);
        expect((await database.secuencias.toArray())[0]).toMatchObject({
            caja_codigo: 'C7Q', ultimo: 1, tipo: 'ticket',
        });
    });

    it('reserva tickets consecutivos sin volver a recorrer como fuente de verdad', async () => {
        await confirmarVentaLocal(database, entrada(), { crearId });
        const segunda = await confirmarVentaLocal(database, entrada({
            operacionId: 'venta-2', fecha: 1_700_000_000_100,
        }), { crearId: (tipo, indice) => `v2-${tipo}-${indice}` });

        expect(segunda.efectos.venta.numero_ticket).toBe(2);
        expect((await database.secuencias.toArray())[0].ultimo).toBe(2);
    });

    it('migra el contador legado sin reiniciar la numeración', async () => {
        const resultado = await confirmarVentaLocal(database, entrada({ ultimoTicketConocido: 87 }), { crearId });
        expect(resultado.efectos.venta.numero_ticket).toBe(88);
    });

    it('es idempotente: repetir operacionId no duplica ni vuelve a descontar', async () => {
        const primera = await confirmarVentaLocal(database, entrada(), { crearId });
        const repetida = await confirmarVentaLocal(database, entrada(), { crearId });

        expect(primera.reutilizada).toBe(false);
        expect(repetida.reutilizada).toBe(true);
        expect(await database.ventas.count()).toBe(1);
        expect(await database.venta_detalles.count()).toBe(1);
        expect(await database.movimientos_stock.count()).toBe(1);
        expect((await database.productos.get('producto-1'))?.stock_actual).toBe(4);
        expect((await database.secuencias.toArray())[0].ultimo).toBe(1);
    });

    it('rechaza reutilizar operacionId con una venta diferente', async () => {
        await confirmarVentaLocal(database, entrada(), { crearId });
        await expect(confirmarVentaLocal(database, entrada({ total: 999 }), { crearId }))
            .rejects.toThrow('operacion_id_conflicto:venta-1');
        expect(await database.ventas.count()).toBe(1);
        expect((await database.productos.get('producto-1'))?.stock_actual).toBe(4);
    });

    it('serializa dos cobros concurrentes y entrega tickets distintos', async () => {
        const [primera, segunda] = await Promise.all([
            confirmarVentaLocal(database, entrada({ operacionId: 'venta-a' }), {
                crearId: (tipo, indice) => `a-${tipo}-${indice}`,
            }),
            confirmarVentaLocal(database, entrada({ operacionId: 'venta-b' }), {
                crearId: (tipo, indice) => `b-${tipo}-${indice}`,
            }),
        ]);

        expect([primera.efectos.venta.numero_ticket, segunda.efectos.venta.numero_ticket].sort()).toEqual([1, 2]);
        expect((await database.secuencias.toArray())[0].ultimo).toBe(2);
        expect((await database.productos.get('producto-1'))?.stock_actual).toBe(3);
    });

    it('incluye serial y fiado en el mismo commit', async () => {
        const serial: SerialLocal = {
            id: 'serial-1', negocio_id: 'negocio-1', producto_id: 'producto-1',
            numero_serial: 'IMEI-001', estado: 'disponible', estado_sincronizacion: 1,
            fecha_actualizacion: 1_699_999_000_000,
        };
        await database.seriales.add(serial);

        await confirmarVentaLocal(database, entrada({
            metodoPago: 'fiado', clienteId: 'cliente-1', clienteNombre: 'Ana',
            items: [{
                productoId: 'producto-1', nombre: 'Teléfono', cantidad: 1, precioUnitario: 118,
                serial: { id: 'serial-1', numero: 'IMEI-001' },
            }],
        }), { crearId });

        expect(await database.transacciones_fiado.count()).toBe(1);
        expect(await database.transacciones_fiado.get('fiado-0')).toMatchObject({
            venta_id: 'venta-1', sucursal_id: 'sucursal-1', cliente_id: 'cliente-1',
        });
        expect(await database.seriales.get('serial-1')).toMatchObject({
            estado: 'vendido', venta_id: 'venta-1', garantia_dias: 30,
            cliente_nombre: 'Ana', estado_sincronizacion: 0,
        });
    });

    it('revierte todo si el stock agregado de la operación es insuficiente', async () => {
        await expect(confirmarVentaLocal(database, entrada({
            items: [
                { productoId: 'producto-1', nombre: 'A', cantidad: 3, precioUnitario: 50 },
                { productoId: 'producto-1', nombre: 'A', cantidad: 3, precioUnitario: 50 },
            ],
        }), { crearId })).rejects.toThrow('stock_insuficiente:producto-1');

        expect(await database.ventas.count()).toBe(0);
        expect(await database.venta_detalles.count()).toBe(0);
        expect(await database.movimientos_stock.count()).toBe(0);
        expect(await database.secuencias.count()).toBe(0);
        expect((await database.productos.get('producto-1'))?.stock_actual).toBe(5);
    });

    it('revierte venta, ticket y stock si el serial no está disponible', async () => {
        await database.seriales.add({
            id: 'serial-1', negocio_id: 'negocio-1', producto_id: 'producto-1',
            numero_serial: 'IMEI-001', estado: 'vendido', estado_sincronizacion: 1,
            fecha_actualizacion: 1_699_999_000_000,
        });

        await expect(confirmarVentaLocal(database, entrada({
            items: [{
                productoId: 'producto-1', nombre: 'Teléfono', cantidad: 1, precioUnitario: 118,
                serial: { id: 'serial-1', numero: 'IMEI-001' },
            }],
        }), { crearId })).rejects.toThrow('serial_no_disponible:serial-1');

        expect(await database.ventas.count()).toBe(0);
        expect(await database.secuencias.count()).toBe(0);
        expect((await database.productos.get('producto-1'))?.stock_actual).toBe(5);
    });

    it('revierte todo ante una colisión interna al insertar detalles', async () => {
        await expect(confirmarVentaLocal(database, entrada({
            items: [
                { productoId: 'producto-1', nombre: 'A', cantidad: 1, precioUnitario: 50 },
                { productoId: 'producto-1', nombre: 'B', cantidad: 1, precioUnitario: 68 },
            ],
        }), { crearId: () => 'id-repetido' })).rejects.toThrow();

        expect(await database.ventas.count()).toBe(0);
        expect(await database.venta_detalles.count()).toBe(0);
        expect(await database.movimientos_stock.count()).toBe(0);
        expect(await database.secuencias.count()).toBe(0);
        expect((await database.productos.get('producto-1'))?.stock_actual).toBe(5);
    });
});
