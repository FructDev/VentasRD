import type { VentaDetalleLocal } from '@/types/database';

export function payloadDetalleRemoto(d: VentaDetalleLocal) {
    return { id: d.id, venta_id: d.venta_id, producto_id: d.sin_stock ? null : d.producto_id,
        negocio_id: d.negocio_id, sucursal_id: d.sucursal_id ?? null, nombre: d.nombre ?? null,
        cantidad: d.cantidad, precio_unitario: d.precio_unitario, subtotal: d.subtotal, fecha_creacion: d.fecha_creacion };
}
export function detalleDesdeRemoto(d: Omit<VentaDetalleLocal, 'producto_id' | 'estado_sincronizacion' | 'nombre' | 'sucursal_id'> & {
    producto_id: string | null; nombre?: string | null; sucursal_id?: string | null;
}): VentaDetalleLocal {
    return { ...d, producto_id: d.producto_id === null ? d.id : d.producto_id,
        nombre: d.nombre ?? undefined, sucursal_id: d.sucursal_id ?? undefined,
        ...(d.producto_id === null ? { sin_stock: true } : {}), estado_sincronizacion: 1 };
}
