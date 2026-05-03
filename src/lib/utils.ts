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
