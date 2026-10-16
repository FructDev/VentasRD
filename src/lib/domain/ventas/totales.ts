import { moneyCents } from '@/lib/domain/local/command';
import { decimalRatio } from '@/lib/domain/local/decimal';

interface LineaImporte { precio_venta: number; cantidad: number; tasa_itbis?: number }
const ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2), HUNDRED = BigInt(100);

/** Decimal escrito por el llamador, también en notación científica. No redondea. */
function ratio(value: number): { n: bigint; d: bigint } {
    try { return decimalRatio(value); }
    catch { throw new Error('importe_decimal_invalido'); }
}
function roundHalfUp(n: bigint, d: bigint): bigint { return (TWO * n + d) / (TWO * d); }
function amount(cents: bigint): number {
    if (cents < ZERO || cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('importe_centavos_fuera_rango');
    const result = Number(cents) / 100;
    if (BigInt(moneyCents(result)) !== cents) throw new Error('importe_centavos_no_representable');
    return result;
}

/** Política aprobada: ITBIS sumado sin redondeo por línea, redondeo half-up una
 * vez por ticket. Descuento conserva la semántica existente: sobre bruto. */
export function calcularTotalesExactos(items: readonly LineaImporte[], tipo: 'porcentaje' | 'monto', valor: number) {
    let subtotal = ZERO, taxNumerator = ZERO, taxDenominator = ONE;
    for (const item of items) {
        const quantity = ratio(item.cantidad);
        if (quantity.n === ZERO) throw new Error('importe_cantidad_invalida');
        const product = BigInt(moneyCents(item.precio_venta)) * quantity.n;
        if (product % quantity.d !== ZERO) throw new Error('importe_subtotal_no_representable');
        const line = product / quantity.d;
        subtotal += line;
        const taxValue = item.tasa_itbis ?? 0;
        if (taxValue > 1) throw new Error('importe_tasa_invalida');
        const tax = ratio(taxValue);
        // Todos los denominadores son potencias de diez: escalar al mayor evita
        // multiplicar denominadores acumulativamente con cada línea.
        if (tax.d > taxDenominator) {
            taxNumerator *= tax.d / taxDenominator; taxDenominator = tax.d;
        }
        taxNumerator += line * tax.n * (taxDenominator / tax.d);
    }
    const itbis = roundHalfUp(taxNumerator, taxDenominator);
    const bruto = subtotal + itbis;
    const discount = ratio(valor);
    const requested = tipo === 'monto' ? BigInt(moneyCents(valor))
        : discount.n >= HUNDRED * discount.d ? bruto : roundHalfUp(bruto * discount.n, discount.d * HUNDRED);
    const descuento = requested > bruto ? bruto : requested;
    return { subtotal: amount(subtotal), itbis: amount(itbis), descuento: amount(descuento), total: amount(bruto - descuento) };
}
