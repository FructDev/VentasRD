import {getSharedCaptureContext} from '@/lib/sync/shared-capture';
import type { VentaRDDatabase } from '@/lib/db/dexie';
import type { ConfirmarVentaLocalEntrada } from './confirmarVentaLocal';
import type { EfectosVentaLocal } from './contrato';
import type { CartItem, CartScope } from '@/store/useCartStore';
import { confirmarVentaLocal } from './confirmarVentaLocal';
import { commandHash } from '@/lib/domain/local/command';
import { asegurarContratoPreparacionVenta } from './contrato';
import { reservarNcfEn, verificarReservaNcf, finalizarReservaNcfEn, type NcfTipo, type ReservaNcf } from './ncfLocal';

export type ComprobanteItem = Pick<CartItem, 'id' | 'negocio_id' | 'nombre' | 'cantidad' | 'precio_venta' | 'tasa_itbis' | 'tipo' | 'ubicacion' | 'serial_id' | 'serial_numero' | 'venta_libre'>;
export interface ComprobanteCheckout {
    items: ComprobanteItem[]; subtotal: number; itbis: number; descuento: number; total: number; montoRecibido: number;
    negocio: { nombre: string; rnc?: string; direccion?: string; telefono?: string; mensajePie?: string };
    logoUrl?: string;
}
export interface CheckoutEntrada { cartId: string; scope: CartScope; comando: ConfirmarVentaLocalEntrada; comprobante: ComprobanteCheckout;
    solicitudFiscal?: { version: 1; tipo: NcfTipo; deviceId: string } }
export interface CheckoutLocal extends CheckoutEntrada {
    version: 1; estado: 'PREPARED' | 'COMMITTED' | 'ABANDONED'; efectos?: EfectosVentaLocal;
    fiscal: 'NONE' | 'LEGACY_NON_ATOMIC' | 'LOCAL_RESERVED'; reconocidoUI: boolean; reservaNcf?: ReservaNcf;
}
const key = (scope: CartScope, id: string) => `${scope.negocioId}:CHECKOUT:${id}`;
const intentionHash = (entrada: CheckoutEntrada) => commandHash({ kind: 'CHECKOUT', contractVersion: 1,
    cartId: entrada.cartId, scope: entrada.scope,
    comando: entrada.solicitudFiscal ? { ...entrada.comando, ncf: undefined } : entrada.comando, comprobante: entrada.comprobante,
    ...(entrada.solicitudFiscal ? { solicitudFiscal: entrada.solicitudFiscal } : {}) });
