// Telemetría local de rendimiento para la Fase 0.
// No contiene PII ni se transmite automáticamente: vive en localStorage y el
// usuario decide si exporta el diagnóstico desde Configuración.

export const VERSION_DIAGNOSTICO = 2;
export const VERSION_APP = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'local';
const STORAGE_KEY = 'ventard-performance-v1';
const MAX_MUESTRAS = 300;
let syncActivo = false;

export type ResultadoMetrica = 'ok' | 'error' | 'cancelada';

export interface MetricaRendimiento {
    nombre: string;
    duracionMs: number;
    fecha: number;
    resultado: ResultadoMetrica;
    contexto?: Record<string, number | string | boolean | null>;
}

export interface ResumenMetrica {
    nombre: string;
    muestras: number;
    promedioMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    errores: number;
}

function redondear(n: number): number {
    return Math.round(n * 10) / 10;
}

function percentil(ordenados: number[], p: number): number {
    if (ordenados.length === 0) return 0;
    const indice = Math.min(ordenados.length - 1, Math.ceil(ordenados.length * p) - 1);
    return ordenados[Math.max(0, indice)];
}

export function resumirMetricas(metricas: MetricaRendimiento[]): ResumenMetrica[] {
    const grupos = new Map<string, MetricaRendimiento[]>();
    for (const metrica of metricas) {
        const grupo = grupos.get(metrica.nombre) ?? [];
        grupo.push(metrica);
        grupos.set(metrica.nombre, grupo);
    }

    return [...grupos.entries()].map(([nombre, grupo]) => {
        const duraciones = grupo.map(m => m.duracionMs).sort((a, b) => a - b);
        return {
            nombre,
            muestras: grupo.length,
            promedioMs: redondear(duraciones.reduce((s, n) => s + n, 0) / duraciones.length),
            p50Ms: redondear(percentil(duraciones, 0.5)),
            p95Ms: redondear(percentil(duraciones, 0.95)),
            maxMs: redondear(duraciones[duraciones.length - 1] ?? 0),
            errores: grupo.filter(m => m.resultado === 'error').length,
        };
    }).sort((a, b) => b.p95Ms - a.p95Ms);
}

export function leerMetricas(): MetricaRendimiento[] {
    if (typeof window === 'undefined') return [];
    try {
        const valor = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        return Array.isArray(valor) ? valor : [];
    } catch {
        return [];
    }
}

export function registrarMetrica(
    nombre: string,
    duracionMs: number,
    resultado: ResultadoMetrica = 'ok',
    contexto?: MetricaRendimiento['contexto'],
): void {
    if (typeof window === 'undefined' || !Number.isFinite(duracionMs)) return;
    try {
        const metricas = leerMetricas();
        metricas.push({
            nombre,
            duracionMs: redondear(Math.max(0, duracionMs)),
            fecha: Date.now(),
            resultado,
            ...(contexto && { contexto }),
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(metricas.slice(-MAX_MUESTRAS)));
    } catch {
        // La medición jamás puede interrumpir una venta o sincronización.
    }
}

export function iniciarMedicion() {
    const inicio = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return (
        nombre: string,
        resultado: ResultadoMetrica = 'ok',
        contexto?: MetricaRendimiento['contexto'],
    ) => {
        const fin = typeof performance !== 'undefined' ? performance.now() : Date.now();
        registrarMetrica(nombre, fin - inicio, resultado, contexto);
    };
}

export function limpiarMetricas(): void {
    if (typeof window === 'undefined') return;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* sin almacenamiento */ }
}

export function marcarSyncActivo(activo: boolean): void {
    syncActivo = activo;
}

export function estaSyncActivo(): boolean {
    return syncActivo;
}
