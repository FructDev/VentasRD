import type { VentaRDDatabase } from '@/lib/db/dexie';
import { normalizeMoney, normalizeQuantity, normalizeSale } from '../normalize';
import { parseReconciliationRequest } from '../schema';
import { ENTITY_NAMES, type Coverage, type EntityName, type ReconciliationRequest, type SnapshotRecords, type SourceSnapshot } from '../types';

const DAY = 86_400_000;
const RETENTION_DAYS: Partial<Record<EntityName, number>> = { ventas: 90, ventaDetalles: 90, movimientosStock: 30, devoluciones: 90, cortesCaja: 90 };

export interface LocalCaptureOptions {
    sourceId: string;
    deviceLabel?: string;
    /** Only a captured observation. It never causes a network request. */
    connectivityObserved?: boolean;
    clock?: () => number;
}

/** One transaction, read-only, over the current local vault. No worker import. */
export async function captureLocalSnapshot(database: VentaRDDatabase, rawRequest: ReconciliationRequest, options: LocalCaptureOptions): Promise<SourceSnapshot> {
    const request = parseReconciliationRequest(rawRequest);
    if (!options.sourceId || options.sourceId.length > 120) throw new Error('invalid sourceId');
    const now = options.clock ?? Date.now;
    const startedAt = now();
    if (request.asOf > startedAt) throw new Error('asOf is later than local capture');
    const tenant = request.negocioId;
    const branchMatch = (value: { sucursal_id?: string }) => !request.sucursalId || value.sucursal_id === request.sucursalId;
    const inPeriod = (date: number) => date >= request.desde && date <= request.hasta;

    const tables = [database.ventas, database.venta_detalles, database.productos, database.movimientos_stock,
        database.transacciones_fiado, database.seriales, database.devoluciones, database.cajas,
        database.cortes_caja, database.gastos, database.reparaciones, database.apartados];
    const snapshot = await database.transaction('r', tables, async () => {
        const [salesRaw, linesRaw, productsRaw, movesRaw, creditsRaw, serialsRaw, refundsRaw, cashRaw,
            cutsRaw, expensesRaw, repairsRaw, layawaysRaw] = await Promise.all([
            database.ventas.where('negocio_id').equals(tenant).toArray(),
            database.venta_detalles.toArray(), // includes pre-v10 lines without negocio_id
            database.productos.where('negocio_id').equals(tenant).toArray(),
            database.movimientos_stock.where('negocio_id').equals(tenant).toArray(),
            database.transacciones_fiado.where('negocio_id').equals(tenant).toArray(),
            database.seriales.where('negocio_id').equals(tenant).toArray(),
            database.devoluciones.where('negocio_id').equals(tenant).toArray(),
            database.cajas.where('negocio_id').equals(tenant).toArray(),
            database.cortes_caja.where('negocio_id').equals(tenant).toArray(),
            database.gastos.where('negocio_id').equals(tenant).toArray(),
            database.reparaciones.where('negocio_id').equals(tenant).toArray(),
            database.apartados.where('negocio_id').equals(tenant).toArray(),
        ]);
        const sales = salesRaw.filter(v => branchMatch(v) && inPeriod(v.fecha_creacion) && (!request.selectedIds?.ventas || request.selectedIds.ventas.includes(v.id)));
        const saleIds = new Set(sales.map(v => v.id));
        const products = productsRaw.filter(p => !request.selectedIds?.productos || request.selectedIds.productos.includes(p.id));
        const productIds = new Set(products.map(p => p.id));
        const crossTenantLineRefs = linesRaw.some(d => !!d.negocio_id && d.negocio_id !== tenant && (saleIds.has(d.venta_id) || productIds.has(d.producto_id)));
        const lines = linesRaw.filter(d => (!d.negocio_id || d.negocio_id === tenant) && (d.negocio_id === tenant || saleIds.has(d.venta_id) || productIds.has(d.producto_id)) && (!request.sucursalId || d.sucursal_id === request.sucursalId || saleIds.has(d.venta_id)) && (saleIds.has(d.venta_id) || inPeriod(d.fecha_creacion)));
        const movements = movesRaw.filter(m => branchMatch(m) && inPeriod(m.fecha_creacion) && (!request.selectedIds?.operaciones || (m.referencia_id && request.selectedIds.operaciones.includes(m.referencia_id))) && (!request.selectedIds?.productos || productIds.has(m.producto_id)));
        const credits = creditsRaw.filter(c => branchMatch(c) && (inPeriod(c.fecha_creacion) || (!!c.venta_id && saleIds.has(c.venta_id))));
        const serials = serialsRaw.filter(s => productIds.has(s.producto_id) || (!!s.venta_id && saleIds.has(s.venta_id)));
        const refunds = refundsRaw.filter(r => inPeriod(r.fecha_creacion) || saleIds.has(r.venta_id));
        const cash = cashRaw.filter(c => branchMatch(c));
        const cuts = cutsRaw.filter(c => branchMatch(c) && inPeriod(c.fecha_creacion));
        const expenses = expensesRaw.filter(e => branchMatch(e) && inPeriod(e.fecha_creacion));
        const repairs = repairsRaw.filter(r => branchMatch(r) && (inPeriod(r.fecha_creacion) || (r.pagos ?? []).some(p => inPeriod(p.fecha))));
        const layaways = layawaysRaw.filter(a => branchMatch(a) && (inPeriod(a.fecha_creacion) || a.abonos.some(p => inPeriod(p.fecha))));
        const observedAt = startedAt;
        const common = (row: { id: string; negocio_id: string; sucursal_id?: string }) => ({ id: row.id, negocioId: row.negocio_id, ...(row.sucursal_id && { sucursalId: row.sucursal_id }), sourceId: options.sourceId, observedAt });
        const records: SnapshotRecords = {
            ventas: sales.map(row => normalizeSale(row, options.sourceId, observedAt)),
            ventaDetalles: lines.map(row => ({ ...common({ ...row, negocio_id: row.negocio_id ?? tenant }), ventaId: row.venta_id, productoId: row.producto_id, cantidad: normalizeQuantity(row.cantidad), precioUnitario: normalizeMoney(row.precio_unitario), subtotal: normalizeMoney(row.subtotal), fecha: row.fecha_creacion, syncFlag: row.estado_sincronizacion })),
            productos: products.map(row => ({ ...common(row), stockMaterializado: normalizeQuantity(row.stock_actual), ...(row.fecha_actualizacion !== undefined && { fechaActualizacion: row.fecha_actualizacion }), syncFlag: row.estado_sincronizacion, tipo: row.tipo, serializable: row.serializable, eliminado: row.eliminado })),
            movimientosStock: movements.map(row => ({ ...common(row), productoId: row.producto_id, delta: normalizeQuantity(row.delta), ...(row.valor_absoluto !== undefined && { valorAbsoluto: normalizeQuantity(row.valor_absoluto) }), tipo: row.tipo, ...(row.referencia_id && { referenciaOperacionId: row.referencia_id }), fecha: row.fecha_creacion, syncFlag: row.estado_sincronizacion })),
            transaccionesFiado: credits.map(row => ({ ...common(row), ...(row.venta_id && { ventaId: row.venta_id }), clienteId: row.cliente_id, tipo: row.tipo, monto: normalizeMoney(row.monto), fecha: row.fecha_creacion })),
            seriales: serials.map(row => ({ ...common(row), productoId: row.producto_id, ...(row.venta_id && { ventaId: row.venta_id }), estado: row.estado, ...(row.fecha_venta != null && { fechaVenta: row.fecha_venta }) })),
            devoluciones: refunds.map(row => ({ ...common(row), ventaId: row.venta_id, monto: normalizeMoney(row.monto_devuelto), fecha: row.fecha_creacion })),
            cajas: cash.map(row => ({ ...common(row), estado: row.estado, fechaApertura: row.fecha_apertura, ...(row.fecha_cierre !== undefined && { fechaCierre: row.fecha_cierre }) })),
            cortesCaja: cuts.map(row => ({ ...common(row), cajaId: row.caja_id, tipo: row.tipo, fecha: row.fecha_creacion })),
            gastos: expenses.map(row => ({ ...common(row), monto: normalizeMoney(row.monto), fecha: row.fecha_creacion, metodo: row.metodo })),
            reparaciones: repairs.map(row => ({ ...common(row), fecha: row.fecha_creacion, pagos: (row.pagos ?? []).filter(p => inPeriod(p.fecha)).map(p => ({ monto: normalizeMoney(p.monto), fecha: p.fecha, metodo: p.metodo })) })),
            apartados: layaways.map(row => ({ ...common(row), fecha: row.fecha_creacion, abonos: row.abonos.filter(p => inPeriod(p.fecha)).map(p => ({ monto: normalizeMoney(p.monto), fecha: p.fecha, metodo: p.metodo })) })),
            reportes: [],
        };
        return { records, legacyLinesWithoutTenant: lines.some(d => !d.negocio_id), crossTenantLineRefs, branchlessSales: salesRaw.some(v => !v.sucursal_id && inPeriod(v.fecha_creacion)), branchlessMovements: movesRaw.some(m => !m.sucursal_id && inPeriod(m.fecha_creacion)) };
    });

    const finishedAt = now();
    if (finishedAt < startedAt) throw new Error('local capture clock moved backwards');
    const coverage: Coverage[] = ENTITY_NAMES.map(entity => {
        const retentionDays = RETENTION_DAYS[entity];
        const retentionHorizon = retentionDays ? finishedAt - retentionDays * DAY : undefined;
        const historicalGap = retentionHorizon !== undefined && request.desde < retentionHorizon;
        const branchGap = !!request.sucursalId && (entity === 'productos' || (entity === 'ventas' && snapshot.branchlessSales) || (entity === 'movimientosStock' && snapshot.branchlessMovements));
        const legacyGap = entity === 'ventaDetalles' && (snapshot.legacyLinesWithoutTenant || snapshot.crossTenantLineRefs);
        const unavailable = entity === 'reportes';
        const status = unavailable ? 'UNAVAILABLE' : historicalGap || branchGap || legacyGap ? 'PARTIAL' : 'COMPLETE';
        const timeScoped = entity !== 'productos' && entity !== 'seriales' && entity !== 'cajas';
        return {
            entity, scope: { negocioId: tenant, ...(request.sucursalId && { sucursalId: request.sucursalId }), ...(timeScoped && { desde: request.desde, hasta: request.hasta }) },
            status, startedAt, finishedAt, rowsRead: snapshot.records[entity].length, pagesRead: 1, exhausted: !unavailable,
            ...(retentionHorizon !== undefined && { retentionHorizon }), concurrentChangePossible: false,
            ...(unavailable ? { reason: 'NO_LOCAL_REPORT_TABLE' } : historicalGap ? { reason: 'LOCAL_RETENTION_WINDOW' } : branchGap ? { reason: 'BRANCH_SCOPE_UNKNOWN' } : snapshot.crossTenantLineRefs && entity === 'ventaDetalles' ? { reason: 'LINE_TENANT_CONFLICT' } : legacyGap ? { reason: 'LEGACY_TENANT_FIELD_MISSING' } : {}),
        } satisfies Coverage;
    });
    return { contractVersion: '1.0', source: { sourceId: options.sourceId, kind: 'LOCAL', ...(options.deviceLabel && { deviceLabel: options.deviceLabel }), negocioId: tenant, ...(request.sucursalId && { sucursalId: request.sucursalId }), serverIdentityVerified: false }, capture: { startedAt, finishedAt, asOf: request.asOf, temporalConsistency: 'COHERENT', connectivityObserved: options.connectivityObserved ?? false }, coverage, records: snapshot.records };
}
