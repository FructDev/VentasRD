import { describe, expect, it } from 'vitest';
import {
    construirEfectosVenta,
    validarConfirmacionVenta,
    VERSION_CONTRATO_VENTA,
    type ConfirmarVentaEntrada,
} from './contrato';

function entradaBase(overrides: Partial<ConfirmarVentaEntrada> = {}): ConfirmarVentaEntrada {
    return {
        version: VERSION_CONTRATO_VENTA,
        operacionId: 'venta-1',
        negocioId: 'negocio-1',
        sucursalId: 'sucursal-1',
        cajaCodigo: 'C7Q',
        numeroTicket: 42,
        fecha: 1_700_000_000_000,
        total: 118,
        metodoPago: 'efectivo',
        garantiaDias: 30,
        items: [{ productoId: 'p1', nombre: 'Producto', cantidad: 1, precioUnitario: 100 }],
        ...overrides,
    };
}

const crearId = (tipo: string, indice: number) => `${tipo}-${indice}`;

describe('contrato de confirmación de venta', () => {
    it('genera venta, detalle, movimiento y efecto de caja con una identidad estable', () => {
        const efectos = construirEfectosVenta(entradaBase(), crearId);

        expect(efectos.venta).toMatchObject({
            id: 'venta-1', negocio_id: 'negocio-1', sucursal_id: 'sucursal-1',
            numero_ticket: 42, caja_codigo: 'C7Q', total: 118,
            metodo_pago: 'efectivo', estado_sincronizacion: 0,
        });
        expect(efectos.detalles).toEqual([expect.objectContaining({
            id: 'detalle-0', venta_id: 'venta-1', producto_id: 'p1',
            cantidad: 1, precio_unitario: 100, subtotal: 100,
        })]);
        expect(efectos.movimientosStock).toEqual([expect.objectContaining({
            id: 'movimiento_stock-0', producto_id: 'p1', delta: -1,
            referencia_id: 'venta-1', estado_sincronizacion: 0,
        })]);
        expect(efectos.impactoCaja).toEqual({ efectivo: 118, tarjeta: 0, transferencia: 0, fiado: 0 });
        expect(efectos.secuencia).toEqual({ cajaCodigo: 'C7Q', numeroTicket: 42, ncf: undefined });
    });

    it('descuenta los ingredientes de un combo y no el producto padre', () => {
        const efectos = construirEfectosVenta(entradaBase({
            items: [{
                productoId: 'combo', nombre: 'Combo', cantidad: 2, precioUnitario: 59,
                ingredientes: [
                    { productoId: 'insumo-a', cantidadNecesaria: 0.5 },
                    { productoId: 'insumo-b', cantidadNecesaria: 2 },
                ],
            }],
        }), crearId);

        expect(efectos.movimientosStock.map(m => [m.producto_id, m.delta])).toEqual([
            ['insumo-a', -1],
            ['insumo-b', -4],
        ]);
    });

    it('crea el cargo fiado enlazado a venta, negocio y sucursal', () => {
        const efectos = construirEfectosVenta(entradaBase({
            metodoPago: 'fiado', clienteId: 'cliente-1', clienteNombre: ' Ana ',
        }), crearId);

        expect(efectos.cargoFiado).toMatchObject({
            id: 'fiado-0', venta_id: 'venta-1', cliente_id: 'cliente-1',
            negocio_id: 'negocio-1', sucursal_id: 'sucursal-1', monto: 118,
            tipo: 'cargo', estado_sincronizacion: 0,
        });
        expect(efectos.venta.cliente_nombre).toBe('Ana');
        expect(efectos.impactoCaja.fiado).toBe(118);
        expect(efectos.impactoCaja.efectivo).toBe(0);
    });

    it('preserva el desglose mixto que usa el cierre de caja', () => {
        const efectos = construirEfectosVenta(entradaBase({
            metodoPago: 'mixto', montoEfectivo: 50, montoTransferencia: 68,
        }), crearId);

        expect(efectos.venta).toMatchObject({ monto_efectivo: 50, monto_transferencia: 68 });
        expect(efectos.impactoCaja).toEqual({ efectivo: 50, tarjeta: 0, transferencia: 68, fiado: 0 });
    });

    it('incluye serial, garantía, cliente y precio como un efecto obligatorio', () => {
        const efectos = construirEfectosVenta(entradaBase({
            clienteNombre: 'Luis',
            items: [{
                productoId: 'telefono', nombre: 'Teléfono', cantidad: 1, precioUnitario: 118,
                serial: { id: 'serial-1', numero: 'IMEI-001' },
            }],
        }), crearId);

        expect(efectos.seriales).toEqual([{
            serialId: 'serial-1', productoId: 'telefono', numeroSerial: 'IMEI-001',
            ventaId: 'venta-1', fechaVenta: 1_700_000_000_000,
            garantiaDias: 30, garantiaHasta: 1_702_592_000_000,
            clienteNombre: 'Luis', precioVenta: 118,
        }]);
    });

    it('rechaza fiado sin cliente, serial repetido y pagos mixtos que no cuadran', () => {
        const errores = validarConfirmacionVenta(entradaBase({
            metodoPago: 'fiado',
            items: [
                { productoId: 'p1', nombre: 'A', cantidad: 2, precioUnitario: 50, serial: { id: 's1', numero: '1' } },
                { productoId: 'p2', nombre: 'B', cantidad: 1, precioUnitario: 18, serial: { id: 's1', numero: '1' } },
            ],
        }));
        expect(errores).toContain('fiado_sin_cliente');
        expect(errores).toContain('item_0_serial_cantidad_invalida');
        expect(errores).toContain('item_1_serial_duplicado');

        expect(validarConfirmacionVenta(entradaBase({
            metodoPago: 'mixto', montoEfectivo: 50, montoTransferencia: 60,
        }))).toContain('pago_mixto_no_cuadra');
    });

    it('rechaza entradas estructuralmente incompletas antes de escribir datos', () => {
        expect(() => construirEfectosVenta(entradaBase({ items: [] }), crearId))
            .toThrow('venta_invalida:venta_sin_items');
    });
});
