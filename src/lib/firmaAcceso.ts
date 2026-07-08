// src/lib/firmaAcceso.ts
// Firma de integridad de los campos de acceso/suscripción guardados en
// localStorage. NO es criptografía (la sal vive en el cliente): es una barrera
// de ofuscación que impide que alguien con F12 edite accesoHasta/planActivo
// con un tutorial. Un atacante que lea el código puede regenerarla — ese
// perfil no es el mercado de este producto, y el servidor sigue siendo la
// única fuente de verdad al reconectar.

const SAL = 'vrd.acc.v1.k3x9';

export interface CamposAcceso {
    negocioId: string | null;
    accesoHasta: number | null;
    trialHasta: number | null;
    planActivo: boolean;
    ultimaFechaVista: number;
    aperturasSinServidor: number;
}

export function firmarAcceso(c: CamposAcceso): string {
    const s = `${SAL}|${c.negocioId || ''}|${c.accesoHasta ?? ''}|${c.trialHasta ?? ''}|${c.planActivo ? 1 : 0}|${c.ultimaFechaVista || 0}|${c.aperturasSinServidor || 0}`;
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 16777619) >>> 0;
        h2 = (Math.imul(h2, 31) + ch) >>> 0;
    }
    return `${h1.toString(36)}.${h2.toString(36)}`;
}
