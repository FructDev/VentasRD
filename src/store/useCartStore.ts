// src/store/useCartStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ProductoLocal, ClienteLocal } from '@/types/database';

export interface CartItem extends ProductoLocal {
    cantidad: number;
    serial_id?: string;      // Solo si el producto es serializable
    serial_numero?: string;  // Número de serie seleccionado (para mostrar en ticket)
}

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

    addItem: (producto: ProductoLocal) => void;
    addItemConSerial: (producto: ProductoLocal, serialId: string, serialNumero: string) => void;
    removeItem: (id: string) => void;
    updateQuantity: (id: string, cantidad: number) => void;
    setDescuento: (tipo: 'porcentaje' | 'monto', valor: number) => void;
    setCliente: (clienteId: string | null, tier: 1 | 2 | 3) => void;
    clearCart: () => void;
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
    }),
  }),
  {
    name: 'ventard-cart',
    partialize: (state) => ({
        items: state.items,
        clienteActivoId: state.clienteActivoId,
        tipoPrecios: state.tipoPrecios,
    }),
    merge: (persisted, current) => {
        const p = persisted as { items: CartItem[]; clienteActivoId?: string | null; tipoPrecios?: 1 | 2 | 3 };
        const items = p.items ?? [];
        const tier = p.tipoPrecios ?? 1;
        return {
            ...current,
            items,
            clienteActivoId: p.clienteActivoId ?? null,
            tipoPrecios: tier,
            ...calculateTotals(items),
        };
    },
  }
));
