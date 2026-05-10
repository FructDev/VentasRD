// src/lib/db/worker.ts
import { db } from './dexie';
import { supabase } from '../supabase/client';
import { useConfigStore } from '@/store/useConfigStore';

// ─── Singleton ────────────────────────────────────────────────────────────────
// Garantiza que nunca corra más de un intervalo de sync a la vez,
// aunque SyncProvider se desmonte y remonte (ej. navegación rápida).
let activeInterval: ReturnType<typeof setInterval> | null = null;

// ─── Timeout helper ───────────────────────────────────────────────────────────
// Lanza error si Supabase no responde en `ms` ms, liberando el flag isSyncing.
function withTimeout<T>(fn: () => PromiseLike<T>, ms = 8000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const id = setTimeout(() => reject(new Error('sync_timeout')), ms);
        Promise.resolve(fn()).then(
            v => { clearTimeout(id); resolve(v); },
            e => { clearTimeout(id); reject(e); }
        );
    });
}

// ─── Timestamps persistentes por entidad ──────────────────────────────────────
// Guardar el timestamp del último sync en localStorage evita re-descargar todo
// cada vez que se abre la app, y sobrevive reinicios del intervalo.
const TS_PREFIX = 'vrd_sync_';

function getSyncTs(key: string): number {
    try {
        return parseInt(localStorage.getItem(TS_PREFIX + key) || '0', 10) || 0;
    } catch {
        return 0;
    }
}

function setSyncTs(key: string, ts: number) {
    try {
        if (ts > 0) localStorage.setItem(TS_PREFIX + key, String(ts));
    } catch { /* quota exceeded — ignorar */ }
}

function maxTs(items: Array<{ fecha_actualizacion?: number | null }>): number {
    return items.reduce((m, i) => Math.max(m, i.fecha_actualizacion || 0), 0);
}

