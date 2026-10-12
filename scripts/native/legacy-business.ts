// Caracterización sintética del legado; no es implementación del core nativo.
import 'fake-indexeddb/auto';
import { VentaRDDatabase } from '@/lib/db/dexie';
import { construirEfectosVenta, type ConfirmarVentaEntrada } from '@/lib/domain/ventas/contrato';
import { confirmarVentaLocal } from '@/lib/domain/ventas/confirmarVentaLocal';
import { moneyCents } from '@/lib/domain/local/command';

const id = (n: number) => `96000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1), branch = id(2), product = id(3), customer = id(4), turn = id(5);
const date = 1_700_000_000_000;
const effectId = (kind: 'detalle' | 'fiado' | 'movimiento_stock', index: number) =>
    id(({ detalle: 100, fiado: 200, movimiento_stock: 300 }[kind]) + index);

function input(changes: Partial<ConfirmarVentaEntrada> = {}): ConfirmarVentaEntrada {
    return { version: 1, operacionId: id(10), negocioId: tenant, sucursalId: branch,
        cajaCodigo: 'QA', cajaId: turn, numeroTicket: 1, fecha: date, total: 118,
        metodoPago: 'efectivo', garantiaDias: 30,
        items: [{ productoId: product, nombre: 'Producto sintético', cantidad: 1, precioUnitario: 100 }], ...changes };
}

const scenarios: { id: string; input: ConfirmarVentaEntrada }[] = [
    { id: 'mixed', input: input({ metodoPago: 'mixto', montoEfectivo: 18, montoTransferencia: 100 }) },
    { id: 'mixed-invalid', input: input({ metodoPago: 'mixto', montoEfectivo: 18, montoTransferencia: 99 }) },
    { id: 'mixed-empty-part', input: input({ metodoPago: 'mixto', montoEfectivo: 0, montoTransferencia: 118 }) },
    { id: 'credit', input: input({ metodoPago: 'fiado', clienteId: customer }) },
    { id: 'credit-without-client', input: input({ metodoPago: 'fiado' }) },
    { id: 'card', input: input({ metodoPago: 'tarjeta' }) },
    { id: 'transfer', input: input({ metodoPago: 'transferencia' }) },
    { id: 'zero-ticket', input: input({ total: 0, items: [{ productoId: product, nombre: 'Precio cero', cantidad: 1, precioUnitario: 0 }] }) },
    { id: 'recipe-exact', input: input({ items: [{ productoId: product, nombre: 'Receta', cantidad: 4, precioUnitario: 25, ingredientes: [{ productoId: id(6), cantidadNecesaria: 0.5 }] }] }) },
    { id: 'recipe-fractional', input: input({ items: [{ productoId: product, nombre: 'Receta', cantidad: 3, precioUnitario: 25, ingredientes: [{ productoId: id(6), cantidadNecesaria: 0.5 }] }] }) },
    { id: 'serial', input: input({ items: [{ productoId: product, nombre: 'Equipo', cantidad: 1, precioUnitario: 100, serial: { id: id(7), numero: '001234567890123' } }] }) },
    { id: 'serial-multiple', input: input({ items: [{ productoId: product, nombre: 'Equipo', cantidad: 2, precioUnitario: 100, serial: { id: id(7), numero: '001234567890123' } }] }) },
];

export function commercialCases() {
    return scenarios.map(scenario => {
        try {
            const effects = construirEfectosVenta(scenario.input, effectId);
            return { ...scenario, expected: { ok: {
                cashCents: Object.fromEntries(Object.entries(effects.impactoCaja).map(([key, amount]) => [key, String(moneyCents(amount))])),
                credit: effects.cargoFiado ? { customer: effects.cargoFiado.cliente_id, amountCents: String(moneyCents(effects.cargoFiado.monto)), kind: effects.cargoFiado.tipo } : null,
                movements: effects.movimientosStock.map(m => ({ product: m.producto_id, delta: String(m.delta), scope: m.sucursal_id ?? null })),
                serials: effects.seriales,
                originalTurn: effects.venta.caja_id ?? null,
                localSyncFlag: effects.venta.estado_sincronizacion,
            } } };
        } catch (error) { return { ...scenario, expected: { error: (error as Error).message } }; }
    });
}

export async function turnCases() {
    const cases = [
        { id: 'cash-no-turn', method: 'efectivo' as const, open: 0, requested: false },
        { id: 'transfer-no-turn', method: 'transferencia' as const, open: 0, requested: false },
        { id: 'cash-open-turn', method: 'efectivo' as const, open: 1, requested: false },
        { id: 'cash-ambiguous-turn', method: 'efectivo' as const, open: 2, requested: false },
        { id: 'cash-changed-turn', method: 'efectivo' as const, open: 1, requested: true },
    ];
    const output = [];
    for (const scenario of cases) {
        // fake-indexeddb en proceso Node aislado, nunca IndexedDB de un cliente.
        const database = new VentaRDDatabase(`VentaRD_NativeFixture_${scenario.id}`);
        await database.open();
        try {
            await database.productos.add({ id: product, negocio_id: tenant, nombre: 'Producto sintético', codigo_barras: '0001',
                precio_venta: 100, costo: 70, stock_actual: 5, stock_minimo: 1, tasa_itbis: 0.18, tipo: 'simple', estado_sincronizacion: 1 });
            for (let index = 0; index < scenario.open; index++) {
                await database.cajas.add({ id: id(500 + index), negocio_id: tenant, sucursal_id: branch, estado: 'abierta',
                    monto_apertura: 0, fecha_apertura: date - 1000, fecha_actualizacion: date - 1000 });
            }
            const { numeroTicket: _ticket, ...command } = input({ metodoPago: scenario.method,
                cajaId: scenario.requested ? id(999) : undefined });
            void _ticket;
            let expected;
            try {
                const result = await confirmarVentaLocal(database, command, { crearId: effectId });
                expected = { ok: { originalTurn: result.efectos.venta.caja_id ?? null, method: result.efectos.venta.metodo_pago } };
            } catch (error) { expected = { error: (error as Error).message }; }
            output.push({ ...scenario, expected, after: { sales: await database.ventas.count(),
                stock: (await database.productos.get(product))?.stock_actual,
                movements: await database.movimientos_stock.count() } });
        } finally { database.close(); await database.delete(); }
    }
    return output;
}
