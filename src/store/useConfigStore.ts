import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '@supabase/supabase-js';

interface NcfConfig {
    habilitado: boolean;
    tipo: 'B02' | 'B01'; // B02 = consumidor final, B01 = crédito fiscal
    desde: number;       // Inicio del rango autorizado
    hasta: number;       // Fin del rango autorizado
    actual: number;      // Último número emitido (0 = ninguno aún)
}

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
    // Plan / suscripcion
    planActivo: boolean;
    trialHasta: number | null; // timestamp ms
    // NCF / Comprobantes Fiscales
    ncf: NcfConfig;
    setConnection: (status: boolean) => void;
    setOfflineUnlock: (status: boolean) => void;
    setAuth: (user: User | null, negocioId?: string | null, negocioNombre?: string | null, pinAdmin?: string | null, whatsapp?: string | null, rnc?: string | null, direccion?: string | null, mensaje?: string | null) => void;
    setPlan: (planActivo: boolean, trialHasta: number | null) => void;
    setSucursal: (sucursalId: string | null) => void;
    setAdminMode: (status: boolean) => void;
    showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
    setNcfConfig: (config: Partial<NcfConfig>) => void;
    /** Consume el siguiente NCF disponible. Devuelve el string formateado o null si está deshabilitado/agotado. */
    consumirNcf: () => string | null;
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
            planActivo: false,
            trialHasta: null,
            ncf: { habilitado: false, tipo: 'B02', desde: 1, hasta: 0, actual: 0 },

            setNcfConfig: (config) => set(state => ({ ncf: { ...state.ncf, ...config } })),

            consumirNcf: () => {
                const state = useConfigStore.getState();
                const { habilitado, tipo, desde, hasta, actual } = state.ncf;
                if (!habilitado) return null;
                const siguiente = actual === 0 ? desde : actual + 1;
                if (siguiente > hasta) return null; // rango agotado
                useConfigStore.setState(s => ({ ncf: { ...s.ncf, actual: siguiente } }));
                return `${tipo}${String(siguiente).padStart(8, '0')}`;
            },

            setConnection: (status) => set({ isOnline: status }),
            setPlan: (planActivo, trialHasta) => set({ planActivo, trialHasta }),
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
                planActivo: state.planActivo,
                trialHasta: state.trialHasta,
                ncf: state.ncf,
            }),
        }
    )
);