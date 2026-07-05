// src/lib/logoCache.ts
// Cache local del logo del negocio para imprimir OFFLINE.
// El logo vive en Cloudinary (URL remota); si al imprimir no hay internet,
// la imagen no carga y el ticket sale sin logo. Aquí lo bajamos una vez
// (cuando hay conexión) y lo guardamos como data URL en localStorage.

const KEY = 'vrd_logo_cache';

/**
 * Devuelve el logo listo para imprimir: data URL local si es posible.
 * - data URL → se devuelve tal cual
 * - URL remota → cache local; si no hay cache y falla la descarga,
 *   devuelve la URL original (la impresión online aún puede resolverla).
 */
export async function logoParaImprimir(url: string | null | undefined): Promise<string | undefined> {
    if (!url) return undefined;
    if (url.startsWith('data:')) return url;

    // ¿Ya está cacheado este mismo logo?
    try {
        const c = JSON.parse(localStorage.getItem(KEY) || 'null') as { url: string; dataUrl: string } | null;
        if (c?.url === url && c.dataUrl) return c.dataUrl;
    } catch { /* cache corrupto: se regenera abajo */ }

    // Descargar y convertir a data URL (solo funciona online)
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(String(resp.status));
        const blob = await resp.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.onerror = () => reject(r.error);
            r.readAsDataURL(blob);
        });
        try { localStorage.setItem(KEY, JSON.stringify({ url, dataUrl })); } catch { /* lleno: seguir sin cachear */ }
        return dataUrl;
    } catch {
        return url; // offline sin cache: que el navegador lo intente (online normal)
    }
}
