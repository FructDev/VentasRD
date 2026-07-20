// src/lib/linkPago.ts
// Los QR de texto plano con números de cuenta los leen mal los celulares
// (los interpretan como teléfono). Solución: el QR contiene un LINK a la
// página /pagar, que muestra los datos con formato y botón de copiar.
// Los datos viajan en el fragmento #d=... — el navegador NUNCA lo envía al
// servidor (ni logs ni analytics lo ven).

export interface DatosLinkPago {
    banco: string;
    cuenta: string;
    titular: string;
    monto: number;
    /** Nombre de quien cobra (negocio) — para el encabezado de la página */
    nombre?: string;
}

// btoa/atob seguros con tildes y eñes
const enc = (s: string) => btoa(unescape(encodeURIComponent(s)));
const dec = (s: string) => decodeURIComponent(escape(atob(s)));

export function crearLinkPago(d: DatosLinkPago): string {
    const payload = enc(JSON.stringify(d));
    const origen = typeof window !== 'undefined' ? window.location.origin : 'https://ventard.vercel.app';
    return `${origen}/pagar#d=${payload}`;
}

export function leerLinkPago(hash: string): DatosLinkPago | null {
    try {
        const m = hash.match(/d=([A-Za-z0-9+/=_-]+)/);
        if (!m) return null;
        const d = JSON.parse(dec(m[1])) as DatosLinkPago;
        if (!d.cuenta || typeof d.monto !== 'number') return null;
        return d;
    } catch {
        return null;
    }
}
