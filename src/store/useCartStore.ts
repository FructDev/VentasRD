// src/store/useCartStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ProductoLocal } from '@/types/database';
import { v4 as uuidv4 } from 'uuid';
import { calcularTotalesExactos } from '@/lib/domain/ventas/totales';

export interface CartScope { negocioId: string; sucursalId: string | null }
export function mismoScope(a: CartScope | null | undefined, b: CartScope | null | undefined): boolean {
    return !!a && !!b && a.negocioId === b.negocioId && a.sucursalId === b.sucursalId;
}

export interface CartItem extends ProductoLocal {
    cantidad: number;
    venta_libre?: true;
    serial_id?: string;      // Solo si el producto es serializable
    serial_numero?: string;  // Número de serie seleccionado (para mostrar en ticket)
}

/** Venta pausada ("en espera"): el carrito completo congelado para retomarlo. */
export interface VentaEnEspera {
    id: string;
    numero: number;               // consecutivo local: "Venta #3"
    etiqueta: string | null;      // nombre del cliente si lo había; null = sin nombre
    items: CartItem[];
    clienteActivoId: string | null;
    tipoPrecios: 1 | 2 | 3;
    tipoDescuento: 'porcentaje' | 'monto';
    valorDescuento: number;
    creado: number;
    scope?: CartScope | null;
    cartId?: string | null;
}
export interface CarritoGuardado {
    scope: CartScope | null; cartId: string | null; bloqueado: boolean;
    items: CartItem[]; clienteActivoId: string | null; tipoPrecios: 1 | 2 | 3;
    tipoDescuento: 'porcentaje' | 'monto'; valorDescuento: number;
    ventaEnCursoNumero: number | null; ventaEnCursoEtiqueta: string | null;
}

export const MAX_EN_ESPERA = 10;

/** Devuelve el precio efectivo según el tier activo del cliente */
export function getPrecioEfectivo(producto: ProductoLocal, tier: 1 | 2 | 3): number {
    if (tier === 2 && producto.precio_2) return producto.precio_2;
    if (tier === 3 && producto.precio_3) return producto.precio_3;
    return producto.precio_venta;
}

interface CartState {
    scope: CartScope | null;
    cartId: string | null;
    bloqueado: boolean;
    carritosGuardados: CarritoGuardado[];
    activarScope: (scope: CartScope) => void;
    bloquearCheckout: (id: string) => void;
    desbloquearCheckout: (id: string) => void;
    finalizarCheckout: (id: string) => void;
    renovarCheckout: (id: string) => void;
    items: CartItem[];
    subtotal: number;
    itbis: number;
    descuento: number;        // monto de descuento calculado
    total: number;
    /** Totales placeholder nunca se cobran mientras este diagnóstico exista. */
    errorCalculo: 'importe_carrito_incompatible' | null;

    tipoDescuento: 'porcentaje' | 'monto';
    valorDescuento: number;   // valor que ingresó el usuario (% o RD$)

    // Cliente activo para pricing (independiente del método de pago)
    clienteActivoId: string | null;
    tipoPrecios: 1 | 2 | 3;

    // Ventas en espera (facturas pausadas)
    enEspera: VentaEnEspera[];
    // Identidad de la venta retomada: al re-pausarla conserva su número/etiqueta
    ventaEnCursoNumero: number | null;
    ventaEnCursoEtiqueta: string | null;

    addItem: (producto: ProductoLocal) => void;
    addItemConSerial: (producto: ProductoLocal, serialId: string, serialNumero: string) => void;
    removeItem: (id: string) => void;
    updateQuantity: (id: string, cantidad: number) => void;
    setDescuento: (tipo: 'porcentaje' | 'monto', valor: number) => void;
    setCliente: (clienteId: string | null, tier: 1 | 2 | 3) => void;
    clearCart: () => void;
    /** Pausa el carrito actual. Devuelve false si está vacío o se llegó al límite. */
    pausarVenta: (etiqueta?: string | null) => boolean;
    /** Retoma una venta pausada. Si el carrito actual tiene ítems, se pausa solo antes. */
    retomarVenta: (id: string, etiquetaCarritoActual?: string | null) => void;
    descartarEnEspera: (id: string) => void;
}