function maxCreacionTs(items: Array<{ fecha_creacion?: number | null }>): number {
    return items.reduce((m, i) => Math.max(m, i.fecha_creacion || 0), 0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isValidUUID = (s: string | null | undefined): boolean => !!s && UUID_RE.test(s);

// ─── Worker principal ─────────────────────────────────────────────────────────
export const startSyncWorker = (): ReturnType<typeof setInterval> => {
    // Si ya hay un intervalo activo, devolver el mismo (singleton)
    if (activeInterval !== null) return activeInterval;

    let isSyncing = false;
    let consecutiveErrors = 0; // backoff simple: si hay 3 errores seguidos, esperar

    activeInterval = setInterval(async () => {
        if (!navigator.onLine || isSyncing) return;

        // Backoff: si hay 3+ errores consecutivos, reducir intentos gradualmente
        if (consecutiveErrors >= 3) {
            consecutiveErrors--;
            return;
        }

        isSyncing = true;

        try {
            const { sucursalId, negocioId } = useConfigStore.getState();
            if (!negocioId) return;

            // ══════════════════════════════════════════════════════════════════
            // 1. PULL — Descargar de la nube
            // ══════════════════════════════════════════════════════════════════

            // ── 1.A  Sucursales (cache para modo offline) ─────────────────────
            // Siempre descargamos la lista completa (pocas filas, raramente cambia)
            const { data: cloudSucursales } = await withTimeout(() =>
                supabase.from('sucursales').select('id, negocio_id, nombre, direccion').eq('negocio_id', negocioId)
            );
            if (cloudSucursales && cloudSucursales.length > 0) {
                await db.sucursales.bulkPut(cloudSucursales);
            }

            // ── 1.B  Productos ────────────────────────────────────────────────
            const lastProdTs = getSyncTs('productos');
            const { data: cloudProducts, error: pullProdErr } = await withTimeout(() =>
                supabase.from('productos').select('*').eq('negocio_id', negocioId).gt('fecha_actualizacion', lastProdTs)
            );
            if (!pullProdErr && cloudProducts && cloudProducts.length > 0) {
                let cloudStockMap = new Map<string, { stock_actual: number; stock_minimo: number }>();
                if (sucursalId) {
                    const { data: stockData } = await withTimeout(() =>
                        supabase.from('inventario_sucursales')
                            .select('producto_id, stock_actual, stock_minimo')
                            .eq('sucursal_id', sucursalId)
                            .in('producto_id', cloudProducts.map(p => p.id))
                    );
                    if (stockData) stockData.forEach(s => cloudStockMap.set(s.producto_id, s));
                }
                // Para cada producto, si NO hay entrada en inventario_sucursales para esta
                // sucursal, conservar el stock local en lugar de sobreescribir con 0.
                const productosAInsertar = await Promise.all(cloudProducts.map(async p => {
                    const cloudStock = cloudStockMap.get(p.id);
                    if (cloudStock) {
                        // Hay dato confiable de la nube → usar siempre
                        return { ...p, stock_actual: cloudStock.stock_actual, stock_minimo: cloudStock.stock_minimo, estado_sincronizacion: 1 };
                    }
                    // Sin dato en la nube → preservar stock local si existe
                    const local = await db.productos.get(p.id);
                    return {
                        ...p,
                        stock_actual: local?.stock_actual ?? 0,
                        stock_minimo: local?.stock_minimo ?? 0,
                        estado_sincronizacion: 1,
                    };
                }));
                await db.productos.bulkPut(productosAInsertar);
                setSyncTs('productos', maxTs(cloudProducts));
            }

            // ── 1.C  Composiciones ────────────────────────────────────────────
            const lastCompTs = getSyncTs('composiciones');
            const { data: cloudComps, error: pullCompErr } = await withTimeout(() =>
                supabase.from('composiciones').select('*').gt('fecha_actualizacion', lastCompTs)
            );
            if (!pullCompErr && cloudComps && cloudComps.length > 0) {
                await db.composiciones.bulkPut(cloudComps.map(c => ({ ...c, estado_sincronizacion: 1 })));
                setSyncTs('composiciones', maxTs(cloudComps));
            }

            // ── 1.D  Clientes ─────────────────────────────────────────────────
            const lastClienteTs = getSyncTs('clientes');
            const { data: cloudClientes, error: pullClienteErr } = await withTimeout(() =>
                supabase.from('clientes').select('*').eq('negocio_id', negocioId).gt('fecha_actualizacion', lastClienteTs)
            );
            if (!pullClienteErr && cloudClientes && cloudClientes.length > 0) {
                await db.clientes.bulkPut(cloudClientes.map(c => ({ ...c, estado_sincronizacion: 1 })));
                setSyncTs('clientes', maxTs(cloudClientes));
            }

            // ── 1.E  Transacciones fiado ──────────────────────────────────────
            const lastTransTs = getSyncTs('transacciones_fiado');
            const { data: cloudTrans, error: pullTransErr } = await withTimeout(() =>
                supabase.from('transacciones_fiado').select('*').eq('negocio_id', negocioId).gt('fecha_actualizacion', lastTransTs)
            );
            if (!pullTransErr && cloudTrans && cloudTrans.length > 0) {
                await db.transacciones_fiado.bulkPut(cloudTrans.map(t => ({
                    ...t,
                    fecha_creacion: new Date(t.fecha_creacion).getTime(),
                    estado_sincronizacion: 1,
                })));
                setSyncTs('transacciones_fiado', maxTs(cloudTrans));
            }

            // ── 1.F  Ventas (NUEVO: descarga ventas de otros dispositivos) ────
            const lastVentasTs = getSyncTs('ventas');
            const { data: cloudVentas, error: pullVentasErr } = await withTimeout(() =>
                supabase.from('ventas').select('*').eq('negocio_id', negocioId).gt('fecha_creacion', lastVentasTs)
            );
            if (!pullVentasErr && cloudVentas && cloudVentas.length > 0) {
                await db.ventas.bulkPut(cloudVentas.map(v => ({ ...v, estado_sincronizacion: 1 })));
                setSyncTs('ventas', maxCreacionTs(cloudVentas));
            }

            // ── 1.G  Venta detalles (NUEVO) ───────────────────────────────────
            const lastDetallesTs = getSyncTs('venta_detalles');
            const { data: cloudDetalles, error: pullDetallesErr } = await withTimeout(() =>
                supabase.from('venta_detalles').select('*').eq('negocio_id', negocioId).gt('fecha_creacion', lastDetallesTs)
            );
            if (!pullDetallesErr && cloudDetalles && cloudDetalles.length > 0) {
                await db.venta_detalles.bulkPut(cloudDetalles.map(d => ({ ...d, estado_sincronizacion: 1 })));
                setSyncTs('venta_detalles', maxCreacionTs(cloudDetalles));
            }

            // ── 1.H  Cajas (NUEVO) ────────────────────────────────────────────
            const lastCajasTs = getSyncTs('cajas');
            const cajasQuery = sucursalId
                ? supabase.from('cajas').select('*').eq('negocio_id', negocioId).eq('sucursal_id', sucursalId).gt('fecha_actualizacion', lastCajasTs)
                : supabase.from('cajas').select('*').eq('negocio_id', negocioId).gt('fecha_actualizacion', lastCajasTs);
            const { data: cloudCajas, error: pullCajasErr } = await withTimeout(() => cajasQuery);
            if (!pullCajasErr && cloudCajas && cloudCajas.length > 0) {
                await db.cajas.bulkPut(cloudCajas.map(c => ({ ...c, estado_sincronizacion: 1 })));
                setSyncTs('cajas', maxTs(cloudCajas));
            }

            // ── 1.I  Devoluciones ─────────────────────────────────────────────
            const lastDevTs = getSyncTs('devoluciones');
            const { data: cloudDevs, error: pullDevErr } = await withTimeout(() =>
                supabase.from('devoluciones').select('*').eq('negocio_id', negocioId).gt('fecha_creacion', lastDevTs)
            );
            if (!pullDevErr && cloudDevs && cloudDevs.length > 0) {
                await db.devoluciones.bulkPut(cloudDevs.map(d => ({ ...d, estado_sincronizacion: 1 })));
                setSyncTs('devoluciones', maxCreacionTs(cloudDevs));
            }

            // ══════════════════════════════════════════════════════════════════
            // 2. PUSH — Subir a la nube
            // ══════════════════════════════════════════════════════════════════

            // ── 2.A  Ventas ───────────────────────────────────────────────────
            const ventasPendientes = await db.ventas.where('estado_sincronizacion').equals(0).toArray();
            for (const venta of ventasPendientes) {
                const { error } = await withTimeout(() =>
                    supabase.from('ventas').upsert({
                        id: venta.id,
                        negocio_id: venta.negocio_id,
                        sucursal_id: venta.sucursal_id || sucursalId,
                        numero_ticket: venta.numero_ticket,
                        total: venta.total,
                        metodo_pago: venta.metodo_pago,
                        fecha_creacion: venta.fecha_creacion,
                        // Pagos mixtos
                        ...(venta.monto_efectivo != null && { monto_efectivo: venta.monto_efectivo }),
                        ...(venta.monto_transferencia != null && { monto_transferencia: venta.monto_transferencia }),
                        // Fiado
                        ...(venta.cliente_id && { cliente_id: venta.cliente_id }),
                    })
                );
                if (!error) await db.ventas.update(venta.id, { estado_sincronizacion: 1 });
            }

            // ── 2.B  Venta detalles ───────────────────────────────────────────
            const detallesPendientes = (await db.venta_detalles.where('estado_sincronizacion').equals(0).toArray())
                .filter(d => isValidUUID(d.id) && isValidUUID(d.venta_id) && isValidUUID(d.producto_id));
            for (const detalle of detallesPendientes) {
                const payload = {
                    id: detalle.id,
                    venta_id: detalle.venta_id,
                    producto_id: detalle.producto_id,
                    negocio_id: detalle.negocio_id,
                    sucursal_id: detalle.sucursal_id || sucursalId || null,
                    cantidad: detalle.cantidad,
                    precio_unitario: detalle.precio_unitario,
                    subtotal: detalle.subtotal,
                    fecha_creacion: detalle.fecha_creacion,
                };
                const { error } = await withTimeout(() =>
                    supabase.from('venta_detalles').upsert(payload)
                );
                if (error) {
                    console.error('[sync] venta_detalles error:', error.code, error.message, error.details, error.hint, '\npayload:', payload);
                } else {
                    await db.venta_detalles.update(detalle.id, { estado_sincronizacion: 1 });
                }
            }

            // ── 2.C  Productos & inventario ───────────────────────────────────
            const prodPendientes = await db.productos.where('estado_sincronizacion').equals(0).toArray();
            if (prodPendientes.length > 0) {
                const { error: prodError } = await withTimeout(() =>
                    supabase.from('productos').upsert(
                        prodPendientes.map(p => ({
                            id: p.id,
                            negocio_id: p.negocio_id,
                            nombre: p.nombre,
                            codigo_barras: p.codigo_barras,
                            precio_venta: p.precio_venta,
                            costo: p.costo,
                            tasa_itbis: p.tasa_itbis,
                            tipo: p.tipo,
                            fecha_actualizacion: p.fecha_actualizacion || Date.now(),
                        }))
                    )
                );
                if (!prodError) {
                    let stockSyncOk = true;
                    if (sucursalId) {
                        const { error: stockError } = await withTimeout(() =>
                            supabase.from('inventario_sucursales').upsert(
                                prodPendientes.map(p => ({
                                    sucursal_id: sucursalId,
                                    producto_id: p.id,
                                    stock_actual: p.stock_actual,
                                    stock_minimo: p.stock_minimo,
                                    fecha_actualizacion: p.fecha_actualizacion || Date.now(),
                                })),
                                { onConflict: 'sucursal_id,producto_id' }
                            )
                        );
                        if (stockError) {
                            console.error('[sync] inventario_sucursales error:', stockError.message);
                            stockSyncOk = false;
                        }
                    }
                    // Solo marcar como sincronizado si el stock también subió correctamente
                    if (stockSyncOk) {
                        await db.productos.bulkPut(prodPendientes.map(p => ({ ...p, estado_sincronizacion: 1 })));
                    }
                }
            }

            // ── 2.D  Composiciones ────────────────────────────────────────────
            const compPendientes = await db.composiciones.where('estado_sincronizacion').equals(0).toArray();
            if (compPendientes.length > 0) {
                const { error: compError } = await withTimeout(() =>
                    supabase.from('composiciones').upsert(
                        compPendientes.map(c => ({
                            id: c.id,
                            producto_padre_id: c.producto_padre_id,
                            insumo_id: c.insumo_id,
                            cantidad_necesaria: c.cantidad_necesaria,
                            fecha_actualizacion: c.fecha_actualizacion || Date.now(),
                        }))
                    )
                );
                if (!compError) await db.composiciones.bulkPut(compPendientes.map(c => ({ ...c, estado_sincronizacion: 1 })));
            }

            // ── 2.E  Clientes ─────────────────────────────────────────────────
            const clientesPendientes = await db.clientes.where('estado_sincronizacion').equals(0).toArray();
            if (clientesPendientes.length > 0) {
                const { error: cliError } = await withTimeout(() =>
                    supabase.from('clientes').upsert(
                        clientesPendientes.map(c => ({
                            id: c.id,
                            negocio_id: c.negocio_id,
                            sucursal_id: sucursalId || null,
                            nombre: c.nombre,
                            telefono: c.telefono,
                            limite_credito: c.limite_credito,
                            fecha_actualizacion: c.fecha_actualizacion || Date.now(),
                        }))
                    )
                );
                if (!cliError) await db.clientes.bulkPut(clientesPendientes.map(c => ({ ...c, estado_sincronizacion: 1 })));
            }

            // ── 2.F  Transacciones fiado ──────────────────────────────────────
            const transPendientes = await db.transacciones_fiado.where('estado_sincronizacion').equals(0).toArray();
            if (transPendientes.length > 0) {
                const transPayload = transPendientes.map(t => ({
                    id: t.id,
                    negocio_id: t.negocio_id,
                    sucursal_id: t.sucursal_id || sucursalId || null,
                    cliente_id: t.cliente_id,
                    venta_id: t.venta_id,
                    tipo: t.tipo,
                    monto: t.monto,
                    concepto: t.concepto,
                    fecha_creacion: new Date(t.fecha_creacion).toISOString(),
                    fecha_actualizacion: t.fecha_actualizacion || Date.now(),
                }));
                const { error: transError } = await withTimeout(() =>
                    supabase.from('transacciones_fiado').upsert(transPayload)
                );
                if (transError) {
                    console.error('[sync] transacciones_fiado error:', transError.code, transError.message, transError.details, transError.hint, '\npayload[0]:', transPayload[0]);
                } else {
                    await db.transacciones_fiado.bulkPut(transPendientes.map(t => ({ ...t, estado_sincronizacion: 1 })));
                }
            }

            // ── 2.G  Cajas (NUEVO) ────────────────────────────────────────────
            const cajasPendientes = await db.cajas
                .filter(c => (c.estado_sincronizacion ?? 0) === 0)
                .toArray();
            for (const caja of cajasPendientes) {
                const { error } = await withTimeout(() =>
                    supabase.from('cajas').upsert({
                        id: caja.id,
                        negocio_id: caja.negocio_id,
                        sucursal_id: caja.sucursal_id || sucursalId,
                        estado: caja.estado,
                        monto_apertura: caja.monto_apertura,
                        monto_cierre: caja.monto_cierre,
                        monto_esperado: caja.monto_esperado,
                        diferencia: caja.diferencia,
                        denominaciones_apertura: caja.denominaciones_apertura,
                        denominaciones_cierre: caja.denominaciones_cierre,
                        fecha_apertura: caja.fecha_apertura,
                        fecha_cierre: caja.fecha_cierre,
                        fecha_actualizacion: caja.fecha_actualizacion || Date.now(),
                        notas: caja.notas,
                    })
                );
                if (!error) await db.cajas.update(caja.id, { estado_sincronizacion: 1 });
            }

            // ── 2.H  Devoluciones ────────────────────────────────────────────
            const devolucionesPendientes = await db.devoluciones.where('estado_sincronizacion').equals(0).toArray();
            for (const dev of devolucionesPendientes) {
                const { error } = await withTimeout(() =>
                    supabase.from('devoluciones').upsert({
                        id: dev.id,
                        negocio_id: dev.negocio_id,
                        venta_id: dev.venta_id,
                        items_devueltos: dev.items_devueltos,
                        monto_devuelto: dev.monto_devuelto,
                        razon: dev.razon,
                        fecha_creacion: dev.fecha_creacion,
                    })
                );
                if (!error) await db.devoluciones.update(dev.id, { estado_sincronizacion: 1 });
            }

            consecutiveErrors = 0;

        } catch (err) {
            consecutiveErrors++;
            const isTimeout = err instanceof Error && err.message === 'sync_timeout';
            console.error(`🚨 Error en sync worker (intento ${consecutiveErrors}):`, isTimeout ? 'timeout de Supabase' : err);
        } finally {
            isSyncing = false;
        }
    }, 15000);

    return activeInterval;
};

export const stopSyncWorker = () => {
    if (activeInterval !== null) {
        clearInterval(activeInterval);
        activeInterval = null;
    }
};
