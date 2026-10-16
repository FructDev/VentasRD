// src/lib/db/worker.ts
import { db } from './dexie';
import { supabase } from '../supabase/client';
import { useConfigStore } from '@/store/useConfigStore';
import { productosConMovimientosPendientes } from './stock';
import { iniciarMedicion, marcarSyncActivo, registrarMetrica, type ResultadoMetrica } from '../rendimiento';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { InventoryRemoteClient } from '@/lib/sync/inventory/remote-client';
import { createInventoryHttpTransport } from '@/lib/sync/inventory/http-transport';
import { InventoryOperationRepository } from '@/lib/sync/inventory/repository';
import { procesarColaInventario } from '@/lib/sync/inventory/worker-outbox';
import { inventoryReceiverMode, startInventoryReceiver } from '@/lib/sync/inventory/receiver';
import { startInventorySender } from '@/lib/sync/inventory/sender';
import { prepareInventoryProduct } from '@/lib/sync/inventory/bootstrap';
import { InventoryRemoteError } from '@/lib/sync/inventory/remote-client';
import { captureCatalogBaseline, persistRemoteCatalog } from '@/lib/sync/catalog-pull';
import { readCompletePages } from '@/lib/sync/read-complete-pages';
import { syncStorageKey } from '@/lib/sync/scope-storage';
import { syncQuiescence } from '@/lib/sync/quiescence';
import type { InventoryScope } from '@/lib/sync/inventory/contract';
import type { Table } from 'dexie';
import { acknowledgeSyncedSnapshot, removeSyncedSnapshot, pendingTenantRows, pullTenantRows, historyPullFloor, type BusinessSyncRow } from '@/lib/sync/tenant-rows';
import { purgeAcknowledgedHistory } from '@/lib/sync/retention';
import { payloadFiadoRemoto } from '@/lib/domain/fiado/abonos';
import { payloadDetalleRemoto, detalleDesdeRemoto } from '@/lib/sync/sale-details';
import { abastecerNcfLocal } from '@/lib/domain/ventas/ncfLocal';
import {sharedWebEnabled,refreshSharedWorker,runSharedWorkerCycle,resetSharedWorker} from '@/lib/sync/shared-worker';

// ─── Singleton ────────────────────────────────────────────────────────────────
// Garantiza que nunca corra más de un intervalo de sync a la vez,
// aunque SyncProvider se desmonte y remonte (ej. navegación rápida).
let activeInterval: ReturnType<typeof setInterval> | null = null;
let syncGeneration = 0;
// Referencias a los listeners para poder removerlos en stopSyncWorker.
let onVisibilidad: (() => void) | null = null;
let onOnline: (() => void) | null = null;
let inventoryReceiver: ReturnType<typeof startInventoryReceiver> | null = null;
let inventorySender: ReturnType<typeof startInventorySender> | null = null;
let unsubscribeInventoryAuth: (() => void) | null = null;
let unsubscribeInventoryScope: (() => void) | null = null;

function inventoryRemoteClient() {
    return new InventoryRemoteClient({ ...createInventoryHttpTransport({
        baseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
        publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
        getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    }), from: table => supabase.from(table) });
}

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

// ─── Protección de cambios pendientes ─────────────────────────────────────────
// Un pull nunca debe pisar una fila que el dispositivo todavía no ha subido.
// Antes, el bulkPut sobrescribía el dato local Y lo marcaba como sincronizado:
// la edición hecha sin señal se perdía en silencio, sin error y sin log.
// Regla: si la fila local está pendiente (estado_sincronizacion === 0), gana ella
// — el push de este mismo ciclo la mandará a la nube.
type FilaSincronizable = { id: string; estado_sincronizacion?: 0 | 1 };

async function sinPisarPendientes<T extends FilaSincronizable>(
    tabla: { bulkGet: (ids: string[]) => Promise<(T | undefined)[]> },
    filasNube: T[],
    mapear: (fila: T) => T = f => f,
): Promise<T[]> {
    const locales = await tabla.bulkGet(filasNube.map(f => f.id));
    return filasNube.map((fila, i) => {
        const local = locales[i];
        if (local?.estado_sincronizacion === 0) return local;
        return { ...mapear(fila), estado_sincronizacion: 1 as const };
    });
}

// ─── Timestamps persistentes por entidad ──────────────────────────────────────
// Guardar el timestamp del último sync en localStorage evita re-descargar todo
// cada vez que se abre la app, y sobrevive reinicios del intervalo.
const TS_PREFIX = 'vrd_sync_';

function readSyncTs(key: string, scope: InventoryScope): number {
    try {
        return parseInt(localStorage.getItem(syncStorageKey(TS_PREFIX, key, scope)) || '0', 10) || 0;
    } catch {
        return 0;
    }
}

