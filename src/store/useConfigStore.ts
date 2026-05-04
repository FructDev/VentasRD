import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '@supabase/supabase-js';

interface ConfigState {
    negocioId: string | null;
    negocioNombre: string | null;
    sucursalId: string | null;
    isOnline: boolean;
    user: User | null;
    pinAdmin: string | null;
    negocioWhatsapp: string | null;
    negocioRnc: string | null;
    negocioDireccion: string | null;
    negocioMensajeTicket: string | null;
    isAdminMode: boolean;
    isOfflineUnlocked: boolean;
    toast: { message: string, type: 'success' | 'error' | 'info' } | null;
    setConnection: (status: boolean) => void;
    setOfflineUnlock: (status: boolean) => void;
    setAuth: (user: User | null, negocioId?: string | null, negocioNombre?: string | null, pinAdmin?: string | null, whatsapp?: string | null, rnc?: string | null, direccion?: string | null, mensaje?: string | null) => void;
    setSucursal: (sucursalId: string | null) => void;
    setAdminMode: (status: boolean) => void;
    showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
    cerrarSesionUsuario: () => void;
    desconectarDispositivo: () => void;
}

export const useConfigStore = create<ConfigState>()(
    persist(
        (set) => ({
            negocioId: null,
            negocioNombre: null,
            sucursalId: null,
            isOnline: typeof window !== 'undefined' ? navigator.onLine : true,
            user: null,
            pinAdmin: null,
            negocioWhatsapp: null,
            negocioRnc: null,
            negocioDireccion: null,
            negocioMensajeTicket: null,
            isAdminMode: false,
            isOfflineUnlocked: false,
            toast: null,

            setConnection: (status) => set({ isOnline: status }),
            setOfflineUnlock: (status) => set({ isOfflineUnlocked: status }),
            setSucursal: (sucursalId) => set({ sucursalId }),
            setAdminMode: (status) => set({ isAdminMode: status }),
            showToast: (message, type = 'info') => {
                set({ toast: { message, type } });
                setTimeout(() => set({ toast: null }), 4000);
            },

            setAuth: (user, negocioId, negocioNombre, pinAdmin, whatsapp, rnc, direccion, mensaje) => set({
                user,
                negocioId: negocioId || null,
                negocioNombre: negocioNombre || null,
                pinAdmin: pinAdmin || null,
                negocioWhatsapp: whatsapp || null,
                negocioRnc: rnc || null,
                negocioDireccion: direccion || null,
                negocioMensajeTicket: mensaje || null
            }),

            // Cerrar sesión del usuario (no borra el negocio)
            cerrarSesionUsuario: () => set({
                user: null,
            }),

            // Desconectar el negocio del dispositivo (acción destructiva)
            desconectarDispositivo: () => set({
                user: null,
                negocioId: null,
                negocioNombre: null,
                sucursalId: null,
                pinAdmin: null,
                negocioWhatsapp: null,
                negocioRnc: null,
                negocioDireccion: null,
                negocioMensajeTicket: null,
                isAdminMode: false,
                isOfflineUnlocked: false,
            }),
        }),
        {
            name: 'ventard-config',
            partialize: (state) => ({
                negocioId: state.negocioId,
                negocioNombre: state.negocioNombre,
                sucursalId: state.sucursalId,
                pinAdmin: state.pinAdmin,
                negocioWhatsapp: state.negocioWhatsapp,
                negocioRnc: state.negocioRnc,
                negocioDireccion: state.negocioDireccion,
                negocioMensajeTicket: state.negocioMensajeTicket,
            }),
        }
    )
);