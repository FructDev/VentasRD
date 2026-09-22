// src/lib/precarga.ts
// Deja la app lista para abrir SIN INTERNET desde cero.
//
// El service worker cachea una página cuando la visitas. Eso basta para "se fue
// el internet mientras trabajaba", pero no para el caso real: llega el turno de
// la mañana sin luz, el empleado abre la app desde cero y la página que necesita
// nunca se visitó en ese dispositivo. Aquí las descargamos por adelantado.
//
// Ojo: pedir el documento NO descarga sus chunks de JavaScript. Sin ellos la
// página cachea pero abre en blanco, que es peor que un error. Por eso también
// extraemos los assets del HTML y los pedimos.
import { ACCESOS } from './acceso';
import type { RolUsuario } from '@/store/useConfigStore';

/** Marca de la última precarga. Borrarla obliga a rehacerla (ver ErrorBoundary). */
export const CLAVE_PRECARGA_TS = 'vrd_precarga_ts';
const CADA_MS = 24 * 60 * 60 * 1000;

// Rutas del arranque en frío: sin estas el turno no abre.
const RUTAS_ARRANQUE = ['/pin', '/select-branch', '/offline'];

async function precargarUna(ruta: string): Promise<void> {
    const res = await fetch(ruta);
    if (!res.ok) return;
    const html = await res.text();
    const assets = new Set(
        [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map(m => m[1])
    );
    await Promise.all([...assets].map(a => fetch(a).catch(() => { })));
}

/**
 * Descarga las rutas que este rol puede abrir, para que existan offline.
 * Se ejecuta como mucho una vez al día y se rinde en silencio si no hay señal:
 * es una mejora oportunista, nunca debe estorbar el arranque.
 */
export async function precargarRutas(rol: RolUsuario): Promise<void> {
    if (typeof window === 'undefined') return;
    // Sin service worker controlando la pestaña no hay dónde guardar (ni en dev).
    if (!navigator.serviceWorker?.controller) return;

    const ultimo = Number(localStorage.getItem(CLAVE_PRECARGA_TS) || 0);
    if (Date.now() - ultimo < CADA_MS) return;

    const rutas = [...(ACCESOS[rol] ?? ACCESOS.cajero), ...RUTAS_ARRANQUE];

    // Secuencial y a paso lento: esto corre en segundo plano mientras el dueño
    // trabaja, y en datos móviles no queremos competir con la sincronización.
    for (const ruta of rutas) {
        try {
            await precargarUna(ruta);
        } catch {
            return; // se cayó la señal: lo intentamos en la próxima apertura
        }
    }

    localStorage.setItem(CLAVE_PRECARGA_TS, String(Date.now()));
}