function assertScope(row: CheckoutLocal, scope: CartScope) {
    if (row.scope.negocioId !== scope.negocioId || row.scope.sucursalId !== scope.sucursalId) throw new Error('checkout_ambito_invalido');
}
export async function prepararCheckoutLocal(db: VentaRDDatabase, entrada: CheckoutEntrada): Promise<CheckoutLocal> {
    const shared=getSharedCaptureContext(db);
    if(shared?.tenantId===entrada.scope.negocioId&&(entrada.solicitudFiscal||entrada.comando.ncf))throw new Error('SHARED_FISCAL_EXCLUDED');
    entrada = structuredClone(entrada);
    entrada.comprobante.items = entrada.comprobante.items.map(i => ({ id: i.id, negocio_id: i.negocio_id,
        nombre: i.nombre, cantidad: i.cantidad, precio_venta: i.precio_venta, tasa_itbis: i.tasa_itbis, tipo: i.tipo,
        ubicacion: i.ubicacion, serial_id: i.serial_id, serial_numero: i.serial_numero,
        ...(i.venta_libre ? { venta_libre: true } : {}) }));
    if (!entrada.cartId || entrada.cartId !== entrada.comando.operacionId || !entrada.scope.negocioId ||
        entrada.scope.negocioId !== entrada.comando.negocioId || entrada.scope.sucursalId !== (entrada.comando.sucursalId ?? null)) {
        throw new Error('checkout_ambito_invalido');
    }
    if (entrada.comprobante.total !== entrada.comando.total) throw new Error('checkout_comprobante_invalido');
    if (entrada.solicitudFiscal && (entrada.comando.ncf !== undefined || entrada.solicitudFiscal.version !== 1)) throw new Error('ncf_input_invalido');
    const hash = intentionHash(entrada);
    return db.transaction('rw', db.operaciones_locales, db.ventas, async () => {
        const previous = await db.operaciones_locales.get(key(entrada.scope, entrada.cartId));
        if (previous) {
            await leerCheckoutLocal(db, entrada.scope, entrada.cartId);
            if (previous.payload_hash !== hash) throw new Error('checkout_intencion_conflicto');
            return previous.resultado as CheckoutLocal;
        }
        asegurarContratoPreparacionVenta(entrada.comando);
        const reservaNcf = entrada.solicitudFiscal ? await reservarNcfEn(db, entrada.scope, entrada.cartId, hash,
            entrada.solicitudFiscal.tipo, entrada.solicitudFiscal.deviceId) : undefined;
        const row: CheckoutLocal = { ...entrada, version: 1, estado: 'PREPARED', reconocidoUI: false,
            ...(reservaNcf ? { reservaNcf, comando: { ...entrada.comando, ncf: reservaNcf.facts.ncf } } : {}),
            fiscal: reservaNcf ? 'LOCAL_RESERVED' : entrada.comando.ncf ? 'LEGACY_NON_ATOMIC' : 'NONE' };
        await db.operaciones_locales.add({ id: key(entrada.scope, entrada.cartId), negocio_id: entrada.scope.negocioId,
            operation_id: entrada.cartId, tipo: 'CHECKOUT', contract_version: 1, payload_hash: hash,
            estado_local: 'PREPARED', estado_remoto: 'NOT_ENABLED', fecha_origen: entrada.comando.fecha, resultado: row });
        return row;
    });
}
export async function confirmarCheckoutLocal(db: VentaRDDatabase, scope: CartScope, id: string): Promise<CheckoutLocal> {
    scope = structuredClone(scope);
    // La confirmación SALE anidada comparte este lock/commit. Si falla el journal
    // CHECKOUT, también se revierten ticket, venta, stock, seriales y fiado.
    return db.transaction('rw', [db.operaciones_locales, db.ventas, db.venta_detalles, db.productos,
        db.transacciones_fiado, db.movimientos_stock, db.seriales, db.secuencias, db.cajas, db.clientes], async () => {
        const row = await leerCheckoutLocal(db, scope, id);
        if (!row) throw new Error('checkout_no_encontrado');
        if (row.estado === 'ABANDONED') throw new Error('checkout_abandonado');
        if (row.estado === 'COMMITTED') return row;
        const { efectos } = await confirmarVentaLocal(db, row.comando);
        const result: CheckoutLocal = { ...row, estado: 'COMMITTED', efectos,
            ...(row.reservaNcf ? { reservaNcf: await finalizarReservaNcfEn(db, row.reservaNcf, 'COMMITTED') } : {}) };
        await db.operaciones_locales.update(key(scope, id), { estado_local: 'COMMITTED', resultado: result });
        return result;
    });
}
export async function leerCheckoutLocal(db: VentaRDDatabase, scope: CartScope, id: string): Promise<CheckoutLocal | undefined> {
    const record = await db.operaciones_locales.get(key(scope, id));
    if (!record) return undefined;
    if (record.tipo === 'CHECKOUT_DRAFT_RELEASE') throw new Error('checkout_abandonado');
    const row = record.resultado as CheckoutLocal;
    assertScope(row, scope);
    if (record.tipo !== 'CHECKOUT' || row.version !== 1 || row.cartId !== id || row.comando.operacionId !== id ||
        record.negocio_id !== scope.negocioId || record.estado_local !== row.estado || record.payload_hash !== intentionHash(row)) {
        throw new Error('checkout_integridad_invalida');
    }
    if (row.solicitudFiscal) {
        if (row.fiscal !== 'LOCAL_RESERVED' || !row.reservaNcf || row.reservaNcf.estado !== row.estado ||
            row.solicitudFiscal.tipo !== row.reservaNcf.facts.tipo || row.solicitudFiscal.deviceId !== row.reservaNcf.facts.deviceId) throw new Error('ncf_reserva_invalida');
        await verificarReservaNcf(db, row.reservaNcf, scope, id, record.payload_hash, row.comando.ncf);
    } else if (row.fiscal === 'LOCAL_RESERVED' || row.reservaNcf) throw new Error('ncf_reserva_invalida');
    return row;
}
export async function abandonarCheckoutLocal(db: VentaRDDatabase, scope: CartScope, id: string): Promise<void> {
    await db.transaction('rw', db.operaciones_locales, db.ventas, async () => {
        const row = await leerCheckoutLocal(db, scope, id);
        if (!row) throw new Error('checkout_no_encontrado');
        if (row.estado === 'COMMITTED' || await db.ventas.get(id)) throw new Error('checkout_ya_confirmado');
        const result: CheckoutLocal = { ...row, estado: 'ABANDONED',
            ...(row.reservaNcf ? { reservaNcf: await finalizarReservaNcfEn(db, row.reservaNcf, 'ABANDONED') } : {}) };
        await db.operaciones_locales.update(key(scope, id), { estado_local: 'ABANDONED', resultado: result });
    });
}
export async function reconocerCheckoutLocal(db: VentaRDDatabase, scope: CartScope, id: string): Promise<void> {
    await db.transaction('rw', db.operaciones_locales, async () => {
        const row = await leerCheckoutLocal(db, scope, id);
        if (!row || row.estado !== 'COMMITTED') throw new Error('checkout_no_confirmado');
        await db.operaciones_locales.update(key(scope, id), { resultado: { ...row, reconocidoUI: true } });
    });
}
export async function listarCheckoutsSinResolver(db: VentaRDDatabase, scope: CartScope): Promise<CheckoutLocal[]> {
    const records = await db.operaciones_locales.where('negocio_id').equals(scope.negocioId).toArray();
    return records.filter(r => r.tipo === 'CHECKOUT').map(r => r.resultado as CheckoutLocal)
        .filter(r => r.scope.sucursalId === scope.sucursalId && !r.reconocidoUI && r.estado !== 'ABANDONED')
        .sort((a, b) => a.comando.fecha - b.comando.fecha || a.cartId.localeCompare(b.cartId));
}
export async function abandonarBorradorSinCheckout(db: VentaRDDatabase, scope: CartScope, id: string, fecha: number): Promise<void> {
    scope = structuredClone(scope);
    if (!id || !scope.negocioId || !Number.isSafeInteger(fecha) || fecha < 0) throw new Error('checkout_ambito_invalido');
    await db.transaction('rw', db.operaciones_locales, db.ventas, async () => {
        if (await db.operaciones_locales.get(key(scope, id)) || await db.ventas.get(id)) throw new Error('checkout_intento_existente');
        // Tombstone de acción explícita, NO un comando/venta/NCF históricos inventados.
        // Comparte clave con prepare para impedir una preparación tardía concurrente.
        const result = { scope, cartId: id, reason: 'NO_CHECKOUT_FOUND' };
        await db.operaciones_locales.add({ id: key(scope, id), negocio_id: scope.negocioId, operation_id: id,
            tipo: 'CHECKOUT_DRAFT_RELEASE', contract_version: 1, payload_hash: commandHash(result),
            estado_local: 'ABANDONED', estado_remoto: 'NOT_ENABLED', fecha_origen: fecha, resultado: result });
    });
}
