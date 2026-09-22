import { normalizeMoney } from '../normalize';

function cents(value: string): bigint {
    const normalized = normalizeMoney(value);
    const negative = normalized.startsWith('-');
    const [whole, fraction] = normalized.replace('-', '').split('.');
    const amount = BigInt(whole) * BigInt(100) + BigInt(fraction);
    return negative ? -amount : amount;
}
function fromCents(value: bigint): string {
    const negative = value < BigInt(0); const absolute = negative ? -value : value;
    return `${negative ? '-' : ''}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, '0')}`;
}
export function sumMoney(values: readonly string[]): string { return fromCents(values.reduce((sum, value) => sum + cents(value), BigInt(0))); }
export function subtractMoney(left: string, right: string): string { return fromCents(cents(left) - cents(right)); }
export function moneyEqual(left: string, right: string): boolean { return cents(left) === cents(right); }
