import type { DevolucionLocal, ProductoLocal, VentaDetalleLocal, VentaLocal } from '@/types/database';

export interface EntradaResumenVentas {
    negocioId: string;
    desde: number;
    hasta: number;
    /** Incluye ventas anteriores enlazadas a devoluciones del período. */
    ventas: VentaLocal[];
    detalles: VentaDetalleLocal[];
    productos: ProductoLocal[];
    devoluciones: DevolucionLocal[];
    vendedor?: string;
}

export interface EventoResumenVentas {
    id: string;
    tipo: 'venta' | 'devolucion';
    fecha: number;
    monto: number;
    metodo: string;
    vendedor: string;
}

const centavos = (monto: number) => Math.round((monto + Number.EPSILON) * 100);

/**
 * Vista financiera por fecha de evento: no modifica ni elimina ventas.
 * El total monetario usa importes persistidos (incluyen descuentos/ITBIS).
 * El margen excluye ITBIS y es ESTIMADO: el esquema no guarda costo histórico.
 * Un historial/costo insuficiente nunca se convierte en ganancia cero.
 */
export function resumirVentas(input: EntradaResumenVentas) {
    const enPeriodo = (fecha: number) => fecha >= input.desde && fecha <= input.hasta;
    const ventas = new Map(input.ventas.filter(v => v.negocio_id === input.negocioId).map(v => [v.id, v]));
    const productos = new Map(input.productos.filter(p => p.negocio_id === input.negocioId).map(p => [p.id, p]));
    const limitaciones = new Set<string>();
    const eventos: EventoResumenVentas[] = [];
    const cantidadesDevueltas = new Map<string, Map<string, number>>();
    const detalles = new Map<string, VentaDetalleLocal[]>();
    for (const d of input.detalles) {
        if (d.negocio_id !== input.negocioId || !ventas.has(d.venta_id)) continue;
        const filas = detalles.get(d.venta_id) ?? [];
        filas.push(d);
        detalles.set(d.venta_id, filas);
    }
    const ventaVisible = (v: VentaLocal) => input.vendedor === undefined || v.vendedor_nombre === input.vendedor;
    for (const v of ventas.values()) {
        if (!enPeriodo(v.fecha_creacion) || !ventaVisible(v)) continue;
        eventos.push({ id: v.id, tipo: 'venta', fecha: v.fecha_creacion, monto: centavos(v.total) / 100, metodo: v.metodo_pago, vendedor: v.vendedor_nombre || 'Dueño' });
    }
    for (const r of input.devoluciones) {
        if (r.negocio_id !== input.negocioId || !enPeriodo(r.fecha_creacion)) continue;
        const v = ventas.get(r.venta_id);
        if (input.vendedor !== undefined && (!v || !ventaVisible(v))) continue;
        eventos.push({ id: r.id, tipo: 'devolucion', fecha: r.fecha_creacion, monto: -centavos(r.monto_devuelto) / 100, metodo: v?.metodo_pago ?? 'desconocido', vendedor: v?.vendedor_nombre || (v ? 'Dueño' : 'No verificable') });
        if (!v) limitaciones.add('Venta original de devolución no disponible; margen no verificable.');
        const cantidades = cantidadesDevueltas.get(r.venta_id) ?? new Map<string, number>();
        for (const item of r.items_devueltos) {
            cantidades.set(item.producto_id, (cantidades.get(item.producto_id) ?? 0) + item.cantidad);
        }
        cantidadesDevueltas.set(r.venta_id, cantidades);
        if (r.items_devueltos.length === 0 && r.monto_devuelto !== 0) limitaciones.add('Devolución sin unidades: reversión de margen no verificable.');
    }
    eventos.sort((a, b) => a.fecha - b.fecha || a.tipo.localeCompare(b.tipo) || a.id.localeCompare(b.id));
    const idsAfectados = new Set([...eventos.filter(e => e.tipo === 'venta').map(e => e.id), ...cantidadesDevueltas.keys()]);
    let margen = 0;
    let gananciaEstimada = false;
    for (const id of [...idsAfectados].sort()) {
        const v = ventas.get(id);
        const filas = (detalles.get(id) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
        if (!v || !filas.length) {
            limitaciones.add('Detalles originales incompletos; margen no verificable.');
            continue;
        }
        const vendidas = new Map<string, number>();
        for (const d of filas) vendidas.set(d.producto_id, (vendidas.get(d.producto_id) ?? 0) + d.cantidad);
        const devueltas = cantidadesDevueltas.get(id) ?? new Map<string, number>();
        for (const [productoId, cantidad] of devueltas) {
            if (!Number.isFinite(cantidad) || cantidad < 0 || cantidad > (vendidas.get(productoId) ?? 0)) {
                limitaciones.add('Unidades devueltas incompatibles con detalles originales; margen no verificable.');
            }
        }
        for (const d of filas) {
            if (d.cantidad <= 0 || !Number.isFinite(d.cantidad)) {
                limitaciones.add('Cantidad original inválida; margen no verificable.');
                continue;
            }
            const fraccionDevuelta = (devueltas.get(d.producto_id) ?? 0) / vendidas.get(d.producto_id)!;
            const cantidadNeta = d.cantidad * ((enPeriodo(v.fecha_creacion) ? 1 : 0) - fraccionDevuelta);
            if (cantidadNeta === 0) continue; // Reversión completa no necesita inventar costo.
            if (d.sin_stock === true) {
                limitaciones.add('Venta libre sin costo histórico registrado; margen no verificable.');
                continue;
            }
            const p = productos.get(d.producto_id);
            if (!p || !Number.isFinite(p.costo) || !Number.isFinite(d.precio_unitario)) {
                limitaciones.add('Costo histórico no guardado y costo actual no disponible; margen no verificable.');
                continue;
            }
            margen += (d.precio_unitario - p.costo) * cantidadNeta;
            gananciaEstimada = true;
        }
    }
    const totalVentas = eventos.reduce((s, e) => s + centavos(e.monto), 0) / 100;
    const cantidadVentas = eventos.filter(e => e.tipo === 'venta').length;
    return {
        totalVentas,
        totalDevoluciones: -eventos.filter(e => e.tipo === 'devolucion').reduce((s, e) => s + centavos(e.monto), 0) / 100 || 0,
        cantidadVentas,
        cantidadDevoluciones: eventos.filter(e => e.tipo === 'devolucion').length,
        ticketPromedio: cantidadVentas ? centavos(totalVentas / cantidadVentas) / 100 : 0,
        gananciaBruta: limitaciones.size ? null : centavos(margen) / 100,
        gananciaEstimada,
        limitaciones: [...limitaciones].sort(),
        eventos,
    };
}
