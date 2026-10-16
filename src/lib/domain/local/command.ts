import { sha256Hex } from '@/lib/sync/inventory/canonical-payload';

/** Orden de claves estable; el orden de listas es parte del contrato. Sin reloj/red. */
export function canonicalCommand(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('command_number_invalid');
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalCommand).join(',')}]`;
    if (typeof value === 'object' && value) {
        return `{${Object.keys(value).sort().map(key => {
            const field = (value as Record<string, unknown>)[key];
            return `${JSON.stringify(key)}:${canonicalCommand(field === undefined ? null : field)}`;
        }).join(',')}}`;
    }
    throw new Error('command_value_invalid');
}
export function commandHash(value: unknown): string { return sha256Hex(canonicalCommand(value)); }

/** Exacto en centavos. Admite únicamente ruido IEEE de centavos ya representables. */
export function moneyCents(value: number): number {
    const cents = Math.round(value * 100);
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 0.000001) {
        throw new Error('importe_no_representable_en_centavos');
    }
    return cents;
}
