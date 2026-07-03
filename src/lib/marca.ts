// src/lib/marca.ts
// Paleta curada de colores de marca. Todos son suficientemente claros para que el
// texto oscuro de los botones (text-navy) se lea bien, y suficientemente vivos para
// leerse como texto sobre el fondo oscuro. Evita problemas de contraste.

export interface Paleta { label: string; gold: string; gold2: string; }

export const PALETAS: Record<string, Paleta> = {
    dorado:    { label: 'Dorado',    gold: '#D4A017', gold2: '#EFC84A' },
    ambar:     { label: 'Ámbar',     gold: '#F59E0B', gold2: '#FBBF24' },
    naranja:   { label: 'Naranja',   gold: '#FB923C', gold2: '#FDBA74' },
    coral:     { label: 'Coral',     gold: '#FB7185', gold2: '#FDA4AF' },
    rosa:      { label: 'Rosa',      gold: '#F472B6', gold2: '#F9A8D4' },
    lima:      { label: 'Lima',      gold: '#84CC16', gold2: '#A3E635' },
    esmeralda: { label: 'Esmeralda', gold: '#34D399', gold2: '#6EE7B7' },
    turquesa:  { label: 'Turquesa',  gold: '#2DD4BF', gold2: '#5EEAD6' },
    cielo:     { label: 'Cielo',     gold: '#38BDF8', gold2: '#7DD3FC' },
};

export const PALETA_DEFAULT = 'dorado';

/** Aplica el color de marca al documento (setea las variables --color-gold*). */
export function aplicarColorMarca(clave: string | null | undefined) {
    if (typeof document === 'undefined') return;
    const p = PALETAS[clave || ''] || PALETAS[PALETA_DEFAULT];
    const el = document.documentElement;
    el.style.setProperty('--color-gold', p.gold);
    el.style.setProperty('--color-gold-2', p.gold2);
}

// ── Fuentes de marca ─────────────────────────────────────────────────────────
// Tipografía de títulos y logo. Cada clave apunta a la variable CSS que expone
// next/font en <html> (ver layout.tsx). El cuerpo del texto no cambia.
export interface Fuente { label: string; cssVar: string; }

export const FUENTES: Record<string, Fuente> = {
    syne:      { label: 'Syne',           cssVar: '--font-syne' },
    poppins:   { label: 'Poppins',        cssVar: '--font-poppins' },
    montserrat:{ label: 'Montserrat',     cssVar: '--font-montserrat' },
    spacegro:  { label: 'Space Grotesk',  cssVar: '--font-space-grotesk' },
    sora:      { label: 'Sora',           cssVar: '--font-sora' },
    outfit:    { label: 'Outfit',         cssVar: '--font-outfit' },
    playfair:  { label: 'Playfair',       cssVar: '--font-playfair' },
};

export const FUENTE_DEFAULT = 'syne';

/** Aplica la fuente de marca (redefine --font-display). */
export function aplicarFuenteMarca(clave: string | null | undefined) {
    if (typeof document === 'undefined') return;
    const f = FUENTES[clave || ''] || FUENTES[FUENTE_DEFAULT];
    document.documentElement.style.setProperty('--font-display', `var(${f.cssVar})`);
}
