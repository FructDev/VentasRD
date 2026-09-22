import type { VentaLocal } from '@/types/database';
import type { ObservedSale } from './types';

function expandExponent(value: string): string {
    if (!/[eE]/.test(value)) return value;
    const [coefficient, rawExponent] = value.toLowerCase().split('e');
    const exponent = Number(rawExponent);
    if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) throw new Error('decimal exponent out of bounds');
    const negative = coefficient.startsWith('-');
    const unsigned = coefficient.replace(/^[+-]/, '');
    const dot = unsigned.indexOf('.');
    const digits = unsigned.replace('.', '');
    const point = (dot < 0 ? unsigned.length : dot) + exponent;
    const expanded = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? `${digits}${'0'.repeat(point - digits.length)}` : `${digits.slice(0, point)}.${digits.slice(point)}`;
    return negative ? `-${expanded}` : expanded;
}

function decimalParts(value: number | string): { negative: boolean; whole: string; fraction: string } {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite decimal');
    const raw = expandExponent(String(value).trim());
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
    if (!match) throw new Error('invalid decimal');
    return { negative: match[1] === '-', whole: match[2], fraction: match[3] ?? '' };
}

/** Exact decimal-string conversion; half-up to cents, including negative values. */
export function normalizeMoney(value: number | string): string {
    const { negative, whole, fraction } = decimalParts(value);
    let cents = BigInt(whole) * BigInt(100) + BigInt((fraction + '00').slice(0, 2));
    if (Number(fraction[2] ?? '0') >= 5) cents += BigInt(1);
    const sign = negative && cents !== BigInt(0) ? '-' : '';
    return `${sign}${cents / BigInt(100)}.${String(cents % BigInt(100)).padStart(2, '0')}`;
}

/** Stock is not rounded to whole units or cents. */
export function normalizeQuantity(value: number | string): string {
    const { negative, whole, fraction } = decimalParts(value);
    const integer = BigInt(whole).toString();
    const decimals = fraction.replace(/0+$/, '');
    const zero = integer === '0' && decimals.length === 0;
    return `${negative && !zero ? '-' : ''}${integer}${decimals ? `.${decimals}` : ''}`;
}

export function addQuantities(values: readonly string[]): string {
    const parts = values.map(decimalParts);
    const scale = Math.max(0, ...parts.map(part => part.fraction.length));
    const factor = BigInt(10) ** BigInt(scale);
    const total = parts.reduce((sum, part) => {
        const units = BigInt(part.whole) * factor + BigInt((part.fraction + '0'.repeat(scale)).slice(0, scale) || '0');
        return sum + (part.negative ? -units : units);
    }, BigInt(0));
    const sign = total < BigInt(0) ? '-' : '';
    const absolute = total < BigInt(0) ? -total : total;
    return normalizeQuantity(`${sign}${absolute / factor}${scale ? `.${String(absolute % factor).padStart(scale, '0')}` : ''}`);
}

export function normalizeSale(row: Pick<VentaLocal, 'id' | 'negocio_id' | 'total' | 'metodo_pago' | 'estado_sincronizacion' | 'fecha_creacion'> & Partial<VentaLocal>, sourceId: string, observedAt: number): ObservedSale {
    return {
        id: row.id, negocioId: row.negocio_id, ...(row.sucursal_id && { sucursalId: row.sucursal_id }),
        sourceId, observedAt, fecha: row.fecha_creacion, total: normalizeMoney(row.total),
        metodoPago: row.metodo_pago, syncFlag: row.estado_sincronizacion,
        ...(row.caja_codigo && { cajaCodigo: row.caja_codigo }),
        ...(row.cliente_id && { clienteId: row.cliente_id }),
        ...(row.monto_efectivo !== undefined && { montoEfectivo: normalizeMoney(row.monto_efectivo) }),
        ...(row.monto_transferencia !== undefined && { montoTransferencia: normalizeMoney(row.monto_transferencia) }),
    };
}
