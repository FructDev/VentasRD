/** Razón exacta del decimal representado por el input. Sin tolerancia,
 * truncamiento ni redondeo; admite notación científica de números finitos. */
export function decimalRatio(value: number): { n: bigint; d: bigint } {
    if (!Number.isFinite(value) || value < 0) throw new Error('decimal_invalid');
    const [mantissa, exponent = '0'] = value.toString().toLowerCase().split('e');
    const [integer, fraction = ''] = mantissa.split('.');
    const scale = fraction.length - Number(exponent);
    const n = BigInt(integer + fraction), ten = BigInt(10);
    return scale < 0 ? { n: n * ten ** BigInt(-scale), d: BigInt(1) } : { n, d: ten ** BigInt(scale) };
}
