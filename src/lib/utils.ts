import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Formatea un número como moneda dominicana (RD$)
 */
export function formatDOP(amount: number): string {
  return `RD$${amount.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Formatea un timestamp a fecha legible
 */
export function formatDate(timestamp: number | string): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Formatea un timestamp a fecha y hora legible
 */
export function formatDateTime(timestamp: number | string): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString('es-DO', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Devuelve el estado visual de stock
 */
export function getEstadoStock(actual: number, minimo: number): 'ok' | 'bajo' | 'critico' {
  if (actual <= 0) return 'critico';
  if (actual <= minimo) return 'bajo';
  return 'ok';
}

/**
 * Calcula el ITBIS de un monto con tasa dada
 */
export function calcularITBIS(subtotal: number, tasa: number): number {
  return subtotal * tasa;
}

// ─── PIN Hashing ──────────────────────────────────────────────────────────────
// Usamos SHA-256 via Web Crypto API (disponible en todos los navegadores modernos y en Node 20+).
// Los PINs de 4 dígitos son texto plano (legado). Los hashes tienen 64 caracteres hex.

/**
 * Devuelve el hash SHA-256 de un PIN en formato hex.
 */
export async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(pin);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verifica si un PIN ingresado coincide con el almacenado.
 * Soporta el formato legado (texto plano 4 dígitos) y el nuevo formato (hash SHA-256, 64 chars).
 */
export async function verificarPin(pinIngresado: string, pinAlmacenado: string): Promise<boolean> {
  if (!pinAlmacenado) return false;
  // Legado: PIN en texto plano
  if (pinAlmacenado.length === 4) return pinIngresado === pinAlmacenado;
  // Nuevo: comparar hashes
  const hash = await hashPin(pinIngresado);
  return hash === pinAlmacenado;
}