function writeSyncTs(key: string, ts: number, scope: InventoryScope) {
    try {
        if (ts > 0) localStorage.setItem(syncStorageKey(TS_PREFIX, key, scope), String(ts));
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

// ─── Realtime: stock entre cajas al instante ─────────────────────────────────
// El sync por intervalo se pausa con la pestaña en segundo plano (perf), pero
// la PC del taller vive minimizada: un repuesto vendido en la caja tardaba
// minutos u horas en reflejarse allá — riesgo de usar una pieza YA VENDIDA.
// El websocket de Supabase Realtime entrega el evento AL INSTANTE, incluso con
// la pestaña oculta: al llegar un movimiento de otra caja, se refresca ese
// producto puntualmente (2 lecturas de 1 fila, costo mínimo).
let realtimeNegocio: string | null = null;
let realtimeStockChannel: RealtimeChannel | null = null;

async function limpiarCanalRealtimeStock(): Promise<void> {
    // getChannels también cubre Fast Refresh: el módulo nuevo puede perder su
    // referencia, pero el cliente Supabase conserva el canal anterior.
    const canalesStock = supabase.getChannels().filter(c => c.topic.startsWith('realtime:stock-'));
    await Promise.allSettled(canalesStock.map(c => supabase.removeChannel(c)));
    realtimeStockChannel = null;
    realtimeNegocio = null;
}

async function suscribirRealtimeStock(negocioId: string): Promise<void> {
    if (realtimeNegocio === negocioId && realtimeStockChannel) return;
    await limpiarCanalRealtimeStock();

    realtimeStockChannel = supabase
        .channel(`stock-${negocioId}`)
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'movimientos_stock',
            filter: `negocio_id=eq.${negocioId}`,
        }, async (payload) => {
            const finishActivity = syncQuiescence.enter();
            if (!finishActivity) return; // Durable pull catches notifications after update/failure.
            const inicioRealtime = performance.now();
            try {
                const m = payload.new as { id: string; producto_id: string; fecha_creacion?: number };
                if (!m?.producto_id) return;
                void inventoryReceiver?.wake();
                const current = useConfigStore.getState();
                if (current.negocioId !== negocioId) return;
                const scope = { negocioId, sucursalId: current.sucursalId ?? null };
                const baseline = await captureCatalogBaseline(db, scope, [m.producto_id]);
                // ¿Es un movimiento nuestro? Ya está aplicado localmente.
                if (await db.movimientos_stock.get(m.id)) return;
                // Con cambios locales pendientes de ese producto, manda el recon.
                const pendientes = await productosConMovimientosPendientes();
                if (pendientes.has(m.producto_id)) return;
                const local = await db.productos.get(m.producto_id);
                if (!local || local.estado_sincronizacion === 0) return;

                // Refresco puntual del producto desde la nube
                const { data: prod, error: prodError } = await withTimeout(() => supabase
                    .from('productos')
                    .select('*')
                    .eq('negocio_id', negocioId)
                    .eq('id', m.producto_id)
                    .maybeSingle());
                if (prodError || !prod) return;
                const branchStocks = new Map<string, number>();
                if (scope.sucursalId) {
                    const { data: inv, error: invError } = await withTimeout(() => supabase
                        .from('inventario_sucursales')
                        .select('stock_actual')
                        .eq('sucursal_id', scope.sucursalId)
                        .eq('producto_id', m.producto_id)
                        .maybeSingle());
                    if (invError || !inv) return;
                    branchStocks.set(m.producto_id, inv.stock_actual);
                }
                const result = await persistRemoteCatalog({ database: db, scope, baseline,
                    products: [prod], branchStocks, mode: 'STOCK_ONLY',
                    isCurrentScope: () => {
                        const state = useConfigStore.getState();
                        return state.negocioId === scope.negocioId && (state.sucursalId ?? null) === scope.sucursalId;
                    },
                });
                registrarMetrica('stock.realtime_aplicacion', performance.now() - inicioRealtime, result.deferred ? 'cancelada' : 'ok', {
                    retrasoRelojMs: m.fecha_creacion ? Math.max(0, Date.now() - m.fecha_creacion) : null,
                });
            } catch (e) {
                registrarMetrica('stock.realtime_aplicacion', performance.now() - inicioRealtime, 'error');
                console.warn('[realtime-stock]', e);
            } finally {
                finishActivity();
            }
        })
        .subscribe();
    realtimeNegocio = negocioId;
}

