// "🩺 Estado del sistema": diagnóstico local, sin PII ni envío automático.
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { db } from '@/lib/db/dexie';
import { useConfigStore } from '@/store/useConfigStore';
import { estaSyncActivo, leerMetricas, limpiarMetricas, resumirMetricas, VERSION_APP, VERSION_DIAGNOSTICO, type MetricaRendimiento, type ResumenMetrica } from '@/lib/rendimiento';

interface CacheInfo {
    nombre: string;
    entradas: number;
    bytesDeclarados: number;
}

interface Diagnostico {
    memoriaGB: number | null;
    heapUsadoMB: number | null;
    usoMB: number | null;
    cuotaMB: number | null;
    almacenamientoPersistente: boolean | null;
    tablas: Record<string, number>;
    pendientes: Record<string, number>;
    metricas: ResumenMetrica[];
    muestrasRecientes: MetricaRendimiento[];
    muestras: number;
    online: boolean;
    tipoConexion: string | null;
    dexieVersion: number;
    caches: CacheInfo[];
    pwa: boolean;
    serviceWorker: string | null;
    syncActivo: boolean;
}

const TABLAS_SYNC = [
    'ventas', 'venta_detalles', 'productos', 'composiciones', 'clientes',
    'transacciones_fiado', 'cajas', 'devoluciones', 'cortes_caja', 'seriales',
    'movimientos_stock', 'gastos', 'reparaciones', 'apartados',
] as const;

