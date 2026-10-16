import type { VentaRDDatabase } from '@/lib/db/dexie';
import { moneyCents } from '@/lib/domain/local/command';
import type {
    DevolucionLocal,
    TransaccionFiadoLocal,
    VentaDetalleLocal,
    VentaLocal,
} from '@/types/database';

function cantidadesVendidas(detalles: VentaDetalleLocal[]): Map<string, number> {
    const result = new Map<string, number>();
    for (const detalle of detalles) {
        result.set(detalle.producto_id, (result.get(detalle.producto_id) ?? 0) + detalle.cantidad);
    }
    return result;
}

function cantidadesDevueltas(devoluciones: DevolucionLocal[]): Map<string, number> {
    const result = new Map<string, number>();
    for (const devolucion of devoluciones) {
        for (const item of devolucion.items_devueltos) {
            result.set(item.producto_id, (result.get(item.producto_id) ?? 0) + item.cantidad);
        }
    }
    return result;
}

export function cantidadesDisponiblesParaDevolver(
    detalles: VentaDetalleLocal[],
    devolucionesPrevias: DevolucionLocal[],
): Map<string, number> {
    const vendidas = cantidadesVendidas(detalles);
    const devueltas = cantidadesDevueltas(devolucionesPrevias);
    const disponibles = new Map<string, number>();
    for (const [productoId, cantidad] of vendidas) {
        disponibles.set(productoId, Math.max(0, cantidad - (devueltas.get(productoId) ?? 0)));
    }
    return disponibles;
}

export function calcularMontoDevolucion(input: {
    venta: VentaLocal;
    detalles: VentaDetalleLocal[];
    devolucionesPrevias: DevolucionLocal[];
    cantidades: Map<string, number>;
}): number {
    const disponibles = cantidadesDisponiblesParaDevolver(input.detalles, input.devolucionesPrevias);
    let devuelveTodoLoPendiente = true;
    for (const [productoId, disponible] of disponibles) {
        const solicitada = input.cantidades.get(productoId) ?? 0;
        if (!Number.isSafeInteger(solicitada) || solicitada < 0 || solicitada > disponible) throw new Error('refund_quantity_exceeds_remaining');
        if (solicitada !== disponible) devuelveTodoLoPendiente = false;
    }
    for (const [productoId, qty] of input.cantidades) {
        if (!disponibles.has(productoId) || !Number.isSafeInteger(qty) || qty < 0) throw new Error('refund_quantity_exceeds_remaining');
    }
    const porProducto = new Map<string, { qty: number; bruto: bigint }>();
    let brutoVenta = BigInt(0);
    for (const d of input.detalles) {
        if (!Number.isSafeInteger(d.cantidad) || d.cantidad <= 0) throw new Error('refund_sale_basis_unavailable');
        const bruto = BigInt(moneyCents(d.subtotal || d.precio_unitario * d.cantidad));
        brutoVenta += bruto;
        const prev = porProducto.get(d.producto_id) ?? { qty: 0, bruto: BigInt(0) };
        prev.qty += d.cantidad; prev.bruto += bruto; porProducto.set(d.producto_id, prev);
    }
    if (brutoVenta <= BigInt(0)) throw new Error('refund_sale_basis_unavailable');
    // Suma racional exacta: líneas duplicadas se ponderan sin multiplicaciones
    // flotantes ni receta/precio actual. Redondeo half-up una sola vez, en centavos.
    let numerator = BigInt(0); let denominator = BigInt(1);
    for (const [id, qty] of input.cantidades) {
        const p = porProducto.get(id)!;
        const divisor = BigInt(p.qty);
        numerator = numerator * divisor + p.bruto * BigInt(qty) * denominator;
        denominator *= divisor;
    }
    const total = moneyCents(input.venta.total);
    const yaDevuelto = input.devolucionesPrevias.reduce((sum, d) => sum + moneyCents(d.monto_devuelto), 0);
    if (!Number.isSafeInteger(yaDevuelto)) throw new Error('importe_fuera_de_rango');
    const restante = Math.max(0, total - yaDevuelto);
    if (devuelveTodoLoPendiente) return restante / 100;
    const top = BigInt(total) * numerator;
    const bottom = denominator * brutoVenta;
    const cents = Number((top * BigInt(2) + bottom) / (bottom * BigInt(2)));
    return Math.min(restante, cents) / 100;
}

/**
 * `venta_id` no es indice de Dexie. La consulta parte del indice tenant-scoped
 * `negocio_id` y filtra en memoria para evitar SchemaError sin mezclar tenants.
 */
export async function buscarCargoFiadoDeVenta(
    database: VentaRDDatabase,
    negocioId: string,
    ventaId: string,
): Promise<TransaccionFiadoLocal | undefined> {
    return database.transacciones_fiado
        .where('negocio_id')
        .equals(negocioId)
        .filter(row => row.venta_id === ventaId && row.tipo === 'cargo')
        .first();
}
