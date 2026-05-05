// src/store/useCartStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ProductoLocal } from '@/types/database';

export interface CartItem extends ProductoLocal {
    cantidad: number;
}

interface CartState {
    items: CartItem[];
    subtotal: number;
    itbis: number;
    descuento: number;        // monto de descuento calculado
    total: number;

    tipoDescuento: 'porcentaje' | 'monto';
    valorDescuento: number;   // valor que ingresó el usuario (% o RD$)

    addItem: (producto: ProductoLocal) => void;
    removeItem: (id: string) => void;
    updateQuantity: (id: string, cantidad: number) => void;
    setDescuento: (tipo: 'porcentaje' | 'monto', valor: number) => void;
    clearCart: () => void;
}

const calculateTotals = (
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

    addItem: (producto) => set((state) => {
        const existingItem = state.items.find(item => item.id === producto.id);
        const newItems = existingItem
            ? state.items.map(item => item.id === producto.id ? { ...item, cantidad: item.cantidad + 1 } : item)
            : [...state.items, { ...producto, cantidad: 1 }];
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

    clearCart: () => set({
        items: [], subtotal: 0, itbis: 0, descuento: 0, total: 0,
        tipoDescuento: 'porcentaje', valorDescuento: 0,
    }),
  }),
  {
    name: 'ventard-cart',
    partialize: (state) => ({ items: state.items }),
    merge: (persisted, current) => {
        const items = (persisted as { items: CartItem[] }).items ?? [];
        return { ...current, items, ...calculateTotals(items) };
    },
  }
));