export default function EstadoSistema() {
    const { negocioId, dispositivoId, aperturasSinServidor, showToast } = useConfigStore();
    const [d, setD] = useState<Diagnostico | null>(null);

    const cargar = useCallback(async () => {
        try {
            const nav = navigator as Navigator & { deviceMemory?: number; connection?: { effectiveType?: string } };
            const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } };
            const [est, persistente] = await Promise.all([
                navigator.storage?.estimate ? navigator.storage.estimate() : null,
                navigator.storage?.persisted ? navigator.storage.persisted().catch(() => null) : null,
            ]);
            const paresTablas = await Promise.all(db.tables.map(async tabla => [tabla.name, await tabla.count()] as const));
            const paresPendientes = await Promise.all(TABLAS_SYNC.map(async nombre => {
                const cantidad = await db.table(nombre).where('estado_sincronizacion').equals(0).count();
                return [nombre, cantidad] as const;
            }));
            const metricasCrudas = leerMetricas();
            const caches: CacheInfo[] = [];
            if (typeof window.caches !== 'undefined') {
                for (const nombre of await window.caches.keys()) {
                    const cache = await window.caches.open(nombre);
                    const peticiones = await cache.keys();
                    const respuestas = await Promise.all(peticiones.map(p => cache.match(p)));
                    const bytesDeclarados = respuestas.reduce((s, respuesta) => {
                        const n = Number(respuesta?.headers.get('content-length') || 0);
                        return s + (Number.isFinite(n) ? n : 0);
                    }, 0);
                    caches.push({ nombre, entradas: peticiones.length, bytesDeclarados });
                }
            }

            setD({
                memoriaGB: nav.deviceMemory ?? null,
                heapUsadoMB: perf.memory?.usedJSHeapSize != null ? Math.round(perf.memory.usedJSHeapSize / 1048576) : null,
                usoMB: est?.usage != null ? Math.round(est.usage / 1048576) : null,
                cuotaMB: est?.quota != null ? Math.round(est.quota / 1048576) : null,
                almacenamientoPersistente: persistente,
                tablas: Object.fromEntries(paresTablas),
                pendientes: Object.fromEntries(paresPendientes),
                metricas: resumirMetricas(metricasCrudas),
                muestrasRecientes: metricasCrudas.slice(-100),
                muestras: metricasCrudas.length,
                online: navigator.onLine,
                tipoConexion: nav.connection?.effectiveType ?? null,
                dexieVersion: db.verno,
                caches,
                pwa: window.matchMedia('(display-mode: standalone)').matches,
                serviceWorker: navigator.serviceWorker?.controller?.scriptURL ?? null,
                syncActivo: estaSyncActivo(),
            });
        } catch {
            showToast('No se pudo leer el diagnóstico local.', 'error');
        }
    }, [showToast]);

    // La carga es asíncrona y solo actualiza el diagnóstico al completar I/O.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void cargar(); }, [cargar]);

    const totalPendientes = d ? Object.values(d.pendientes).reduce((s, n) => s + n, 0) : 0;
    const filas: [string, string][] = d ? [
        ['Conexión', `${d.online ? '🟢 Online' : '🔴 Offline'}${d.tipoConexion ? ` · ${d.tipoConexion}` : ''}`],
        ['Memoria del equipo', d.memoriaGB != null ? `${d.memoriaGB} GB${d.memoriaGB <= 2 ? ' ⚠️ baja' : ''}` : 'No disponible'],
        ['Heap JavaScript', d.heapUsadoMB != null ? `${d.heapUsadoMB} MB` : 'No disponible'],
        ['Almacenamiento usado', d.usoMB != null && d.cuotaMB != null ? `${d.usoMB} MB de ${d.cuotaMB} MB${d.cuotaMB - d.usoMB < 200 ? ' ⚠️ casi lleno' : ''}` : 'No disponible'],
        ['Almacenamiento persistente', d.almacenamientoPersistente == null ? 'No disponible' : d.almacenamientoPersistente ? 'Sí' : 'No ⚠️'],
        ['Pendientes totales', `${totalPendientes}${totalPendientes > 20 ? ' ⚠️' : ''}`],
        ['Muestras de rendimiento', String(d.muestras)],
        ['Ejecución', d.pwa ? 'PWA instalada' : 'Navegador'],
        ['Versión de app', VERSION_APP],
        ['Service Worker', d.serviceWorker ? d.serviceWorker.split('/').pop() || 'activo' : 'Sin controlador'],
        ['Sync al diagnosticar', d.syncActivo ? 'En ejecución' : 'Inactivo'],
        ['Cachés', `${d.caches.length} · ${d.caches.reduce((s, c) => s + c.entradas, 0)} entradas`],
        ['Versión IndexedDB', String(d.dexieVersion)],
        ['Aperturas sin servidor', String(aperturasSinServidor)],
        ['Caja', dispositivoId || '—'],
        ['Negocio', negocioId ? `${negocioId.slice(0, 8)}…` : '—'],
    ] : [];

    const crearPaquete = () => ({
        diagnosticoVersion: VERSION_DIAGNOSTICO,
        fecha: new Date().toISOString(),
        dispositivo: dispositivoId || null,
        negocioPrefijo: negocioId?.slice(0, 8) ?? null,
        aperturasSinServidor,
        pantalla: `${window.screen.width}x${window.screen.height}`,
        idioma: navigator.language,
        ...d,
    });

    const copiar = async () => {
        if (!d) return;
        const lentas = d.metricas.slice(0, 6).map(m => `${m.nombre}: p95 ${m.p95Ms} ms (${m.muestras})`);
        const texto = `🩺 Diagnóstico VentaRD\n${filas.map(([k, v]) => `${k}: ${v}`).join('\n')}\n${lentas.join('\n')}\nFecha: ${new Date().toLocaleString('es-DO')}`;
        try { await navigator.clipboard.writeText(texto); showToast('Diagnóstico copiado. Pégalo en el chat de soporte.', 'success'); }
        catch { showToast('No se pudo copiar.', 'error'); }
    };

    const exportar = () => {
        if (!d) return;
        const blob = new Blob([JSON.stringify(crearPaquete(), null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = `ventard-diagnostico-${new Date().toISOString().slice(0, 10)}.json`;
        enlace.click();
        URL.revokeObjectURL(url);
        showToast('Diagnóstico exportado.', 'success');
    };

    const reiniciarMetricas = () => {
        limpiarMetricas();
        void cargar();
        showToast('Métricas reiniciadas. Ya puedes iniciar una prueba limpia.', 'info');
    };

    return (
        <div className="pt-4">
            <h3 className="text-lg font-bold text-vr-gray mb-1 border-b border-navy-3 pb-2">🩺 Estado del Sistema</h3>
            <p className="text-xs text-vr-gray mb-4">
                Mide rendimiento únicamente en este dispositivo. No envía ventas ni datos de clientes. ¿Dudas de uso? Visita el{' '}
                <Link href="/ayuda" className="text-gold hover:underline">Centro de Ayuda</Link>.
            </p>
            {!d ? <p className="text-vr-gray text-sm">Cargando…</p> : (
                <div className="space-y-4">
                    <div className="bg-navy rounded-xl border border-navy-3 p-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                            {filas.map(([k, v]) => (
                                <div key={k} className="flex items-center justify-between gap-3 text-sm py-1.5 border-b border-navy-3/40">
                                    <span className="text-vr-gray">{k}</span>
                                    <span className="font-mono font-bold text-white text-xs text-right">{v}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="bg-navy rounded-xl border border-navy-3 p-4">
                        <p className="text-xs font-bold text-vr-gray uppercase tracking-wider mb-2">Operaciones más lentas</p>
                        {d.metricas.length === 0 ? (
                            <p className="text-xs text-vr-gray">Aún no hay muestras. Usa el sistema normalmente y vuelve aquí.</p>
                        ) : d.metricas.slice(0, 10).map(m => (
                            <div key={m.nombre} className="grid grid-cols-[1fr_auto_auto] gap-3 py-1.5 border-b border-navy-3/40 text-xs">
                                <span className="text-white font-mono truncate">{m.nombre}</span>
                                <span className="text-vr-gray">p95 <strong className="text-gold">{m.p95Ms} ms</strong></span>
                                <span className="text-vr-gray">n={m.muestras}{m.errores ? ` · ${m.errores} err` : ''}</span>
                            </div>
                        ))}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <button type="button" onClick={copiar} className="py-2.5 bg-navy-3 border border-navy-3 hover:border-gold/40 text-vr-gray hover:text-gold font-bold rounded-xl text-sm transition-all">📋 Copiar resumen</button>
                        <button type="button" onClick={exportar} className="py-2.5 bg-navy-3 border border-navy-3 hover:border-gold/40 text-vr-gray hover:text-gold font-bold rounded-xl text-sm transition-all">⬇️ Exportar JSON</button>
                        <button type="button" onClick={reiniciarMetricas} className="py-2.5 bg-navy-3 border border-navy-3 hover:border-vr-orange/40 text-vr-gray hover:text-vr-orange font-bold rounded-xl text-sm transition-all">↺ Reiniciar métricas</button>
                    </div>
                </div>
            )}
        </div>
    );
}
