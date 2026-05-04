// src/store/useCartStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ProductoLocal } from '@/types/database';

// Extendemos el tipo producto para incluir la cantidad en el carrito
export interface CartItem extends ProductoLocal {
    cantidad: number;
}

interface CartState {
    items: CartItem[];
    subtotal: number;
    itbis: number;
    total: number;

    // Acciones
    addItem: (producto: ProductoLocal) => void;
    removeItem: (id: string) => void;
    updateQuantity: (id: string, cantidad: number) => void;
    clearCart: () => void;
}

// Función auxiliar para recalcular los totales al instante
const calculateTotals = (items: CartItem[]) => {
    let subtotal = 0;
    let itbis = 0;

    items.forEach(item => {
        const itemSubtotal = item.precio_venta * item.cantidad;
        subtotal += itemSubtotal;
        // Si el producto tiene tasa de impuesto (ej. 0.18), la sumamos
        if (item.tasa_itbis) {
            itbis += itemSubtotal * item.tasa_itbis;
        }
    });

    return {
        subtotal,
        itbis,
        total: subtotal + itbis
    };
};

export const useCartStore = create<CartState>()(
  persist(
    (set) => ({
    items: [],
    subtotal: 0,
    itbis: 0,
    total: 0,

    addItem: (producto) => set((state) => {
        const existingItem = state.items.find(item => item.id === producto.id);
        let newItems;

        if (existingItem) {
            // Si ya está en el carrito, solo aumentamos la cantidad
            newItems = state.items.map(item =>
                item.id === producto.id ? { ...item, cantidad: item.cantidad + 1 } : item
            );
        } else {
            // Si es nuevo, entra con cantidad 1
            newItems = [...state.items, { ...producto, cantidad: 1 }];
        }

        return { items: newItems, ...calculateTotals(newItems) };
    }),

    removeItem: (id) => set((state) => {
        const newItems = state.items.filter(item => item.id !== id);
        return { items: newItems, ...calculateTotals(newItems) };
    }),

    updateQuantity: (id, cantidad) => set((state) => {
        // Evitamos cantidades negativas o cero desde aquí
        if (cantidad <= 0) {
            const newItems = state.items.filter(item => item.id !== id);
            return { items: newItems, ...calculateTotals(newItems) };
        }

        const newItems = state.items.map(item =>
            item.id === id ? { ...item, cantidad } : item
        );
        return { items: newItems, ...calculateTotals(newItems) };
    }),

    clearCart: () => set({ items: [], subtotal: 0, itbis: 0, total: 0 }),
  }),
  {
    name: 'ventard-cart',
    // Solo persistir items; los totales se recalculan al rehidratar
    partialize: (state) => ({ items: state.items }),
    merge: (persisted, current) => {
        const items = (persisted as { items: CartItem[] }).items ?? [];
        return { ...current, items, ...calculateTotals(items) };
    },
  }
));