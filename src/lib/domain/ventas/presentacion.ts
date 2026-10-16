import { moneyCents } from '@/lib/domain/local/command';
import { calcularTotalesExactos } from './totales';

export function puedeAbrirCarrito(articulos: number, pausas: number): boolean {
    return articulos > 0 || pausas > 0;
}

/** null es no verificable/insuficiente, nunca efectivo devuelto igual al recibido. */
export function devueltaVerificable(recibido: string, total: number, error: string | null): number | null {
    if (error || !recibido.trim()) return null;
    try {
        const paid = moneyCents(Number(recibido)), due = moneyCents(total);
        return paid >= due ? (paid - due) / 100 : null;
    } catch { return null; }
}

export function resumenBorrador(draft: {
    items: Parameters<typeof calcularTotalesExactos>[0];
    tipoDescuento: 'porcentaje' | 'monto'; valorDescuento: number;
}): { total: number | null; verificable: boolean } {
    try {
        return { total: calcularTotalesExactos(draft.items, draft.tipoDescuento, draft.valorDescuento).total, verificable: true };
    } catch { return { total: null, verificable: false }; }
}

export function debeConfirmarConEnter(state: {
    key: string; checkoutOpen: boolean; ventaExitosa: boolean; importeValido: boolean; procesando: boolean;
}): boolean {
    return state.key === 'Enter' && state.checkoutOpen && !state.ventaExitosa && state.importeValido && !state.procesando;
}
