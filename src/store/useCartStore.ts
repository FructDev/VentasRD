// src/store/useCartStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ProductoLocal, ClienteLocal } from '@/types/database';
import { v4 as uuidv4 } from 'uuid';

export interface CartItem extends ProductoLocal {
    cantidad: number;
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
}

export const MAX_EN_ESPERA = 10;

/** Devuelve el precio efectivo según el tier activo del cliente */
export function getPrecioEfectivo(producto: ProductoLocal, tier: 1 | 2 | 3): number {
    if (tier === 2 && producto.precio_2) return producto.precio_2;
    if (tier === 3 && producto.precio_3) return producto.precio_3;
    return producto.precio_venta;
}

interface CartState {
    items: CartItem[];
    subtotal: number;
    itbis: number;
    descuento: number;        // monto de descuento calculado
    total: number;

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
    let subtotal = 0;
    let itbis = 0;

    items.forEach(item => {
        const itemSubtotal = item.precio_venta * item.cantidad;
        subtotal += itemSubtotal;
        if (item.tasa_itbis) itbis += itemSubtotal * item.tasa_itbis;
    });

    const bruto = subtotal + itbis;
    let descuento = 0;
    if (valorDescuento > 0) {
        descuento = tipoDescuento === 'porcentaje'
            ? Math.min(bruto * (valorDescuento / 100), bruto)
            : Math.min(valorDescuento, bruto);
        descuento = Math.round(descuento * 100) / 100;
    }

    return { subtotal, itbis, descuento, total: Math.max(0, bruto - descuento) };
};

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
    items: [],
    subtotal: 0,
    itbis: 0,
    descuento: 0,
    total: 0,
    tipoDescuento: 'porcentaje',
    valorDescuento: 0,
    clienteActivoId: null,
    tipoPrecios: 1,
    enEspera: [],
    ventaEnCursoNumero: null,
    ventaEnCursoEtiqueta: null,

    addItem: (producto) => set((state) => {
        const tier = state.tipoPrecios;
        const precioEfectivo = getPrecioEfectivo(producto, tier);
        const productoConPrecio = { ...producto, precio_venta: precioEfectivo };
        const existingItem = state.items.find(item => item.id === producto.id && !item.serial_id);
        const newItems = existingItem
            ? state.items.map(item => (item.id === producto.id && !item.serial_id) ? { ...item, cantidad: item.cantidad + 1 } : item)
            : [...state.items, { ...productoConPrecio, cantidad: 1 }];
        return { items: newItems, ...calculateTotals(newItems, state.tipoDescuento, state.valorDescuento) };
    }),

    // Serializable: cada serial = línea independiente, qty siempre 1
    addItemConSerial: (producto, serialId, serialNumero) => set((state) => {
        const yaEnCarrito = state.items.some(i => i.serial_id === serialId);
        if (yaEnCarrito) return state;
        const precioEfectivo = getPrecioEfectivo(producto, state.tipoPrecios);
        const newItems = [...state.items, { ...producto, precio_venta: precioEfectivo, cantidad: 1, serial_id: serialId, serial_numero: serialNumero }];
        return { items: newItems, ...calculateTotals(newItems, state.tipoDescuento, state.valorDescuento) };
    }),

    removeItem: (id) => set((state) => {
        const newItems = state.items.filter(item => item.id !== id);
        return { items: newItems, ...calculateTotals(newItems, state.tipoDescuento, state.valorDescuento) };
    }),

    updateQuantity: (id, cantidad) => set((state) => {
        if (cantidad <= 0) {
            const newItems = state.items.filter(item => item.id !== id);
            return { items: newItems, ...calculateTotals(newItems, state.tipoDescuento, state.valorDescuento) };
        }
        const newItems = state.items.map(item => item.id === id ? { ...item, cantidad } : item);
        return { items: newItems, ...calculateTotals(newItems, state.tipoDescuento, state.valorDescuento) };
    }),

    setDescuento: (tipo, valor) => set((state) => ({
        tipoDescuento: tipo,
        valorDescuento: valor,
        ...calculateTotals(state.items, tipo, valor),
    })),

    setCliente: (clienteId, tier) => set((state) => {
        // Re-precifica todos los ítems existentes al nuevo tier
        const newItems = state.items.map(item => ({
            ...item,
            precio_venta: getPrecioEfectivo(item, tier),
        }));
        return {
            clienteActivoId: clienteId,
            tipoPrecios: tier,
            items: newItems,
            ...calculateTotals(newItems, state.tipoDescuento, state.valorDescuento),
        };
    }),

    clearCart: () => set({
        items: [], subtotal: 0, itbis: 0, descuento: 0, total: 0,
        tipoDescuento: 'porcentaje', valorDescuento: 0,
        clienteActivoId: null, tipoPrecios: 1,
        ventaEnCursoNumero: null, ventaEnCursoEtiqueta: null,
    }),

    pausarVenta: (etiqueta) => {
        const s = get();
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
            }],
            items: [], subtotal: 0, itbis: 0, descuento: 0, total: 0,
            tipoDescuento: 'porcentaje', valorDescuento: 0,
            clienteActivoId: null, tipoPrecios: 1,
            ventaEnCursoNumero: null, ventaEnCursoEtiqueta: null,
        });
        return true;
    },

    retomarVenta: (id, etiquetaCarritoActual) => {
        const s = get();
        const venta = s.enEspera.find(v => v.id === id);
        if (!venta) return;
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
            ...calculateTotals(venta.items, venta.tipoDescuento, venta.valorDescuento),
        });
    },

    descartarEnEspera: (id) => set(state => ({ enEspera: state.enEspera.filter(v => v.id !== id) })),
  }),
  {
    name: 'ventard-cart',
    partialize: (state) => ({
        items: state.items,
        clienteActivoId: state.clienteActivoId,
        tipoPrecios: state.tipoPrecios,
        enEspera: state.enEspera,
        ventaEnCursoNumero: state.ventaEnCursoNumero,
        ventaEnCursoEtiqueta: state.ventaEnCursoEtiqueta,
    }),
    merge: (persisted, current) => {
        const p = persisted as { items: CartItem[]; clienteActivoId?: string | null; tipoPrecios?: 1 | 2 | 3; enEspera?: VentaEnEspera[]; ventaEnCursoNumero?: number | null; ventaEnCursoEtiqueta?: string | null };
        const items = p.items ?? [];
        const tier = p.tipoPrecios ?? 1;
        return {
            ...current,
            items,
            clienteActivoId: p.clienteActivoId ?? null,
            tipoPrecios: tier,
            enEspera: p.enEspera ?? [],
            ventaEnCursoNumero: p.ventaEnCursoNumero ?? null,
            ventaEnCursoEtiqueta: p.ventaEnCursoEtiqueta ?? null,
            ...calculateTotals(items),
        };
    },
  }
));
