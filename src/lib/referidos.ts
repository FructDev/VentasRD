// src/lib/referidos.ts
// Constantes compartidas del programa de referidos (cliente y servidor).

/** Días de acceso que gana cada parte (quien invita y el invitado) por referido válido. */
export const DIAS_REFERIDO = 15;

/** Alfabeto sin caracteres ambiguos (0/O, 1/I/L) para códigos legibles. */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Genera un código de referido tipo "REF-XXXXX" (aleatorio, legible). */
export function generarCodigoReferido(): string {
    let s = '';
    for (let i = 0; i < 5; i++) s += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
    return `REF-${s}`;
}