export const calculateTotals = (
    items: CartItem[],
    tipoDescuento: 'porcentaje' | 'monto' = 'porcentaje',
    valorDescuento: number = 0
) => {
    return calcularTotalesExactos(items, tipoDescuento, valorDescuento);
};

function totalsForState(items: CartItem[], tipo: 'porcentaje' | 'monto', valor: number) {
    try { return { ...calculateTotals(items, tipo, valor), errorCalculo: null }; }
    catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('importe_')) throw error;
        // Conservar borrador incompatible sin impedir hidratación. No convertir
        // precios/recetas ni fabricar un importe: UI bloquea y muestra diagnóstico.
        return { subtotal: 0, itbis: 0, descuento: 0, total: 0, errorCalculo: 'importe_carrito_incompatible' as const };
    }
}

const emptyCart = () => ({ items: [] as CartItem[], subtotal: 0, itbis: 0, descuento: 0, total: 0,
    errorCalculo: null,
    tipoDescuento: 'porcentaje' as const, valorDescuento: 0, clienteActivoId: null, tipoPrecios: 1 as const,
    ventaEnCursoNumero: null, ventaEnCursoEtiqueta: null, cartId: null, bloqueado: false });
function snapshotCart(s: CartState): CarritoGuardado {
    return structuredClone({ scope: s.scope, cartId: s.cartId, bloqueado: s.bloqueado, items: s.items,
        clienteActivoId: s.clienteActivoId, tipoPrecios: s.tipoPrecios, tipoDescuento: s.tipoDescuento,
        valorDescuento: s.valorDescuento, ventaEnCursoNumero: s.ventaEnCursoNumero, ventaEnCursoEtiqueta: s.ventaEnCursoEtiqueta });
}
function editable(s: CartState) { if (s.bloqueado) throw new Error('checkout_bloqueado'); }
function productScope(s: CartState, p: ProductoLocal) {
    editable(s);
    // Venta libre legacy usa negocio vacío; su compatibilidad de commit sigue en L07.
    if (s.scope && p.negocio_id && p.negocio_id !== s.scope.negocioId) throw new Error('producto_ambito_invalido');
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
    scope: null, cartId: null, bloqueado: false, carritosGuardados: [],
    activarScope: (scope) => set(s => {
        if (!scope.negocioId) throw new Error('cart_scope_invalido');
        if (mismoScope(s.scope, scope)) return s;
        let saved = [...s.carritosGuardados];
        const target = saved.find(c => mismoScope(c.scope, scope));
        saved = saved.filter(c => c !== target);
        if (s.items.length || s.clienteActivoId || s.bloqueado) {
            saved = saved.filter(c => s.scope ? !mismoScope(c.scope, s.scope) : true);
            saved.push(snapshotCart(s));
        }
        return { ...emptyCart(), ...(target ?? {}), scope: structuredClone(scope), carritosGuardados: saved,
            ...(target ? totalsForState(target.items, target.tipoDescuento, target.valorDescuento) : {}) };
    }),
    bloquearCheckout: id => set(s => {
        if (!id || s.cartId !== id || !s.scope) throw new Error('checkout_cart_invalido');
        return { bloqueado: true };
    }),
    desbloquearCheckout: id => set(s => ({ ...(s.cartId === id ? { bloqueado: false } : {}),
        carritosGuardados: s.carritosGuardados.map(c => c.cartId === id ? { ...c, bloqueado: false } : c) })),
    finalizarCheckout: id => set(s => ({ ...(s.cartId === id ? emptyCart() : {}),
        carritosGuardados: s.carritosGuardados.filter(c => c.cartId !== id) })),
    renovarCheckout: id => set(s => ({ ...(s.cartId === id ? { cartId: uuidv4(), bloqueado: false } : {}),
        carritosGuardados: s.carritosGuardados.map(c => c.cartId === id ? { ...c, cartId: uuidv4(), bloqueado: false } : c) })),
    items: [],
    subtotal: 0,
    itbis: 0,
    descuento: 0,
    total: 0,
    errorCalculo: null,
    tipoDescuento: 'porcentaje',
    valorDescuento: 0,
    clienteActivoId: null,
    tipoPrecios: 1,
    enEspera: [],
    ventaEnCursoNumero: null,
    ventaEnCursoEtiqueta: null,

    addItem: (producto) => set((state) => {
        productScope(state, producto);
        const tier = state.tipoPrecios;
        const precioEfectivo = getPrecioEfectivo(producto, tier);
        const productoConPrecio = { ...producto, precio_venta: precioEfectivo };
        const existingItem = state.items.find(item => item.id === producto.id && !item.serial_id);
        const newItems = existingItem
            ? state.items.map(item => (item.id === producto.id && !item.serial_id) ? { ...item, cantidad: item.cantidad + 1 } : item)
            : [...state.items, { ...productoConPrecio, cantidad: 1 }];
        return { cartId: state.cartId ?? uuidv4(), items: newItems, ...totalsForState(newItems, state.tipoDescuento, state.valorDescuento) };
    }),

    // Serializable: cada serial = línea independiente, qty siempre 1
    addItemConSerial: (producto, serialId, serialNumero) => set((state) => {
        productScope(state, producto);
        const yaEnCarrito = state.items.some(i => i.serial_id === serialId);
        if (yaEnCarrito) return state;
        const precioEfectivo = getPrecioEfectivo(producto, state.tipoPrecios);
        const newItems = [...state.items, { ...producto, precio_venta: precioEfectivo, cantidad: 1, serial_id: serialId, serial_numero: serialNumero }];
        return { cartId: state.cartId ?? uuidv4(), items: newItems, ...totalsForState(newItems, state.tipoDescuento, state.valorDescuento) };
    }),

    removeItem: (id) => set((state) => {
        editable(state);
        const newItems = state.items.filter(item => item.id !== id);
        return { items: newItems, ...totalsForState(newItems, state.tipoDescuento, state.valorDescuento) };
    }),

    updateQuantity: (id, cantidad) => set((state) => {
        editable(state);
        if (cantidad <= 0) {
            const newItems = state.items.filter(item => item.id !== id);
            return { items: newItems, ...totalsForState(newItems, state.tipoDescuento, state.valorDescuento) };
        }
        const newItems = state.items.map(item => item.id === id ? { ...item, cantidad } : item);
        return { items: newItems, ...totalsForState(newItems, state.tipoDescuento, state.valorDescuento) };
    }),

    setDescuento: (tipo, valor) => set((state) => {
        editable(state);
        return ({
        tipoDescuento: tipo,
        valorDescuento: valor,
        ...totalsForState(state.items, tipo, valor),
    }); }),

    setCliente: (clienteId, tier) => set((state) => {
        editable(state);
        // Re-precifica todos los ítems existentes al nuevo tier
        const newItems = state.items.map(item => ({
            ...item,
            precio_venta: getPrecioEfectivo(item, tier),
        }));
        return {
            clienteActivoId: clienteId,
            tipoPrecios: tier,
            items: newItems,
            ...totalsForState(newItems, state.tipoDescuento, state.valorDescuento),
        };
    }),

    clearCart: () => set(s => { editable(s); return emptyCart(); }),

    pausarVenta: (etiqueta) => {
        const s = get();
        editable(s);
        if (s.items.length === 0 || s.enEspera.length >= MAX_EN_ESPERA) return false;
        // Si el carrito viene de una venta retomada, conserva su número original
        const numero = s.ventaEnCursoNumero
            ?? s.enEspera.reduce((m, v) => Math.max(m, v.numero), 0) + 1;
        set({
            enEspera: [...s.enEspera, {
                id: uuidv4(), numero,
                etiqueta: etiqueta?.trim() || s.ventaEnCursoEtiqueta || null,
                items: s.items, clienteActivoId: s.clienteActivoId, tipoPrecios: s.tipoPrecios,
                tipoDescuento: s.tipoDescuento, valorDescuento: s.valorDescuento,
                creado: Date.now(),
                scope: s.scope, cartId: s.cartId,
            }],
            items: [], subtotal: 0, itbis: 0, descuento: 0, total: 0, errorCalculo: null,
            tipoDescuento: 'porcentaje', valorDescuento: 0,
            clienteActivoId: null, tipoPrecios: 1,
            ventaEnCursoNumero: null, ventaEnCursoEtiqueta: null,
            cartId: null, bloqueado: false,
        });
        return true;
    },

    retomarVenta: (id, etiquetaCarritoActual) => {
        const s = get();
        editable(s);
        const venta = s.enEspera.find(v => v.id === id);
        if (!venta) return;
        if (s.scope && !mismoScope(s.scope, venta.scope)) throw new Error('cart_scope_incompatible');
        let enEspera = s.enEspera.filter(v => v.id !== id);
        // El carrito actual no se pierde: se pausa solo antes de retomar
        // (conservando su propio número si también venía de una pausa)
        if (s.items.length > 0) {
            const numero = s.ventaEnCursoNumero
                ?? s.enEspera.reduce((m, v) => Math.max(m, v.numero), 0) + 1;
            enEspera = [...enEspera, {
                id: uuidv4(), numero,
                etiqueta: etiquetaCarritoActual?.trim() || s.ventaEnCursoEtiqueta || null,
                items: s.items, clienteActivoId: s.clienteActivoId, tipoPrecios: s.tipoPrecios,
                tipoDescuento: s.tipoDescuento, valorDescuento: s.valorDescuento,
                creado: Date.now(),
                scope: s.scope, cartId: s.cartId,
            }];
        }
        set({
            enEspera,
            items: venta.items,
            clienteActivoId: venta.clienteActivoId,
            tipoPrecios: venta.tipoPrecios,
            tipoDescuento: venta.tipoDescuento,
            valorDescuento: venta.valorDescuento,
            ventaEnCursoNumero: venta.numero,
            ventaEnCursoEtiqueta: venta.etiqueta,
            cartId: venta.cartId ?? uuidv4(), bloqueado: false,
            ...totalsForState(venta.items, venta.tipoDescuento, venta.valorDescuento),
        });
    },

    descartarEnEspera: (id) => set(state => {
        const row = state.enEspera.find(v => v.id === id);
        if (row && state.scope && !mismoScope(state.scope, row.scope)) throw new Error('cart_scope_incompatible');
        return { enEspera: state.enEspera.filter(v => v.id !== id) };
    }),
  }),
  {
    name: 'ventard-cart',
    partialize: (state) => ({
        scope: state.scope, cartId: state.cartId, bloqueado: state.bloqueado, carritosGuardados: state.carritosGuardados,
        tipoDescuento: state.tipoDescuento, valorDescuento: state.valorDescuento,
        items: state.items,
        clienteActivoId: state.clienteActivoId,
        tipoPrecios: state.tipoPrecios,
        enEspera: state.enEspera,
        ventaEnCursoNumero: state.ventaEnCursoNumero,
        ventaEnCursoEtiqueta: state.ventaEnCursoEtiqueta,
    }),
    merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<CartState>;
        const items = p.items ?? [];
        const tier = p.tipoPrecios ?? 1;
        return {
            ...current,
            scope: p.scope ?? null, cartId: p.cartId ?? null, bloqueado: p.bloqueado ?? false, carritosGuardados: p.carritosGuardados ?? [],
            tipoDescuento: p.tipoDescuento ?? 'porcentaje', valorDescuento: p.valorDescuento ?? 0,
            items,
            clienteActivoId: p.clienteActivoId ?? null,
            tipoPrecios: tier,
            enEspera: p.enEspera ?? [],
            ventaEnCursoNumero: p.ventaEnCursoNumero ?? null,
            ventaEnCursoEtiqueta: p.ventaEnCursoEtiqueta ?? null,
            ...totalsForState(items, p.tipoDescuento ?? 'porcentaje', p.valorDescuento ?? 0),
        };
    },
  }
));
