// src/lib/exports/queries.ts
// Extractores de datos desde Dexie para reportes
import { db } from '@/lib/db/dexie';

const METODOS: Record<string, string> = {
    efectivo: 'Efectivo',
    tarjeta: 'Tarjeta',
    transferencia: 'Transferencia',
    fiado: 'Fiado',
    mixto: 'Mixto',
};

function fmtFecha(ts: number) {
    return new Date(ts).toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtHora(ts: number) {
    return new Date(ts).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
}

function fmtDOP(n: number) {
    return `RD$ ${n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── VENTAS ────────────────────────────────────────────────────────────────────

export async function getReporteVentas(negocioId: string, desde: number, hasta: number) {
    const ventas = await db.ventas
        .where('negocio_id').equals(negocioId)
        .filter(v => v.fecha_creacion >= desde && v.fecha_creacion <= hasta)
        .toArray();

    ventas.sort((a, b) => b.fecha_creacion - a.fecha_creacion);

    const detalles = await db.venta_detalles
        .where('negocio_id').equals(negocioId)
        .filter(d => {
            const v = ventas.find(v => v.id === d.venta_id);
            return !!v;
        })
        .toArray();

    const productoIds = [...new Set(detalles.map(d => d.producto_id))];
    const productos = await db.productos.bulkGet(productoIds);
    const prodMap = new Map(productos.filter(Boolean).map(p => [p!.id, p!]));

    const totalVentas = ventas.reduce((s, v) => s + v.total, 0);
    const totalItbis = ventas.reduce((s, v) => {
        const dets = detalles.filter(d => d.venta_id === v.id);
        return s + dets.reduce((sd, d) => {
            const prod = prodMap.get(d.producto_id);
            return sd + (prod ? d.subtotal * prod.tasa_itbis : 0);
        }, 0);
    }, 0);

    // Resumen por método de pago
    const porMetodo: Record<string, { count: number; total: number }> = {};
    for (const v of ventas) {
        if (!porMetodo[v.metodo_pago]) porMetodo[v.metodo_pago] = { count: 0, total: 0 };
        porMetodo[v.metodo_pago].count++;
        porMetodo[v.metodo_pago].total += v.total;
    }

    // Productos más vendidos
    const porProducto: Record<string, { nombre: string; cantidad: number; ingresos: number }> = {};
    for (const d of detalles) {
        const prod = prodMap.get(d.producto_id);
        if (!prod) continue;
        if (!porProducto[d.producto_id]) porProducto[d.producto_id] = { nombre: prod.nombre, cantidad: 0, ingresos: 0 };
        porProducto[d.producto_id].cantidad += d.cantidad;
        porProducto[d.producto_id].ingresos += d.subtotal;
    }
    const topProductos = Object.values(porProducto)
        .sort((a, b) => b.ingresos - a.ingresos)
        .slice(0, 50);

    return {
        resumen: { total: totalVentas, itbis: totalItbis, count: ventas.length, promedio: ventas.length ? totalVentas / ventas.length : 0 },
        ventas,
        detalles,
        prodMap,
        porMetodo,
        topProductos,
        fmtFecha, fmtHora, fmtDOP, METODOS,
    };
}

// ── INVENTARIO ────────────────────────────────────────────────────────────────

export async function getReporteInventario(negocioId: string) {
    const productos = await db.productos
        .where('negocio_id').equals(negocioId)
        .toArray();

    productos.sort((a, b) => a.nombre.localeCompare(b.nombre));

    const valorTotal = productos.reduce((s, p) => s + (p.costo * p.stock_actual), 0);
    const bajoStock = productos.filter(p => p.stock_actual > 0 && p.stock_actual <= p.stock_minimo).length;
    const sinStock = productos.filter(p => p.stock_actual <= 0).length;

    const TIPOS: Record<string, string> = { simple: 'Simple', insumo: 'Insumo', combo: 'Combo' };

    return { productos, valorTotal, bajoStock, sinStock, fmtDOP, TIPOS };
}

// ── FIADO / CLIENTES ──────────────────────────────────────────────────────────

export async function getReporteFiado(negocioId: string) {
    const clientes = await db.clientes
        .where('negocio_id').equals(negocioId)
        .toArray();

    const transacciones = await db.transacciones_fiado
        .where('negocio_id').equals(negocioId)
        .toArray();

    const balances = clientes.map(c => {
        const txs = transacciones.filter(t => t.cliente_id === c.id);
        const cargos = txs.filter(t => t.tipo === 'cargo').reduce((s, t) => s + t.monto, 0);
        const abonos = txs.filter(t => t.tipo === 'abono').reduce((s, t) => s + t.monto, 0);
        const balance = cargos - abonos;
        return { ...c, cargos, abonos, balance };
    }).filter(c => c.cargos > 0 || c.balance !== 0)
      .sort((a, b) => b.balance - a.balance);

    const totalDeuda = balances.reduce((s, c) => s + Math.max(0, c.balance), 0);

    return { balances, totalDeuda, fmtDOP, fmtFecha };
}

// ── NCF ───────────────────────────────────────────────────────────────────────

export async function getReporteNcf(negocioId: string, desde: number, hasta: number) {
    const ventas = await db.ventas
        .where('negocio_id').equals(negocioId)
        .filter(v => !!v.ncf && v.fecha_creacion >= desde && v.fecha_creacion <= hasta)
        .toArray();

    ventas.sort((a, b) => a.fecha_creacion - b.fecha_creacion);

    return { ventas, fmtFecha, fmtHora, fmtDOP, METODOS };
}