// ─── Worker principal ─────────────────────────────────────────────────────────
export const startSyncWorker = (): ReturnType<typeof setInterval> => {
    // Si ya hay un intervalo activo, devolver el mismo (singleton)
    if (activeInterval !== null) return activeInterval;
    const generation = ++syncGeneration;
    const completedScopeSnapshots = new Set<string>();
    const live = () => generation === syncGeneration;
    refreshSharedWorker();

    let isSyncing = false;
    let queuedScopeTick = false;
    let consecutiveErrors = 0; // backoff simple: si hay 3 errores seguidos, esperar
    inventoryReceiver = startInventoryReceiver({
        database: db, remote: inventoryRemoteClient(),
        getScope: () => {
            const current = useConfigStore.getState();
            return current.negocioId ? { negocioId: current.negocioId, sucursalId: current.sucursalId ?? null } : null;
        },
        getMode: scope => sharedWebEnabled(scope.negocioId) ? 'PAUSED' : inventoryReceiverMode(process.env.NEXT_PUBLIC_SUPABASE_URL,
            process.env.NEXT_PUBLIC_VENTARD_INVENTORY_FEED_MODE, scope),
        online: () => navigator.onLine, visible: () => !document.hidden,
        reportError: code => console.warn(`[sync] ${code}: cursor y pendientes conservados`),
    });
    inventorySender = startInventorySender({
        database: db, remote: inventoryRemoteClient(),
        getScope: () => {
            const current = useConfigStore.getState();
            return current.negocioId && current.sucursalId
                ? { negocioId: current.negocioId, sucursalId: current.sucursalId } : null;
        },
        getMode: scope => sharedWebEnabled(scope.negocioId) ? 'PAUSED' : inventoryReceiverMode(process.env.NEXT_PUBLIC_SUPABASE_URL,
            process.env.NEXT_PUBLIC_VENTARD_INVENTORY_FEED_MODE, scope),
        online: () => navigator.onLine, visible: () => !document.hidden,
        reportError: code => console.warn(`[sync] ${code}: pendientes conservados`),
        reportResult: (result, elapsedMs) => {
            registrarMetrica('stock.push_independiente', elapsedMs, result.pending ? 'error' : 'ok');
            void inventoryReceiver?.wake();
        },
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
        if ((event !== 'SIGNED_IN' && event !== 'TOKEN_REFRESHED') || !session?.user.id) return;
        // Do not await Supabase work inside its auth callback.
        setTimeout(() => {
            if (!live()) return;
            const current = useConfigStore.getState();
            if (current.user?.id === session.user.id && current.negocioId) {
                void new InventoryOperationRepository(db).resumeAfterAuthentication(current.negocioId, Date.now())
                    .then(() => { void inventoryReceiver?.wake(); void inventorySender?.wake(); })
                    .catch(() => { /* preserve pending on local storage failure */ });
            }
        }, 0);
    });
    unsubscribeInventoryAuth = () => subscription.unsubscribe();

    const tick = async () => {
        if (!live() || !navigator.onLine || isSyncing) return;
        // No sincronizar cuando la app está en segundo plano (pestaña oculta/minimizada):
        // evita gastar CPU, red y batería, y que la app se trabe al volver a abrirla.
        if (typeof document !== 'undefined' && document.hidden) return;

        // Backoff: si hay 3+ errores consecutivos, reducir intentos gradualmente
        if (consecutiveErrors >= 3) {
            consecutiveErrors--;
            return;
        }

        const finishActivity = syncQuiescence.enter();
        if (!finishActivity) return;
        isSyncing = true;
        marcarSyncActivo(true);
        const inicioSync = performance.now();
        const finalizarSync = iniciarMedicion();
        let resultadoSync: ResultadoMetrica = 'ok';
        let finPull: number | null = null;

        try {
            const { sucursalId, negocioId } = useConfigStore.getState();
            // The POS requires branch selection. Never provision GLOBAL stock
            // while the user is still choosing which branch this device serves.
            if (!negocioId || !sucursalId) return;

            if (sharedWebEnabled(negocioId)) {
                await limpiarCanalRealtimeStock();
                if (await runSharedWorkerCycle()) return;
            }

            // Stock en vivo entre cajas (se suscribe una vez por negocio)
            await suscribirRealtimeStock(negocioId);
            if (!live()) return;

            const scope = { negocioId, sucursalId: sucursalId ?? null };
            const metadataWithoutAuthority = inventoryReceiverMode(process.env.NEXT_PUBLIC_SUPABASE_URL,
                process.env.NEXT_PUBLIC_VENTARD_INVENTORY_FEED_MODE, scope) === 'ACTIVE';
            const isCurrentScope = () => {
                const current = useConfigStore.getState();
                return live() && current.negocioId === scope.negocioId && (current.sucursalId ?? null) === scope.sucursalId;
            };
            const getSyncTs = (key: string) => readSyncTs(key, scope);
            const setSyncTs = (key: string, ts: number) => { if (isCurrentScope()) writeSyncTs(key, ts, scope); };
            const pullRows = async <T extends BusinessSyncRow>(table: Table<T>,
                timestamp: 'fecha_creacion' | 'fecha_actualizacion',
                options: { branchOnly?: boolean; preserveLegacyWithoutFlag?: boolean; merge?: (remote: T, local: T | undefined) => T } = {}) => {
                if (!isCurrentScope()) return;
                const cursor = getSyncTs(table.name);
                const historyKey = syncStorageKey(TS_PREFIX, `${table.name}_recent_recon`, scope);
                const now = Date.now();
                const reconcile = timestamp === 'fecha_creacion'
                    && now - parseInt(localStorage.getItem(historyKey) || '0', 10) > 5 * 60 * 1000;
                const floor = historyPullFloor(cursor, now, reconcile);
                try {
                    const result = await pullTenantRows({ table, scope, isCurrentScope, ...options,
                        readPage: (from, to) => withTimeout(() => {
                            if (!isCurrentScope()) throw new Error('sync_scope_changed');
                            let query = supabase.from(table.name).select('*', { count: 'exact' })
                                .eq('negocio_id', negocioId).gte(timestamp, floor);
                            if (options.branchOnly && sucursalId) query = query.eq('sucursal_id', sucursalId);
                            return query.order('id').range(from, to);
                        }),
                    });
                    if (result.deferred === 0) setSyncTs(table.name, clampTs(timestamp === 'fecha_creacion'
                        ? maxCreacionTs(result.rows) : maxTs(result.rows)));
                    // An offline sale may arrive long after its creation date.
                    // Periodically revisit the same 90-day history we retain
                    // locally instead of trusting a creation-date cursor alone.
                    if (reconcile && isCurrentScope()) localStorage.setItem(historyKey, String(now));
                } catch {
                    resultadoSync = 'error';
                    console.warn(`[sync] ${table.name}: descarga incompleta; se conserva el dato local y su cursor`);
                }
            };

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
            try {
                const baseline = await captureCatalogBaseline(db, scope);
                const lastProdTs = getSyncTs('productos');
                const cloudProducts = await readCompletePages((from, to) => withTimeout(() =>
                    supabase.from('productos').select('*', { count: 'exact' })
                        .eq('negocio_id', negocioId).gt('fecha_actualizacion', lastProdTs)
                        .order('id').range(from, to)
                ), row => row.id);
                if (cloudProducts.length) {
                    const branchStocks = new Map<string, number>();
                    if (sucursalId) {
                        // Bounded batches also keep the URL below proxy limits.
                        for (let index = 0; index < cloudProducts.length; index += 100) {
                            const ids = cloudProducts.slice(index, index + 100).map(product => product.id);
                            const stockData = await readCompletePages((from, to) => withTimeout(() =>
                                supabase.from('inventario_sucursales').select('producto_id, stock_actual', { count: 'exact' })
                                    .eq('sucursal_id', sucursalId).in('producto_id', ids).order('producto_id').range(from, to)
                            ), row => row.producto_id);
                            stockData.forEach(row => branchStocks.set(row.producto_id, row.stock_actual));
                        }
                    }
                    const result = await persistRemoteCatalog({ database: db, scope, baseline,
                        products: cloudProducts, branchStocks, metadataWithoutAuthority, isCurrentScope });
                    // A skipped response is retried on a later pull; never advance
                    // the cursor past a local edit committed during the download.
                    if (result.deferred === 0 && isCurrentScope()) setSyncTs('productos', clampTs(maxTs(cloudProducts)));
                }
            } catch (error) {
                console.warn('[sync] catalogo incremental incompleto; se conserva el cache local', error);
            }

            // ── 1.B.2  Reconciliación de stocks (cada 120 seg) ───────────────
            // Red de seguridad para cambios fuera de la ventana incremental.
            // Se exige cobertura completa y se revalidan los pendientes al
            // escribir; la sucursal nunca cae al stock global por falta de fila.
            const STOCK_RECON_KEY = syncStorageKey(TS_PREFIX, 'stock_recon', scope);
            // Red de seguridad (por si el pull incremental se perdió un cambio). Se
            // hace con menos frecuencia porque descarga TODO el catálogo: cada 30s
            // trababa la app en negocios con muchos productos. El pull incremental
            // (cada ~15s) sigue trayendo los cambios al instante.
            const STOCK_RECON_INTERVAL = 120 * 1000;
            const lastStockRecon = parseInt(localStorage.getItem(STOCK_RECON_KEY) || '0', 10);
            const firstQaScopeSnapshot = inventoryReceiverMode(process.env.NEXT_PUBLIC_SUPABASE_URL,
                process.env.NEXT_PUBLIC_VENTARD_INVENTORY_FEED_MODE, scope) === 'ACTIVE'
                && !completedScopeSnapshots.has(STOCK_RECON_KEY);
            if (firstQaScopeSnapshot || Date.now() - lastStockRecon > STOCK_RECON_INTERVAL) {
                try {
                    const baseline = await captureCatalogBaseline(db, scope);
                    const allStocks = await readCompletePages((from, to) => withTimeout(() =>
                        supabase.from('productos').select('id, negocio_id, stock_actual, eliminado', { count: 'exact' }).eq('negocio_id', negocioId)
                            .order('id').range(from, to)
                    ), row => row.id);
                    const branchStocks = new Map<string, number>();
                    if (sucursalId) {
                        const invData = await readCompletePages((from, to) => withTimeout(() =>
                            supabase.from('inventario_sucursales').select('producto_id, stock_actual', { count: 'exact' })
                                .eq('sucursal_id', sucursalId).order('producto_id').range(from, to)
                        ), row => row.producto_id);
                        invData.forEach(row => branchStocks.set(row.producto_id, row.stock_actual));
                    }
                    await persistRemoteCatalog({ database: db, scope, baseline,
                        products: allStocks, branchStocks, mode: 'STOCK_ONLY', isCurrentScope });
                    // This is a periodic safety refresh, not a data cursor. A
                    // deferred local edit/missing branch must not force a full
                    // download every tick; incremental/realtime still run.
                    if (isCurrentScope()) {
                        completedScopeSnapshots.add(STOCK_RECON_KEY);
                        localStorage.setItem(STOCK_RECON_KEY, String(Date.now()));
                    }
                } catch (error) {
                    console.warn('[sync] reconteo incompleto; se conserva el stock local', error);
                }
            }

            // ── 1.B.4  Reconciliación de existencia (cada 5 min) ─────────────
            // Recupera productos ausentes y procesa eliminaciones explícitas.
            // Una ausencia bajo RLS no demuestra una eliminación comercial.
            const RECON_KEY = syncStorageKey(TS_PREFIX, 'prod_recon', scope);
            const RECON_INTERVAL = 5 * 60 * 1000; // 5 minutos
            const lastRecon = parseInt(localStorage.getItem(RECON_KEY) || '0', 10);
            if (Date.now() - lastRecon > RECON_INTERVAL) {
                try {
                    const baseline = await captureCatalogBaseline(db, scope);
                    const remoteProducts = await readCompletePages((from, to) => withTimeout(() =>
                        supabase.from('productos').select('*', { count: 'exact' }).eq('negocio_id', negocioId)
                            .order('id').range(from, to)
                    ), row => row.id);
                    const products = remoteProducts.filter(product => product.eliminado || !baseline.has(product.id));
                    const branchStocks = new Map<string, number>();
                    if (sucursalId && products.some(product => !product.eliminado)) {
                        const rows = await readCompletePages((from, to) => withTimeout(() =>
                            supabase.from('inventario_sucursales').select('producto_id, stock_actual', { count: 'exact' })
                                .eq('sucursal_id', sucursalId).order('producto_id').range(from, to)
                        ), row => row.producto_id);
                        rows.forEach(row => branchStocks.set(row.producto_id, row.stock_actual));
                    }
                    // Absence alone can mean permissions changed. Delete only an
                    // explicit tombstone and only after checking local pending work.
                    await persistRemoteCatalog({ database: db, scope, baseline,
                        products, branchStocks, metadataWithoutAuthority, isCurrentScope });
                    if (isCurrentScope()) localStorage.setItem(RECON_KEY, String(Date.now()));
                } catch (error) {
                    console.warn('[sync] catalogo completo no verificable; no se eliminan productos', error);
                }
            }

            // ── 1.C  Composiciones ────────────────────────────────────────────
            const lastCompTs = getSyncTs('composiciones');
            const { data: cloudComps, error: pullCompErr } = await withTimeout(() =>
                supabase.from('composiciones').select('*').gt('fecha_actualizacion', lastCompTs)
            );
            if (!pullCompErr && cloudComps && cloudComps.length > 0) {
                await db.composiciones.bulkPut(await sinPisarPendientes(db.composiciones, cloudComps));
                setSyncTs('composiciones', maxTs(cloudComps));
            }

            // ── 1.D  Clientes ─────────────────────────────────────────────────
            await pullRows(db.clientes, 'fecha_actualizacion');

            // ── 1.E  Transacciones fiado ──────────────────────────────────────
            await pullRows(db.transacciones_fiado, 'fecha_actualizacion', {
                merge: remote => ({ ...remote, fecha_creacion: new Date(remote.fecha_creacion).getTime() }),
            });

            // ── 1.F  Ventas (NUEVO: descarga ventas de otros dispositivos) ────
            await pullRows(db.ventas, 'fecha_creacion', {
                merge: (remote, local) => ({ ...remote, ncf: remote.ncf ?? local?.ncf,
                    vendedor_nombre: remote.vendedor_nombre ?? local?.vendedor_nombre }),
            });

            // ── 1.G  Venta detalles (NUEVO) ───────────────────────────────────
            await pullRows(db.venta_detalles, 'fecha_creacion', { merge: remote => detalleDesdeRemoto(remote) });

            // ── 1.H  Cajas (NUEVO) ────────────────────────────────────────────
            await pullRows(db.cajas, 'fecha_actualizacion', { branchOnly: true, preserveLegacyWithoutFlag: true });

            // ── 1.I  Devoluciones ─────────────────────────────────────────────
            await pullRows(db.devoluciones, 'fecha_creacion');

            // ── 1.K  Reparaciones (Plan Pro) ──────────────────────────────────
            await pullRows(db.reparaciones, 'fecha_actualizacion');

            // ── 1.L  Apartados (Plan Pro) ─────────────────────────────────────
            await pullRows(db.apartados, 'fecha_actualizacion');

            // ── 1.J  Seriales ─────────────────────────────────────────────────
            await pullRows(db.seriales, 'fecha_actualizacion');

            // ── 1.J.2  Gastos ─────────────────────────────────────────────────
            await pullRows(db.gastos, 'fecha_actualizacion');

            // ── 1.K  Cortes de caja ───────────────────────────────────────────
            await pullRows(db.cortes_caja, 'fecha_creacion');

            // ── 1.L  NCF: secuencia centralizada con bloques por dispositivo ──
            if (!isCurrentScope()) return;
            try {
                const { data: { session }, error: authError } = await supabase.auth.getSession();
                if (authError || !session?.user.id) throw new Error('ncf_auth_requerida');
                const source = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin;
                const sec = await abastecerNcfLocal(db, { negocioId, actorId: session.user.id,
                    source, fecha: Date.now(), requestId: crypto.randomUUID() }, {
                    sequence: async () => {
                        const { data, error } = await withTimeout(() =>
                            supabase.from('ncf_secuencias').select('*').eq('negocio_id', negocioId).maybeSingle());
                        if (error) throw new Error('ncf_lectura_fallida');
                        return data;
                    },
                    reserve: async () => {
                        const { data, error } = await withTimeout(() =>
                            supabase.rpc('reservar_ncf', { p_negocio_id: negocioId, p_cantidad: 20 }));
                        if (error) throw new Error('ncf_reserva_fallida');
                        if (!Array.isArray(data) || data.length > 1) throw new Error('ncf_respuesta_invalida');
                        return data[0] ?? null;
                    },
                });
                // El rango pertenece al scope capturado, aunque cambie la pantalla.
                // Solo el espejo de la UI se condiciona al scope actual.
                if (sec && isCurrentScope()) {
                    useConfigStore.setState(s => ({
                        ncf: {
                            ...s.ncf,
                            negocioId,
                            habilitado: sec.habilitado,
                            tipo: sec.tipo,
                            desde: Number(sec.desde),
                            hasta: Number(sec.hasta),
                            proximoGlobal: Number(sec.proximo),
                            sembrado: true,
                        },
                    }));
                }
            } catch {
                // No tokens/payloads ni retry de una RPC incierta. Visible en journal.
                console.warn('[sync] NCF no verificable; revisar abastecimiento.');
            }

            // ══════════════════════════════════════════════════════════════════
            // 2. PUSH — Subir a la nube
            // ══════════════════════════════════════════════════════════════════
            finPull = performance.now();
            registrarMetrica('sync.pull', finPull - inicioSync);
            if (!isCurrentScope()) return;

            // ── 2.A  Ventas ───────────────────────────────────────────────────
            const ventasPendientes = await pendingTenantRows(db.ventas, negocioId);
            for (const venta of ventasPendientes) {
                if (!isCurrentScope()) return;
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
                        ...(venta.cliente_nombre && { cliente_nombre: venta.cliente_nombre }),
                    })
                );
                if (!error) await acknowledgeSyncedSnapshot(db.ventas, venta);
            }

            // ── 2.B  Venta detalles ───────────────────────────────────────────
            const detallesPendientes = (await pendingTenantRows(db.venta_detalles, negocioId))
                .filter(d => isValidUUID(d.id) && isValidUUID(d.venta_id) && isValidUUID(d.producto_id));
            for (const detalle of detallesPendientes) {
                if (!isCurrentScope()) return;
                const payload = payloadDetalleRemoto(detalle);
                const { error } = await withTimeout(() =>
                    supabase.from('venta_detalles').upsert(payload)
                );
                if (error) {
                    console.error('[sync] venta_detalles error:', error.code, error.message, error.details, error.hint, '\npayload:', payload);
                } else {
                    await acknowledgeSyncedSnapshot(db.venta_detalles, detalle);
                }
            }

            // ── 2.C  Productos & inventario ───────────────────────────────────
            const prodPendientes = await pendingTenantRows(db.productos, negocioId);
            const prodAEliminar = prodPendientes.filter(p => p.eliminado);
            const prodAUpsert   = prodPendientes.filter(p => !p.eliminado);

            // Eliminar de Supabase los productos borrados localmente
            for (const p of prodAEliminar) {
                if (!isCurrentScope()) return;
                const { error: delProdErr } = await withTimeout(() =>
                    supabase.from('productos').delete().eq('negocio_id', negocioId).eq('id', p.id)
                );
                if (!delProdErr) {
                    // Limpiar tablas relacionadas en Supabase
                    await Promise.all([
                        withTimeout(() => supabase.from('composiciones').delete().eq('producto_padre_id', p.id)),
                        withTimeout(() => supabase.from('inventario_sucursales').delete().eq('producto_id', p.id)),
                    ]);
                    // Hard-delete local ahora que está confirmado en la nube
                    await db.transaction('rw', db.productos, db.composiciones, async () => {
                        if (await removeSyncedSnapshot(db.productos, p)) {
                            await db.composiciones.where('producto_padre_id').equals(p.id).delete();
                        }
                    });
                }
            }

            // Upsert productos nuevos/editados — FILA POR FILA: en lote, un solo
            // producto rechazado (constraint, dato corrupto) bloqueaba TODOS los
            // cambios de catálogo de este dispositivo para siempre.
            for (const p of prodAUpsert) {
                if (!isCurrentScope()) return;
                if (p.inventory_bootstrap?.state === 'BLOCKED') continue;
                const { error: prodError } = await withTimeout(() =>
                    supabase.from('productos').upsert({
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
                        // Propagar el soft-delete: sin esto, borrar un producto
                        // solo lo quitaba del dispositivo que lo borró.
                        eliminado: p.eliminado ?? false,
                        // NOTA: stock_actual NO se sube aquí — viaja como movimientos
                        // atómicos (sección 2.C.2) para no pisar a otras cajas.
                        stock_minimo: p.stock_minimo,
                        fecha_actualizacion: p.fecha_actualizacion || Date.now(),
                    })
                );
                if (prodError) {
                    console.error('[sync] producto error:', prodError.code, prodError.message, prodError.details, 'id:', p.id, p.nombre);
                } else {
                    if (p.inventory_bootstrap?.state === 'PENDING') {
                        try { await withTimeout(() => prepareInventoryProduct(supabase, p)); }
                        catch (error) {
                            if (error instanceof InventoryRemoteError && !error.retryable && error.code !== 'AUTH_REQUIRED') {
                                await db.productos.update(p.id, { inventory_bootstrap: {
                                    ...p.inventory_bootstrap, state: 'BLOCKED', code: error.code } });
                            }
                            console.warn('[sync] inventario inicial no preparado; producto y movimientos conservados');
                            continue;
                        }
                    }
                    await acknowledgeSyncedSnapshot(db.productos, p);
                    if (p.inventory_bootstrap?.state === 'PENDING') {
                        await db.productos.update(p.id, { inventory_bootstrap: { ...p.inventory_bootstrap, state: 'READY' } });
                    }
                    void inventorySender?.wake();
                }
            }

            // ── 2.C.2  Movimientos de stock (deltas atómicos) ─────────────────
            // Cada movimiento se aplica en la nube con una RPC idempotente:
            // increment/decrement atómico — dos cajas nunca se pisan el stock.
            const movsPendientes = (await pendingTenantRows(db.movimientos_stock, negocioId))
                // Exactly one v2 dispatcher in controlled ACTIVE QA. Outside
                // that gate, preserve the existing v1/v2 routing unchanged.
                .filter(row => row.sync_protocol_version !== 2 || inventoryReceiverMode(
                    process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_VENTARD_INVENTORY_FEED_MODE, scope) !== 'ACTIVE')
                .sort((a, b) => a.fecha_creacion - b.fecha_creacion);
            if (movsPendientes.length > 0) {
                const inicioMovimientos = performance.now();
                const repository = new InventoryOperationRepository(db);
                const remoteV2 = inventoryRemoteClient();

                const result = await procesarColaInventario({
                    operations: movsPendientes,
                    repository,
                    // El timeout no cambia identidad ni reenvía por v1. Un fallo
                    // conserva la operación v2 visible para recuperación.
                    remote: remoteV2,
                    applyLegacy: async mov => {
                        try {
                            const { error } = await withTimeout(() =>
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
                            return error;
                        } catch {
                            return { code: '57014' };
                        }
                    },
                    persistLegacyPatch: async (operationId, patch) => {
                        const current = await db.movimientos_stock.get(operationId);
                        if (!current) throw new Error('inventory_operation_not_found');
                        await db.movimientos_stock.put({ ...current, ...patch });
                    },
                });
                registrarMetrica(
                    'stock.push_confirmacion',
                    performance.now() - inicioMovimientos,
                    result.pending > 0 ? 'error' : 'ok',
                );
            }

            // ── 2.D  Composiciones ────────────────────────────────────────────
            const activeProductIds = new Set(await db.productos.where('negocio_id').equals(negocioId).primaryKeys());
            const compPendientes = await db.composiciones.where('estado_sincronizacion').equals(0)
                .filter(row => activeProductIds.has(row.producto_padre_id)).toArray();
            // FILA POR FILA: un combo con referencia rota no bloquea a los demás.
            for (const c of compPendientes) {
                if (!isCurrentScope()) return;
                const { error: compError } = await withTimeout(() =>
                    supabase.from('composiciones').upsert({
                        id: c.id,
                        producto_padre_id: c.producto_padre_id,
                        insumo_id: c.insumo_id,
                        cantidad_necesaria: c.cantidad_necesaria,
                        fecha_actualizacion: c.fecha_actualizacion || Date.now(),
                    })
                );
                if (compError) {
                    console.error('[sync] composicion error:', compError.code, compError.message, 'id:', c.id);
                } else {
                    await db.composiciones.update(c.id, { estado_sincronizacion: 1 });
                }
            }

            // ── 2.E  Clientes ─────────────────────────────────────────────────
            // FILA POR FILA: un cliente rechazado bloqueaba a TODOS los clientes
            // del dispositivo — y de rebote sus cargos de fiado (FK a clientes).
            const clientesPendientes = await pendingTenantRows(db.clientes, negocioId);
            for (const c of clientesPendientes) {
                if (!isCurrentScope()) return;
                const { error: cliError } = await withTimeout(() =>
                    supabase.from('clientes').upsert({
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
                    })
                );
                if (cliError) {
                    console.error('[sync] cliente error:', cliError.code, cliError.message, 'id:', c.id, c.nombre);
                } else {
                    await acknowledgeSyncedSnapshot(db.clientes, c);
                }
            }

            // ── 2.F  Transacciones fiado ──────────────────────────────────────
            // FILA POR FILA (no en lote): con upsert en lote, UNA fila rechazada
            // por la nube (FK rota, cliente borrado, venta sin subir) hacía fallar
            // el lote COMPLETO y ningún cargo posterior volvía a sincronizar —
            // las deudas nuevas quedaban invisibles para el resto de dispositivos.
            const transPendientes = await pendingTenantRows(db.transacciones_fiado, negocioId);
            for (const t of transPendientes) {
                if (!isCurrentScope()) return;
                const payload = payloadFiadoRemoto(t);
                const { error: transError } = await withTimeout(() =>
                    supabase.from('transacciones_fiado').upsert(payload)
                );
                if (transError) {
                    console.error('[sync] transaccion_fiado error:', transError.code, transError.message, transError.details, transError.hint, '\npayload:', payload);
                } else {
                    await acknowledgeSyncedSnapshot(db.transacciones_fiado, t);
                }
            }

            // ── 2.G  Cajas (NUEVO) ────────────────────────────────────────────
            const cajasPendientes = await pendingTenantRows(db.cajas, negocioId, true);
            for (const caja of cajasPendientes) {
                if (!isCurrentScope()) return;
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
                if (!error) await acknowledgeSyncedSnapshot(db.cajas, caja);
            }

            // ── 2.H  Devoluciones ────────────────────────────────────────────
            const devolucionesPendientes = await pendingTenantRows(db.devoluciones, negocioId);
            for (const dev of devolucionesPendientes) {
                if (!isCurrentScope()) return;
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
                if (!error) await acknowledgeSyncedSnapshot(db.devoluciones, dev);
            }

            // ── 2.I  Seriales ─────────────────────────────────────────────────
            // FILA POR FILA: un serial rechazado (duplicado, FK) no bloquea las
            // garantías de los demás equipos.
            const serialesPendientes = await pendingTenantRows(db.seriales, negocioId);
            for (const s of serialesPendientes) {
                if (!isCurrentScope()) return;
                const { error: serErr } = await withTimeout(() =>
                    supabase.from('seriales').upsert({
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
                    })
                );
                if (serErr) {
                    console.error('[sync] serial error:', serErr.code, serErr.message, 'id:', s.id, s.numero_serial);
                } else {
                    await acknowledgeSyncedSnapshot(db.seriales, s);
                }
            }

            // ── 2.I.2  Gastos ─────────────────────────────────────────────────
            const gastosPendientes = await pendingTenantRows(db.gastos, negocioId);
            for (const gasto of gastosPendientes) {
                if (!isCurrentScope()) return;
                if (gasto.eliminado) {
                    // Soft delete local → borrar en la nube y luego localmente
                    const { error } = await withTimeout(() =>
                        supabase.from('gastos').delete().eq('negocio_id', negocioId).eq('id', gasto.id)
                    );
                    if (!error) await removeSyncedSnapshot(db.gastos, gasto);
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
                    await acknowledgeSyncedSnapshot(db.gastos, gasto);
                }
            }

            // ── 2.J  Cortes de caja ───────────────────────────────────────────
            const cortesPendientes = await pendingTenantRows(db.cortes_caja, negocioId);
            for (const corte of cortesPendientes) {
                if (!isCurrentScope()) return;
                const { error } = await withTimeout(() =>
                    supabase.from('cortes_caja').upsert({
                        id: corte.id,
                        negocio_id: corte.negocio_id,
                        caja_id: corte.caja_id,
                        sucursal_id: corte.sucursal_id ?? null,
                        tipo: corte.tipo,
                        fecha_creacion: corte.fecha_creacion,
                        efectivo: corte.efectivo,
                        tarjeta: corte.tarjeta,
                        transferencia: corte.transferencia,
                        fiado: corte.fiado,
                        mixto: corte.mixto,
                        total_ventas: corte.total_ventas,
                        ...(corte.ingreso_reparaciones !== undefined ? { ingreso_reparaciones: corte.ingreso_reparaciones } : {}),
                        ...(corte.ingreso_apartados !== undefined ? { ingreso_apartados: corte.ingreso_apartados } : {}),
                        ...(corte.ingreso_abonos_fiado !== undefined ? { ingreso_abonos_fiado: corte.ingreso_abonos_fiado } : {}),
                        cantidad_transacciones: corte.cantidad_transacciones,
                        monto_apertura: corte.monto_apertura ?? null,
                        monto_esperado: corte.monto_esperado ?? null,
                        monto_contado: corte.monto_contado ?? null,
                        diferencia: corte.diferencia ?? null,
                    })
                );
                if (!error) await acknowledgeSyncedSnapshot(db.cortes_caja, corte);
            }

            // ── 2.K  Reparaciones (Plan Pro) ──────────────────────────────────
            const reparacionesPendientes = await pendingTenantRows(db.reparaciones, negocioId);
            for (const rep of reparacionesPendientes) {
                if (!isCurrentScope()) return;
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
                        es_garantia: rep.es_garantia ?? false,
                        reparacion_origen_id: rep.reparacion_origen_id ?? null,
                        bitacora: rep.bitacora ?? [],
                        fecha_creacion: rep.fecha_creacion,
                        fecha_entrega: rep.fecha_entrega ?? null,
                        fecha_actualizacion: rep.fecha_actualizacion || Date.now(),
                    })
                );
                if (error) {
                    console.error('[sync] reparaciones error:', error.code, error.message, error.details);
                } else {
                    await acknowledgeSyncedSnapshot(db.reparaciones, rep);
                }
            }

            // ── 2.L  Apartados (Plan Pro) ─────────────────────────────────────
            const apartadosPendientes = await pendingTenantRows(db.apartados, negocioId);
            for (const ap of apartadosPendientes) {
                if (!isCurrentScope()) return;
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
                    await acknowledgeSyncedSnapshot(db.apartados, ap);
                }
            }

            // ══════════════════════════════════════════════════════════════════
            // 3. PURGA LOCAL — mantener IndexedDB liviano (1 vez al día)
            // Nunca borra detalles pendientes ni operaciones sin recibo exacto.
            // Los reportes de rangos antiguos consultan la nube.
            // ══════════════════════════════════════════════════════════════════
            const PURGE_KEY = syncStorageKey(TS_PREFIX, 'purge', scope);
            const PURGE_INTERVAL = 24 * 60 * 60 * 1000;
            const lastPurge = parseInt(localStorage.getItem(PURGE_KEY) || '0', 10);
            if (Date.now() - lastPurge > PURGE_INTERVAL) {
                const result = await purgeAcknowledgedHistory({ database: db, negocioId,
                    asOf: Date.now(), isCurrentScope });
                if (isCurrentScope()) localStorage.setItem(PURGE_KEY, String(Date.now()));
                if (result.sales > 0) console.log(`[purge] ${result.sales} ventas antiguas retiradas del cache local`);
            }

            consecutiveErrors = 0;

        } catch (err) {
            resultadoSync = 'error';
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
            const finSync = performance.now();
            if (finPull !== null) registrarMetrica('sync.push_y_mantenimiento', finSync - finPull, resultadoSync);
            finalizarSync('sync.total', resultadoSync, {
                online: navigator.onLine,
                erroresConsecutivos: consecutiveErrors,
            });
            marcarSyncActivo(false);
            isSyncing = false;
            finishActivity();
            if (queuedScopeTick && live()) { queuedScopeTick = false; void tick(); }
        }
    };

    activeInterval = setInterval(tick, 15000);
    unsubscribeInventoryScope = useConfigStore.subscribe((state, previous) => {
        if (!live()) return;
        refreshSharedWorker();
        if (state.negocioId === previous.negocioId && state.sucursalId === previous.sucursalId && state.user?.id===previous.user?.id && state.usuarioCacheId===previous.usuarioCacheId) return;
        void inventoryReceiver?.wake(); void inventorySender?.wake();
        if (isSyncing) queuedScopeTick = true;
        else void tick();
    });
    void tick();

    // Al volver la pestaña al frente: sincronizar YA (sin esperar el próximo
    // tick) y forzar el reconteo de stock (el gate de 120s se resetea) — la PC
    // del taller que estuvo minimizada se pone al día en segundos.
    onVisibilidad = () => {
        if (!document.hidden) {
            void inventoryReceiver?.wake();
            void inventorySender?.wake();
            const { negocioId, sucursalId } = useConfigStore.getState();
            if (negocioId) localStorage.removeItem(syncStorageKey(TS_PREFIX, 'stock_recon', { negocioId, sucursalId: sucursalId ?? null }));
            tick();
        }
    };
    onOnline = () => { void inventoryReceiver?.wake(); void inventorySender?.wake(); void tick(); };

    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibilidad);
    }
    // Al recuperar internet: sincronizar de inmediato
    if (typeof window !== 'undefined') {
        window.addEventListener('online', onOnline);
    }

    return activeInterval;
};

export const stopSyncWorker = () => {
    syncGeneration++;
    resetSharedWorker();
    inventorySender?.stop();
    inventorySender = null;
    unsubscribeInventoryScope?.();
    unsubscribeInventoryScope = null;
    inventoryReceiver?.stop();
    inventoryReceiver = null;
    unsubscribeInventoryAuth?.();
    unsubscribeInventoryAuth = null;
    if (activeInterval !== null) {
        clearInterval(activeInterval);
        activeInterval = null;
    }
    // Sin esto los listeners se acumulan en cada reinicio del provider (cambio de
    // sesión, navegación) y cada evento dispara varios ticks en paralelo.
    if (onVisibilidad && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilidad);
        onVisibilidad = null;
    }
    if (onOnline && typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        onOnline = null;
    }
    // No dejar canales del negocio anterior ni callbacks duplicados al remontar.
    void limpiarCanalRealtimeStock();
};
