import type { SupabaseClient } from '@supabase/supabase-js';
import type { RemotePage, RemoteQuery } from './remote-handler';

const columns = {
    ventas: 'id,negocio_id,sucursal_id,fecha_creacion,total,metodo_pago,monto_efectivo,monto_transferencia',
    ventaDetalles: 'id,negocio_id,sucursal_id,venta_id,producto_id,cantidad,precio_unitario,subtotal,fecha_creacion',
    productos: 'id,negocio_id,stock_actual,fecha_actualizacion,tipo,serializable,eliminado',
    movimientosStock: 'id,negocio_id,sucursal_id,producto_id,delta,valor_absoluto,tipo,referencia_id,fecha_creacion',
} as const;
const tables = { ventas: 'ventas', ventaDetalles: 'venta_detalles', productos: 'productos', movimientosStock: 'movimientos_stock' } as const;

function numeric(value: unknown): string { if (typeof value !== 'number' && typeof value !== 'string') throw new Error('INVALID_REMOTE_NUMBER'); return String(value); }
function timestamp(value: unknown): number { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_REMOTE_TIMESTAMP'); return n; }
function requiredString(value: unknown): string { if (typeof value !== 'string') throw new Error('INVALID_REMOTE_FIELD'); return value; }
function normalize(entity: RemoteQuery['entity'], row: Record<string, unknown>, observedAt: number): Record<string, unknown> {
    const base = { id: requiredString(row.id), negocioId: requiredString(row.negocio_id), ...(row.sucursal_id != null ? { sucursalId: requiredString(row.sucursal_id) } : {}), sourceId: 'supabase', observedAt };
    switch (entity) {
        case 'ventas': return { ...base, fecha: timestamp(row.fecha_creacion), total: numeric(row.total), metodoPago: requiredString(row.metodo_pago), ...(row.monto_efectivo != null && { montoEfectivo: numeric(row.monto_efectivo) }), ...(row.monto_transferencia != null && { montoTransferencia: numeric(row.monto_transferencia) }) };
        case 'ventaDetalles': return { ...base, ventaId: requiredString(row.venta_id), productoId: requiredString(row.producto_id), cantidad: numeric(row.cantidad), precioUnitario: numeric(row.precio_unitario), subtotal: numeric(row.subtotal), fecha: timestamp(row.fecha_creacion) };
        case 'productos': return { ...base, stockMaterializado: numeric(row.stock_actual), ...(row.fecha_actualizacion != null && { fechaActualizacion: timestamp(row.fecha_actualizacion) }), ...(row.tipo != null ? { tipo: requiredString(row.tipo) } : {}), ...(row.serializable != null && { serializable: row.serializable === true }), ...(row.eliminado != null && { eliminado: row.eliminado === true }) };
        case 'movimientosStock': return { ...base, productoId: requiredString(row.producto_id), ...(row.delta != null && { delta: numeric(row.delta) }), ...(row.valor_absoluto != null && { valorAbsoluto: numeric(row.valor_absoluto) }), tipo: requiredString(row.tipo), ...(row.referencia_id != null ? { referenciaOperacionId: requiredString(row.referencia_id) } : {}), fecha: timestamp(row.fecha_creacion) };
    }
}

/** Only projected SELECTs. The privileged client is supplied after server-side owner/admin verification. */
export async function readRemotePage(query: RemoteQuery, client: SupabaseClient): Promise<RemotePage> {
    if (query.limit < 1 || query.limit > 500 || query.offset < 0) throw new Error('INVALID_PAGE');
    if (query.entity === 'productos' && query.sucursalId) throw new Error('BRANCH_STOCK_UNAVAILABLE');
    const dateColumn = query.entity === 'productos' ? 'fecha_actualizacion' : 'fecha_creacion';
    let builder = client.from(tables[query.entity]).select(columns[query.entity]).eq('negocio_id', query.negocioId);
    if (query.sucursalId) builder = builder.eq('sucursal_id', query.sucursalId);
    if (query.id) builder = builder.eq('id', query.id);
    // Exact IDs must not disappear merely because a remote timestamp is missing or skewed.
    if (!query.id && query.desde !== undefined) builder = builder.gte(dateColumn, query.desde);
    if (!query.id && query.hasta !== undefined) builder = builder.lte(dateColumn, query.hasta);
    const { data, error } = await builder.order('id', { ascending: true }).range(query.offset, query.offset + query.limit);
    if (error || !data) throw new Error('REMOTE_SELECT_FAILED');
    const rows = data as unknown as Record<string, unknown>[];
    if (rows.some(row => row.negocio_id !== query.negocioId || (query.sucursalId && row.sucursal_id !== query.sucursalId) || (query.id && row.id !== query.id))) throw new Error('REMOTE_SCOPE_UNVERIFIED');
    const observedAt = Date.now();
    return { records: rows.slice(0, query.limit).map(row => normalize(query.entity, row, observedAt)), hasMore: rows.length > query.limit };
}
