// src/lib/db/worker.ts
import { db } from './dexie';
import { supabase } from '../supabase/client';
import { useConfigStore } from '@/store/useConfigStore';
import { productosConMovimientosPendientes } from './stock';
import type { ProductoLocal } from '@/types/database';

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

// Evita que el cursor de sync salte al futuro si un registro tiene un timestamp
// anómalo (skew de reloj, import erróneo, etc.). Sin este límite, un solo producto
// con fecha_actualizacion en el futuro envenenarÍa el cursor y dejaría de traer
// cualquier otra novedad hasta que el reloj del servidor alcance ese valor.
function clampTs(ts: number): number {
    return Math.min(ts, Date.now() + 60_000);
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

            // Productos con movimientos de stock aún no subidos: el pull no debe
            // pisar su stock local (la nube todavía no refleja esos movimientos)
            const movPendientes = await productosConMovimientosPendientes();

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
                const cloudStockMap = new Map<string, { stock_actual: number; stock_minimo: number; fecha_actualizacion?: number | null }>();
                if (sucursalId) {
                    const { data: stockData } = await withTimeout(() =>
                        supabase.from('inventario_sucursales')
                            .select('producto_id, stock_actual, stock_minimo, fecha_actualizacion')
                            .eq('sucursal_id', sucursalId)
                            .in('producto_id', cloudProducts.map(p => p.id))
                    );
                    if (stockData) stockData.forEach(s => cloudStockMap.set(s.producto_id, s));
                }
                const productosAInsertar = await Promise.all(cloudProducts.map(async p => {
                    const cloudStock = cloudStockMap.get(p.id);
                    const local = await db.productos.get(p.id);
                    const tieneCambiosPendientes = local?.estado_sincronizacion === 0;
                    // Movimientos sin subir: conservar el stock local pase lo que pase
                    const stockPendiente = movPendientes.has(p.id);

                    // stock_minimo es atributo del PRODUCTO (no de inventario_sucursales):
                    // siempre viene de la tabla productos. Si hay cambios locales sin subir,
                    // se respeta el local. NUNCA se toma de inventario_sucursales (que lo
                    // guarda en 0 por defecto y borraría el valor real).
                    const stockMinimoFinal = tieneCambiosPendientes
                        ? (local?.stock_minimo ?? p.stock_minimo ?? 0)
                        : (p.stock_minimo ?? local?.stock_minimo ?? 0);

                    // El stock_actual sí puede venir de inventario_sucursales (es por sucursal),
                    // usándolo solo si su timestamp es más reciente que el de productos.
                    if (cloudStock && !stockPendiente) {
                        const invTs = cloudStock.fecha_actualizacion ?? 0;
                        const prodTs = p.fecha_actualizacion ?? 0;
                        if (invTs >= prodTs) {
                            return { ...p, stock_actual: cloudStock.stock_actual, stock_minimo: stockMinimoFinal, estado_sincronizacion: 1 };
                        }
                    }

                    return {
                        ...p,
                        stock_actual: (stockPendiente || tieneCambiosPendientes)
                            ? (local?.stock_actual ?? p.stock_actual ?? 0)
                            : (p.stock_actual ?? local?.stock_actual ?? 0),
                        stock_minimo: stockMinimoFinal,
                        estado_sincronizacion: 1,
                    };
                }));
                // Separar los que vienen eliminados de la nube para borrarlos localmente
                const activos = productosAInsertar.filter(p => !p.eliminado);
                const eliminados = productosAInsertar.filter(p => p.eliminado);
                if (activos.length > 0) await db.productos.bulkPut(activos);
                if (eliminados.length > 0) {
                    await db.productos.bulkDelete(eliminados.map(p => p.id));
                    await Promise.all(eliminados.map(p =>
                        db.composiciones.where('producto_padre_id').equals(p.id).delete()
                    ));
                }
                setSyncTs('productos', clampTs(maxTs(cloudProducts)));
            }

            // ── 1.B.2  Reconciliación de stocks (cada 30 seg) ────────────────
            // El pull incremental puede perderse cambios de otros dispositivos si
            // su timestamp es anterior al lastProdTs local. Esta reconciliación
            // descarga el stock_actual de TODOS los productos desde Supabase y
            // actualiza Dexie ignorando timestamps, garantizando consistencia.
            const STOCK_RECON_KEY = 'vrd_stock_recon_ts';
            const STOCK_RECON_INTERVAL = 30 * 1000;
            const lastStockRecon = parseInt(localStorage.getItem(STOCK_RECON_KEY) || '0', 10);
            if (Date.now() - lastStockRecon > STOCK_RECON_INTERVAL) {
                const { data: allStocks } = await withTimeout(() =>
                    supabase
                        .from('productos')
                        .select('id, stock_actual, fecha_actualizacion')
                        .eq('negocio_id', negocioId)
                );
                if (allStocks && allStocks.length > 0) {
                    // Si hay sucursal, también traer stocks desde inventario_sucursales
                    const sucursalStockMap = new Map<string, number>();
                    if (sucursalId) {
                        const { data: invData } = await withTimeout(() =>
                            supabase
                                .from('inventario_sucursales')
                                .select('producto_id, stock_actual')
                                .eq('sucursal_id', sucursalId)
                        );
                        if (invData) {
                            (invData as { producto_id: string; stock_actual: number }[])
                                .forEach(s => sucursalStockMap.set(s.producto_id, s.stock_actual));
                        }
                    }

                    // Lectura en lote (1 operación en vez de N) para no trabar el
                    // hilo principal cada 30s con catálogos grandes.
                    const locales = await db.productos.bulkGet(allStocks.map(p => p.id));
                    const localMap = new Map<string, ProductoLocal>();
                    locales.forEach(l => { if (l) localMap.set(l.id, l); });

                    const reconciliados: ProductoLocal[] = [];
                    for (const cloudProd of allStocks) {
                        const local = localMap.get(cloudProd.id);
                        if (!local) continue;
                        // No tocar productos con cambios locales pendientes
                        if (local.estado_sincronizacion === 0) continue;
                        // Ni productos con movimientos de stock sin subir
                        if (movPendientes.has(cloudProd.id)) continue;

                        const stockCorrecto = sucursalStockMap.has(cloudProd.id)
                            ? sucursalStockMap.get(cloudProd.id)!
                            : (cloudProd.stock_actual ?? local.stock_actual);

                        if (local.stock_actual !== stockCorrecto) {
                            reconciliados.push({
                                ...local,
                                stock_actual: stockCorrecto,
                                fecha_actualizacion: cloudProd.fecha_actualizacion ?? local.fecha_actualizacion,
                            });
                        }
                    }
                    // Escritura en lote (1 operación en vez de N)
                    if (reconciliados.length > 0) await db.productos.bulkPut(reconciliados);
                }
                localStorage.setItem(STOCK_RECON_KEY, String(Date.now()));
            }

            // ── 1.B.4  Reconciliación de existencia (cada 5 min) ─────────────
            // Compara los IDs de la nube con los locales para: (a) eliminar los
            // que ya no existen en la nube, y (b) TRAER los que existen en la nube
            // pero faltan localmente (productos que se perdieron la ventana del
            // pull incremental, ej. insertados con fecha vieja o nula).
            const RECON_KEY = 'vrd_prod_recon_ts';
            const RECON_INTERVAL = 5 * 60 * 1000; // 5 minutos
            const lastRecon = parseInt(localStorage.getItem(RECON_KEY) || '0', 10);
            if (Date.now() - lastRecon > RECON_INTERVAL) {
                const { data: allIds } = await withTimeout(() =>
                    supabase.from('productos').select('id, eliminado').eq('negocio_id', negocioId)
                );
                if (allIds) {
                    const cloudActivos = new Set((allIds as { id: string; eliminado?: boolean }[])
                        .filter(r => !r.eliminado).map(r => r.id));
                    const locales = await db.productos.where('negocio_id').equals(negocioId).toArray();
                    // Solo contamos como "presentes localmente" los que NO están eliminados.
                    // Si un producto está marcado eliminado localmente pero sigue activo en la
                    // nube (push de borrado fallido o producto recreado en Supabase), se trata
                    // como faltante y se restaura desde la nube — Supabase es la fuente de verdad.
                    const localIds = new Set(locales.filter(p => !p.eliminado).map(p => p.id));

                    // (a) Borrar los sincronizados que ya no existen (o quedaron eliminados) en la nube
                    const obsoletos = locales.filter(p => !p.eliminado && p.estado_sincronizacion === 1 && !cloudActivos.has(p.id));
                    if (obsoletos.length > 0) {
                        await db.productos.bulkDelete(obsoletos.map(p => p.id));
                        await Promise.all(obsoletos.map(p =>
                            db.composiciones.where('producto_padre_id').equals(p.id).delete()
                        ));
                    }

                    // (b) Traer los activos de la nube que faltan localmente (incluye los
                    // que localmente están marcados eliminados pero la nube los tiene activos)
                    const faltantes = [...cloudActivos].filter(id => !localIds.has(id));
                    if (faltantes.length > 0) {
                        const { data: nuevos } = await withTimeout(() =>
                            supabase.from('productos').select('*').in('id', faltantes)
                        );
                        if (nuevos && nuevos.length > 0) {
                            await db.productos.bulkPut(nuevos.map(p => ({ ...p, estado_sincronizacion: 1 })));
                        }
                    }
                }
                localStorage.setItem(RECON_KEY, String(Date.now()));
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
                // Merge with local to preserve fields not yet in Supabase (e.g. ncf)
                const ventasMerged = await Promise.all(cloudVentas.map(async v => {
                    const local = await db.ventas.get(v.id);
                    return {
                        ...v,
                        ncf: v.ncf ?? local?.ncf ?? null,
                        vendedor_nombre: v.vendedor_nombre ?? local?.vendedor_nombre ?? null,
                        estado_sincronizacion: 1,
                    };
                }));
                await db.ventas.bulkPut(ventasMerged);
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

            // ── 1.K  Reparaciones (Plan Pro) ──────────────────────────────────
            const lastRepTs = getSyncTs('reparaciones');
            const { data: cloudReps, error: pullRepErr } = await withTimeout(() =>
                supabase.from('reparaciones').select('*').eq('negocio_id', negocioId).gt('fecha_actualizacion', lastRepTs)
            );
            if (!pullRepErr && cloudReps && cloudReps.length > 0) {
                // No pisar reparaciones con cambios locales sin subir
                const merged = await Promise.all(cloudReps.map(async r => {
                    const local = await db.reparaciones.get(r.id);
                    if (local && local.estado_sincronizacion === 0) return local;
                    return { ...r, estado_sincronizacion: 1 as const };
                }));
                await db.reparaciones.bulkPut(merged);
                setSyncTs('reparaciones', clampTs(maxTs(cloudReps)));
            }

            // ── 1.L  Apartados (Plan Pro) ─────────────────────────────────────
            const lastApTs = getSyncTs('apartados');
            const { data: cloudAps, error: pullApErr } = await withTimeout(() =>
                supabase.from('apartados').select('*').eq('negocio_id', negocioId).gt('fecha_actualizacion', lastApTs)
            );
            if (!pullApErr && cloudAps && cloudAps.length > 0) {
                const mergedAp = await Promise.all(cloudAps.map(async a => {
                    const local = await db.apartados.get(a.id);
                    if (local && local.estado_sincronizacion === 0) return local;
                    return { ...a, estado_sincronizacion: 1 as const };
                }));
                await db.apartados.bulkPut(mergedAp);
                setSyncTs('apartados', clampTs(maxTs(cloudAps)));
            }

            // ── 1.J  Seriales ─────────────────────────────────────────────────
            const lastSerialesTs = getSyncTs('seriales');
            const { data: cloudSeriales, error: pullSerialesErr } = await withTimeout(() =>
                supabase.from('seriales').select('*').eq('negocio_id', negocioId).gt('fecha_actualizacion', lastSerialesTs)
            );
            if (!pullSerialesErr && cloudSeriales && cloudSeriales.length > 0) {
                // No pisar seriales con cambios locales sin subir (ej. recién vendidos)
                const mergedSer = await Promise.all(cloudSeriales.map(async s => {
                    const local = await db.seriales.get(s.id);
                    if (local && local.estado_sincronizacion === 0) return local;
                    return { ...s, estado_sincronizacion: 1 as const };
                }));
                await db.seriales.bulkPut(mergedSer);
                setSyncTs('seriales', clampTs(maxTs(cloudSeriales)));
            }

            // ── 1.J.2  Gastos ─────────────────────────────────────────────────
            const lastGastosTs = getSyncTs('gastos');
            const { data: cloudGastos, error: pullGastosErr } = await withTimeout(() =>
                supabase.from('gastos').select('*').eq('negocio_id', negocioId).gt('fecha_actualizacion', lastGastosTs)
            );
            if (!pullGastosErr && cloudGastos && cloudGastos.length > 0) {
                await db.gastos.bulkPut(cloudGastos.map(g => ({ ...g, estado_sincronizacion: 1 })));
                setSyncTs('gastos', maxTs(cloudGastos));
            }

            // ── 1.K  Cortes de caja ───────────────────────────────────────────
            const lastCortesTs = getSyncTs('cortes_caja');
            const { data: cloudCortes, error: pullCortesErr } = await withTimeout(() =>
                supabase.from('cortes_caja').select('*').eq('negocio_id', negocioId).gt('fecha_creacion', lastCortesTs)
            );
            if (!pullCortesErr && cloudCortes && cloudCortes.length > 0) {
                await db.cortes_caja.bulkPut(cloudCortes.map(c => ({ ...c, estado_sincronizacion: 1 })));
                setSyncTs('cortes_caja', maxCreacionTs(cloudCortes));
            }

            // ── 1.L  NCF: secuencia centralizada con bloques por dispositivo ──
            try {
                const ncf = useConfigStore.getState().ncf;

                // 1.L.1 Sembrar la config legada a la nube (una sola vez por dispositivo).
                // ignoreDuplicates: si otra caja ya sembró, no se pisa nada.
                if (ncf.habilitado && !ncf.sembrado && ncf.hasta > 0) {
                    await withTimeout(() =>
                        supabase.from('ncf_secuencias').upsert({
                            negocio_id: negocioId,
                            tipo: ncf.tipo,
                            desde: ncf.desde,
                            hasta: ncf.hasta,
                            proximo: ncf.actual === 0 ? ncf.desde : ncf.actual + 1,
                            habilitado: true,
                        }, { onConflict: 'negocio_id', ignoreDuplicates: true })
                    );
                }

                // 1.L.2 Bajar el estado global de la secuencia
                const { data: sec } = await withTimeout(() =>
                    supabase.from('ncf_secuencias').select('*').eq('negocio_id', negocioId).maybeSingle()
                );
                if (sec) {
                    useConfigStore.setState(s => ({
                        ncf: {
                            ...s.ncf,
                            habilitado: sec.habilitado,
                            tipo: sec.tipo,
                            desde: Number(sec.desde),
                            hasta: Number(sec.hasta),
                            proximoGlobal: Number(sec.proximo),
                            sembrado: true,
                        },
                    }));

                    // 1.L.3 Reservar bloque si quedan pocos números locales
                    const bloques = useConfigStore.getState().ncf.bloques;
                    const restantes = bloques.reduce((s, b) => s + Math.max(0, b.hasta - b.proximo + 1), 0);
                    if (sec.habilitado && restantes <= 5 && Number(sec.proximo) <= Number(sec.hasta)) {
                        const { data: reserva } = await withTimeout(() =>
                            supabase.rpc('reservar_ncf', { p_negocio_id: negocioId, p_cantidad: 20 })
                        );
                        const b = Array.isArray(reserva) ? reserva[0] : reserva;
                        if (b?.bloque_desde != null) {
                            useConfigStore.setState(s => ({
                                ncf: {
                                    ...s.ncf,
                                    bloques: [
                                        ...s.ncf.bloques.filter(x => x.proximo <= x.hasta),
                                        { desde: Number(b.bloque_desde), hasta: Number(b.bloque_hasta), proximo: Number(b.bloque_desde) },
                                    ],
                                    proximoGlobal: Number(b.bloque_hasta) + 1,
                                },
                            }));
                        }
                    }
                }
            } catch (e) {
                console.error('[sync] ncf error:', e);
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
                        ...(venta.caja_codigo && { caja_codigo: venta.caja_codigo }),
                        total: venta.total,
                        metodo_pago: venta.metodo_pago,
                        fecha_creacion: venta.fecha_creacion,
                        // Pagos mixtos
                        ...(venta.monto_efectivo != null && { monto_efectivo: venta.monto_efectivo }),
                        ...(venta.monto_transferencia != null && { monto_transferencia: venta.monto_transferencia }),
                        // NCF
                        ...(venta.ncf && { ncf: venta.ncf }),
                        // Vendedor
                        ...(venta.vendedor_nombre && { vendedor_nombre: venta.vendedor_nombre }),
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
            const prodAEliminar = prodPendientes.filter(p => p.eliminado);
            const prodAUpsert   = prodPendientes.filter(p => !p.eliminado);

            // Eliminar de Supabase los productos borrados localmente
            for (const p of prodAEliminar) {
                const { error: delProdErr } = await withTimeout(() =>
                    supabase.from('productos').delete().eq('id', p.id)
                );
                if (!delProdErr) {
                    // Limpiar tablas relacionadas en Supabase
                    await Promise.all([
                        withTimeout(() => supabase.from('composiciones').delete().eq('producto_padre_id', p.id)),
                        withTimeout(() => supabase.from('inventario_sucursales').delete().eq('producto_id', p.id)),
                    ]);
                    // Hard-delete local ahora que está confirmado en la nube
                    await db.productos.delete(p.id);
                    await db.composiciones.where('producto_padre_id').equals(p.id).delete();
                }
            }

            // Upsert productos nuevos/editados
            if (prodAUpsert.length > 0) {
                const { error: prodError } = await withTimeout(() =>
                    supabase.from('productos').upsert(
                        prodAUpsert.map(p => ({
                            id: p.id,
                            negocio_id: p.negocio_id,
                            nombre: p.nombre,
                            codigo_barras: p.codigo_barras,
                            precio_venta: p.precio_venta,
                            ...(p.precio_2    != null && { precio_2: p.precio_2 }),
                            ...(p.precio_3    != null && { precio_3: p.precio_3 }),
                            ...(p.ubicacion          && { ubicacion: p.ubicacion }),
                            imagen_url: p.imagen_url ?? null, // null explícito: permite quitar la foto
                            ...(p.serializable       && { serializable: p.serializable }),
                            costo: p.costo,
                            tasa_itbis: p.tasa_itbis,
                            tipo: p.tipo,
                            // NOTA: stock_actual NO se sube aquí — viaja como movimientos
                            // atómicos (sección 2.C.2) para no pisar a otras cajas.
                            stock_minimo: p.stock_minimo,
                            fecha_actualizacion: p.fecha_actualizacion || Date.now(),
                        }))
                    )
                );
                if (prodError) {
                    console.error('[sync] productos error:', prodError.code, prodError.message, prodError.details);
                } else {
                    await db.productos.bulkPut(prodAUpsert.map(p => ({ ...p, estado_sincronizacion: 1 })));
                }
            }

            // ── 2.C.2  Movimientos de stock (deltas atómicos) ─────────────────
            // Cada movimiento se aplica en la nube con una RPC idempotente:
            // increment/decrement atómico — dos cajas nunca se pisan el stock.
            const movsPendientes = (await db.movimientos_stock
                .where('estado_sincronizacion').equals(0).toArray())
                .sort((a, b) => a.fecha_creacion - b.fecha_creacion);
            for (const mov of movsPendientes) {
                const { error: movErr } = await withTimeout(() =>
                    supabase.rpc('aplicar_movimiento_stock', {
                        p_id: mov.id,
                        p_negocio_id: mov.negocio_id,
                        p_sucursal_id: mov.sucursal_id ?? null,
                        p_producto_id: mov.producto_id,
                        p_delta: mov.delta,
                        p_tipo: mov.tipo,
                        p_referencia_id: mov.referencia_id ?? null,
                        p_fecha_creacion: mov.fecha_creacion,
                        p_valor_absoluto: mov.valor_absoluto ?? null,
                    })
                );
                if (movErr) {
                    console.error('[sync] movimiento_stock error:', movErr.code, movErr.message, movErr.details);
                    break; // mantener el orden: no aplicar movimientos posteriores si uno falla
                }
                await db.movimientos_stock.update(mov.id, { estado_sincronizacion: 1 });
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
                            tipo_precio: c.tipo_precio ?? 1,
                            al_por_mayor: c.al_por_mayor ?? false,
                            eliminado: c.eliminado ?? false,
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

            // ── 2.I  Seriales ─────────────────────────────────────────────────
            const serialesPendientes = await db.seriales.where('estado_sincronizacion').equals(0).toArray();
            if (serialesPendientes.length > 0) {
                const { error: serErr } = await withTimeout(() =>
                    supabase.from('seriales').upsert(
                        serialesPendientes.map(s => ({
                            id: s.id,
                            negocio_id: s.negocio_id,
                            producto_id: s.producto_id,
                            numero_serial: s.numero_serial,
                            estado: s.estado,
                            venta_id: s.venta_id ?? null,
                            fecha_venta: s.fecha_venta ?? null,
                            garantia_dias: s.garantia_dias ?? null,
                            garantia_hasta: s.garantia_hasta ?? null,
                            cliente_nombre: s.cliente_nombre ?? null,
                            precio_venta: s.precio_venta ?? null,
                            fecha_actualizacion: s.fecha_actualizacion,
                        }))
                    )
                );
                if (!serErr) await db.seriales.bulkPut(serialesPendientes.map(s => ({ ...s, estado_sincronizacion: 1 })));
            }

            // ── 2.I.2  Gastos ─────────────────────────────────────────────────
            const gastosPendientes = await db.gastos.where('estado_sincronizacion').equals(0).toArray();
            for (const gasto of gastosPendientes) {
                if (gasto.eliminado) {
                    // Soft delete local → borrar en la nube y luego localmente
                    const { error } = await withTimeout(() =>
                        supabase.from('gastos').delete().eq('id', gasto.id)
                    );
                    if (!error) await db.gastos.delete(gasto.id);
                    continue;
                }
                const { error } = await withTimeout(() =>
                    supabase.from('gastos').upsert({
                        id: gasto.id,
                        negocio_id: gasto.negocio_id,
                        sucursal_id: gasto.sucursal_id || sucursalId || null,
                        categoria: gasto.categoria,
                        descripcion: gasto.descripcion,
                        monto: gasto.monto,
                        metodo: gasto.metodo,
                        creado_por: gasto.creado_por ?? null,
                        fecha_creacion: gasto.fecha_creacion,
                        fecha_actualizacion: gasto.fecha_actualizacion || Date.now(),
                    })
                );
                if (error) {
                    console.error('[sync] gastos error:', error.code, error.message, error.details);
                } else {
                    await db.gastos.update(gasto.id, { estado_sincronizacion: 1 });
                }
            }

            // ── 2.J  Cortes de caja ───────────────────────────────────────────
            const cortesPendientes = await db.cortes_caja.where('estado_sincronizacion').equals(0).toArray();
            for (const corte of cortesPendientes) {
                const { error } = await withTimeout(() =>
                    supabase.from('cortes_caja').upsert({
                        id: corte.id,
                        negocio_id: corte.negocio_id,
                        caja_id: corte.caja_id,
                        sucursal_id: corte.sucursal_id || sucursalId || null,
                        tipo: corte.tipo,
                        fecha_creacion: corte.fecha_creacion,
                        efectivo: corte.efectivo,
                        tarjeta: corte.tarjeta,
                        transferencia: corte.transferencia,
                        fiado: corte.fiado,
                        mixto: corte.mixto,
                        total_ventas: corte.total_ventas,
                        cantidad_transacciones: corte.cantidad_transacciones,
                        monto_apertura: corte.monto_apertura ?? null,
                        monto_esperado: corte.monto_esperado ?? null,
                        monto_contado: corte.monto_contado ?? null,
                        diferencia: corte.diferencia ?? null,
                    })
                );
                if (!error) await db.cortes_caja.update(corte.id, { estado_sincronizacion: 1 });
            }

            // ── 2.K  Reparaciones (Plan Pro) ──────────────────────────────────
            const reparacionesPendientes = await db.reparaciones.where('estado_sincronizacion').equals(0).toArray();
            for (const rep of reparacionesPendientes) {
                const { error } = await withTimeout(() =>
                    supabase.from('reparaciones').upsert({
                        id: rep.id,
                        negocio_id: rep.negocio_id,
                        sucursal_id: rep.sucursal_id || sucursalId || null,
                        folio: rep.folio,
                        cliente_id: rep.cliente_id ?? null,
                        cliente_nombre: rep.cliente_nombre,
                        cliente_telefono: rep.cliente_telefono ?? null,
                        equipo_marca: rep.equipo_marca ?? null,
                        equipo_modelo: rep.equipo_modelo,
                        equipo_imei: rep.equipo_imei ?? null,
                        equipo_color: rep.equipo_color ?? null,
                        patron_clave: rep.patron_clave ?? null,
                        condicion_checklist: rep.condicion_checklist ?? [],
                        condicion_entrada: rep.condicion_entrada ?? null,
                        accesorios: rep.accesorios ?? null,
                        problema_reportado: rep.problema_reportado,
                        diagnostico: rep.diagnostico ?? null,
                        estado: rep.estado,
                        repuestos: rep.repuestos,
                        mano_obra: rep.mano_obra,
                        total: rep.total,
                        abono: rep.abono,
                        pagos: rep.pagos ?? [],
                        metodo_abono: rep.metodo_abono ?? null,
                        metodo_pago_final: rep.metodo_pago_final ?? null,
                        garantia_dias: rep.garantia_dias ?? null,
                        garantia_hasta: rep.garantia_hasta ?? null,
                        tecnico_nombre: rep.tecnico_nombre ?? null,
                        notas: rep.notas ?? null,
                        fecha_creacion: rep.fecha_creacion,
                        fecha_entrega: rep.fecha_entrega ?? null,
                        fecha_actualizacion: rep.fecha_actualizacion || Date.now(),
                    })
                );
                if (error) {
                    console.error('[sync] reparaciones error:', error.code, error.message, error.details);
                } else {
                    await db.reparaciones.update(rep.id, { estado_sincronizacion: 1 });
                }
            }

            // ── 2.L  Apartados (Plan Pro) ─────────────────────────────────────
            const apartadosPendientes = await db.apartados.where('estado_sincronizacion').equals(0).toArray();
            for (const ap of apartadosPendientes) {
                const { error } = await withTimeout(() =>
                    supabase.from('apartados').upsert({
                        id: ap.id,
                        negocio_id: ap.negocio_id,
                        sucursal_id: ap.sucursal_id || sucursalId || null,
                        folio: ap.folio,
                        cliente_id: ap.cliente_id ?? null,
                        cliente_nombre: ap.cliente_nombre,
                        cliente_telefono: ap.cliente_telefono ?? null,
                        items: ap.items,
                        total: ap.total,
                        abonado: ap.abonado,
                        abonos: ap.abonos,
                        estado: ap.estado,
                        notas: ap.notas ?? null,
                        fecha_creacion: ap.fecha_creacion,
                        fecha_completado: ap.fecha_completado ?? null,
                        fecha_cancelado: ap.fecha_cancelado ?? null,
                        fecha_actualizacion: ap.fecha_actualizacion || Date.now(),
                    })
                );
                if (error) {
                    console.error('[sync] apartados error:', error.code, error.message, error.details);
                } else {
                    await db.apartados.update(ap.id, { estado_sincronizacion: 1 });
                }
            }

            // ══════════════════════════════════════════════════════════════════
            // 3. PURGA LOCAL — mantener IndexedDB liviano (1 vez al día)
            // Borra datos viejos YA SINCRONIZADOS. Supabase conserva todo;
            // los reportes de rangos antiguos consultan la nube.
            // ══════════════════════════════════════════════════════════════════
            const PURGE_KEY = 'vrd_purge_ts';
            const PURGE_INTERVAL = 24 * 60 * 60 * 1000;
            const lastPurge = parseInt(localStorage.getItem(PURGE_KEY) || '0', 10);
            if (Date.now() - lastPurge > PURGE_INTERVAL) {
                const corte90d = Date.now() - 90 * 24 * 60 * 60 * 1000;
                const corte30d = Date.now() - 30 * 24 * 60 * 60 * 1000;

                // Ventas sincronizadas con más de 90 días (y sus detalles)
                const ventasViejas = await db.ventas
                    .where('fecha_creacion').below(corte90d)
                    .filter(v => v.estado_sincronizacion === 1)
                    .toArray();
                if (ventasViejas.length > 0) {
                    const ids = ventasViejas.map(v => v.id);
                    await db.venta_detalles.where('venta_id').anyOf(ids).delete();
                    await db.ventas.bulkDelete(ids);
                }

                // Movimientos de stock sincronizados con más de 30 días
                // (son solo el outbox local — el kardex completo vive en la nube)
                await db.movimientos_stock
                    .where('fecha_creacion').below(corte30d)
                    .filter(m => m.estado_sincronizacion === 1)
                    .delete();

                // Devoluciones y cortes sincronizados con más de 90 días
                await db.devoluciones
                    .where('fecha_creacion').below(corte90d)
                    .filter(d => d.estado_sincronizacion === 1)
                    .delete();
                await db.cortes_caja
                    .where('fecha_creacion').below(corte90d)
                    .filter(c => c.estado_sincronizacion === 1)
                    .delete();
                await db.gastos
                    .where('fecha_creacion').below(corte90d)
                    .filter(g => g.estado_sincronizacion === 1 && !g.eliminado)
                    .delete();

                localStorage.setItem(PURGE_KEY, String(Date.now()));
                if (ventasViejas.length > 0) {
                    console.log(`[purge] ${ventasViejas.length} ventas antiguas archivadas (siguen en la nube)`);
                }
            }

            consecutiveErrors = 0;

        } catch (err) {
            consecutiveErrors++;
            const isTimeout = err instanceof Error && err.message === 'sync_timeout';
            console.error(`🚨 Error en sync worker (intento ${consecutiveErrors}):`, isTimeout ? 'timeout de Supabase' : err);
            // Reportar a Sentry (los timeouts son ruido normal de conexiones lentas)
            if (!isTimeout && consecutiveErrors === 1) {
                import('@sentry/nextjs').then(Sentry => {
                    Sentry.captureException(err, { tags: { origen: 'sync_worker' } });
                }).catch(() => { });
            }
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
