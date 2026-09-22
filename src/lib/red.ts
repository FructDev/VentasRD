// src/lib/red.ts
// Detección de conectividad REAL, no la del navegador.
//
// navigator.onLine solo dice "hay una interfaz de red asociada". En el colmado
// eso es falso positivo constante: se va la luz, el router muere, la tablet
// sigue conectada al WiFi y el navegador jura que hay internet. Las peticiones
// entonces se cuelgan 30-60s en vez de fallar rápido, y la app decide mal.
//
// Aquí preguntamos al servidor de verdad, con un timeout corto. Cualquier
// respuesta HTTP (incluso 401) prueba que hay ruta hasta Supabase; solo un
// error de red o el abort significan que estamos aislados.

const CACHE_MS = 5000; // El arranque consulta varias veces seguidas

let ultimo: { ts: number; ok: boolean } | null = null;

/** ¿Se puede alcanzar Supabase ahora mismo? */
export async function hayServidor(timeoutMs = 2500): Promise<boolean> {
    if (typeof navigator === 'undefined') return true;

    // Si el navegador dice que no hay red, no hay nada que comprobar.
    if (!navigator.onLine) {
        ultimo = { ts: Date.now(), ok: false };
        return false;
    }

    if (ultimo && Date.now() - ultimo.ts < CACHE_MS) return ultimo.ok;

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) return true;

    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        await fetch(`${url}/auth/v1/health`, { method: 'GET', signal: ctrl.signal, cache: 'no-store' });
        ultimo = { ts: Date.now(), ok: true };
        return true;
    } catch {
        ultimo = { ts: Date.now(), ok: false };
        return false;
    } finally {
        clearTimeout(id);
    }
}

/** Olvida el resultado cacheado (al volver la señal queremos recomprobar ya). */
export function olvidarEstadoRed() {
    ultimo = null;
}
