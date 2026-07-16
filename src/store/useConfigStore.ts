import { create, StateCreator } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '@supabase/supabase-js';
import { firmarAcceso } from '@/lib/firmaAcceso';

/** Bloque de números NCF reservado para este dispositivo (emisión offline segura) */
export interface NcfBloque {
    desde: number;
    hasta: number;
    proximo: number; // siguiente número de este bloque sin emitir
}

interface NcfConfig {
    habilitado: boolean;
    tipo: 'B02' | 'B01'; // B02 = consumidor final, B01 = crédito fiscal
    desde: number;       // Inicio del rango autorizado (espejo de la nube)
    hasta: number;       // Fin del rango autorizado
    actual: number;      // LEGADO: último emitido local (solo para sembrar la nube una vez)
    // Secuencia centralizada (Fase 2): la nube asigna bloques a cada dispositivo
    bloques: NcfBloque[];     // bloques reservados para esta caja
    proximoGlobal: number;    // siguiente sin asignar en la nube (informativo)
    sembrado: boolean;        // la config legada ya se migró a la nube
}

export const NCF_DEFAULT: NcfConfig = {
    habilitado: false, tipo: 'B02', desde: 1, hasta: 0, actual: 0,
    bloques: [], proximoGlobal: 0, sembrado: false,
};

export type RolUsuario = 'admin' | 'vendedor' | 'cajero';

export interface ImpresionConfig {
    anchoPapel: '80mm' | '58mm';   // Ancho del papel térmico
    tamanoLetra: 'normal' | 'grande';
    mostrarLogo: boolean;          // Imprimir el logo en el ticket
    autoImprimir: boolean;         // Imprimir automáticamente al confirmar la venta
    copias: 1 | 2;                 // Copias del ticket (cliente / negocio)
    densidad: 'normal' | 'compacta'; // Compacta ahorra papel
    // Impresión directa ESC/POS (sin diálogo del navegador)
    modoImpresion: 'navegador' | 'directa';
    tipoConexion: 'usb' | 'bluetooth' | 'serial';
    cortarPapel: boolean;          // Corte automático al final del ticket
    abrirGaveta: boolean;          // Abrir gaveta de dinero en ventas de contado
}

export const IMPRESION_DEFAULT: ImpresionConfig = {
    anchoPapel: '80mm',
    tamanoLetra: 'normal',
    mostrarLogo: true,
    autoImprimir: false,
    copias: 1,
    densidad: 'normal',
    modoImpresion: 'navegador',
    tipoConexion: 'usb',
    cortarPapel: true,
    abrirGaveta: false,
};

interface ConfigState {
    /** Código corto único de esta caja/dispositivo (ej: "C7K") — prefijo de los tickets */
    dispositivoId: string | null;
    /** Último número de ticket emitido por esta caja (sobrevive a la purga de datos viejos) */
    ultimoTicket: number;
    negocioId: string | null;
    negocioNombre: string | null;
    sucursalId: string | null;
    isOnline: boolean;
    user: User | null;
    pinAdmin: string | null;
    // Rol del usuario autenticado en este negocio
    rolUsuario: RolUsuario;
    nombreUsuario: string | null; // Nombre del empleado (si no es el dueño)
    negocioWhatsapp: string | null;
    negocioTelefono: string | null;
    negocioRnc: string | null;
    negocioDireccion: string | null;
    negocioMensajeTicket: string | null;
    negocioLogo: string | null; // Data URL del logo (imagen comprimida)
    isAdminMode: boolean;
    isOfflineUnlocked: boolean;
    toast: { message: string, type: 'success' | 'error' | 'info' } | null;
    // Plan / suscripcion
    planActivo: boolean;
    planTier: 'basico' | 'pro'; // 'pro' habilita módulos premium (reparaciones)
    trialHasta: number | null; // timestamp ms (legado)
    accesoHasta: number | null; // hasta cuándo es válido el acceso (trial o pago). Vence solo.
    ultimaFechaVista: number;   // marca de agua anti-retroceso de reloj (máx tiempo real visto)
    // Aperturas de la app sin contacto exitoso con el servidor. No depende del
    // reloj: cierra el truco de congelar la fecha del dispositivo para no vencer.
    aperturasSinServidor: number;
    registrarApertura: () => void;
    resetAperturasServidor: () => void;
    // NCF / Comprobantes Fiscales
    ncf: NcfConfig;
    // Ajustes de impresión (por dispositivo)
    impresion: ImpresionConfig;
    // Días de garantía por defecto para productos con número de serie (Plan Pro)
    garantiaDiasDefault: number;
    setGarantiaDiasDefault: (dias: number) => void;
    // Tema de la interfaz (por dispositivo)
    tema: 'oscuro' | 'claro';
    setTema: (tema: 'oscuro' | 'claro') => void;
    // Color de marca del negocio (clave de paleta). Viene de negocios, se cachea
    // localmente para aplicarlo sin parpadeo.
    colorMarca: string;
    setColorMarca: (clave: string) => void;
    // Fuente de marca (clave del catálogo). Cambia la tipografía de títulos/logo.
    fuenteMarca: string;
    setFuenteMarca: (clave: string) => void;
    // Datos de pago para el QR de transferencia (banco/cuenta/titular)
    datosPago: { banco: string; cuenta: string; titular: string } | null;
    setDatosPago: (d: { banco: string; cuenta: string; titular: string } | null) => void;
    // Catálogo público activado por el dueño (mini-tienda por link)
    catalogoPublico: boolean;
    setCatalogoPublico: (v: boolean) => void;
    // Reparaciones: si los repuestos se cobran aparte en la factura. Por defecto
    // false = la mano de obra ya incluye el repuesto (no se muestra su precio).
    cobrarRepuestosAparte: boolean;
    setCobrarRepuestosAparte: (v: boolean) => void;
    setImpresion: (config: Partial<ImpresionConfig>) => void;
    setConnection: (status: boolean) => void;
    setOfflineUnlock: (status: boolean) => void;
    setAuth: (user: User | null, negocioId?: string | null, negocioNombre?: string | null, pinAdmin?: string | null, whatsapp?: string | null, rnc?: string | null, direccion?: string | null, mensaje?: string | null, telefono?: string | null, logo?: string | null) => void;
    setLogo: (logo: string | null) => void;
    /** Actualiza solo el PIN admin sin tocar el resto del estado de auth */
    setPinAdmin: (pin: string | null) => void;
    setRol: (rol: RolUsuario, nombre?: string | null) => void;
    setPlan: (planActivo: boolean, trialHasta: number | null) => void;
    /** Fija el nivel de plan ('basico' | 'pro') traído de la nube */
    setPlanTier: (tier: 'basico' | 'pro') => void;
    /** Fija la fecha de acceso válido (trial o pago) traída de la nube */
    setAcceso: (accesoHasta: number | null) => void;
    /** Avanza la marca de agua de tiempo (anti-retroceso de reloj) */
    marcarTiempoVisto: () => void;
    setSucursal: (sucursalId: string | null) => void;
    setAdminMode: (status: boolean) => void;
    showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
    setNcfConfig: (config: Partial<NcfConfig>) => void;
    /** Consume el siguiente NCF disponible. Devuelve el string formateado o null si está deshabilitado/agotado. */
    consumirNcf: () => string | null;
    cerrarSesionUsuario: () => void;
    desconectarDispositivo: () => void;
}

const configCreator: StateCreator<ConfigState> = (set) => ({
            dispositivoId: null,
            ultimoTicket: 0,
            negocioId: null,
            negocioNombre: null,
            sucursalId: null,
            isOnline: typeof window !== 'undefined' ? navigator.onLine : true,
            user: null,
            pinAdmin: null,
            rolUsuario: 'admin',
            nombreUsuario: null,
            negocioWhatsapp: null,
            negocioTelefono: null,
            negocioRnc: null,
            negocioDireccion: null,
            negocioMensajeTicket: null,
            negocioLogo: null,
            isAdminMode: false,
            isOfflineUnlocked: false,
            toast: null,
            planActivo: false,
            planTier: 'basico',
            trialHasta: null,
            accesoHasta: null,
            ultimaFechaVista: 0,
            aperturasSinServidor: 0,
            ncf: NCF_DEFAULT,
            impresion: IMPRESION_DEFAULT,
            garantiaDiasDefault: 30,
            tema: 'oscuro',
            colorMarca: 'dorado',
            fuenteMarca: 'syne',
            catalogoPublico: false,
            datosPago: null,
            cobrarRepuestosAparte: false,

            setAcceso: (accesoHasta) => set({ accesoHasta }),
            marcarTiempoVisto: () => set(s => ({ ultimaFechaVista: Math.max(s.ultimaFechaVista, Date.now()) })),
            registrarApertura: () => set(s => ({ aperturasSinServidor: s.aperturasSinServidor + 1 })),
            resetAperturasServidor: () => set({ aperturasSinServidor: 0 }),

            setNcfConfig: (config) => set(state => ({ ncf: { ...state.ncf, ...config } })),
            setImpresion: (config) => set(state => ({ impresion: { ...state.impresion, ...config } })),
            setGarantiaDiasDefault: (dias) => set({ garantiaDiasDefault: Math.max(0, Math.floor(dias) || 0) }),
            setTema: (tema) => set({ tema }),
            setColorMarca: (colorMarca) => set({ colorMarca }),
            setFuenteMarca: (fuenteMarca) => set({ fuenteMarca }),
            setCatalogoPublico: (catalogoPublico) => set({ catalogoPublico }),
            setDatosPago: (datosPago) => set({ datosPago }),
            setCobrarRepuestosAparte: (v) => set({ cobrarRepuestosAparte: v }),

            consumirNcf: () => {
                const state = useConfigStore.getState();
                const { habilitado, tipo, desde, hasta, actual, bloques, sembrado } = state.ncf;
                if (!habilitado) return null;

                // Consumir del primer bloque reservado con números disponibles
                for (let i = 0; i < bloques.length; i++) {
                    const b = bloques[i];
                    if (b.proximo <= b.hasta) {
                        const num = b.proximo;
                        useConfigStore.setState(s => ({
                            ncf: {
                                ...s.ncf,
                                bloques: s.ncf.bloques
                                    .map((x, j) => j === i ? { ...x, proximo: x.proximo + 1 } : x)
                                    // descartar bloques ya agotados
                                    .filter(x => x.proximo <= x.hasta),
                            },
                        }));
                        return `${tipo}${String(num).padStart(8, '0')}`;
                    }
                }

                // LEGADO: dispositivo que aún no migró su secuencia a la nube
                // (sigue funcionando igual que antes hasta el primer sync online)
                if (!sembrado) {
                    const siguiente = actual === 0 ? desde : actual + 1;
                    if (siguiente > hasta) return null;
                    useConfigStore.setState(s => ({ ncf: { ...s.ncf, actual: siguiente } }));
                    return `${tipo}${String(siguiente).padStart(8, '0')}`;
                }

                return null; // sin bloques disponibles — requiere internet para reservar más
            },

            setRol: (rol, nombre) => set({ rolUsuario: rol, nombreUsuario: nombre ?? null }),
            setConnection: (status) => set({ isOnline: status }),
            setPlan: (planActivo, trialHasta) => set({ planActivo, trialHasta }),
            setPlanTier: (tier) => set({ planTier: tier }),
            setOfflineUnlock: (status) => set({ isOfflineUnlocked: status }),
            setSucursal: (sucursalId) => set({ sucursalId }),
            setAdminMode: (status) => set({ isAdminMode: status }),
            showToast: (message, type = 'info') => {
                set({ toast: { message, type } });
                setTimeout(() => set({ toast: null }), 4000);
            },

            setAuth: (user, negocioId, negocioNombre, pinAdmin, whatsapp, rnc, direccion, mensaje, telefono, logo) => set({
                user,
                negocioId: negocioId || null,
                negocioNombre: negocioNombre || null,
                pinAdmin: pinAdmin || null,
                negocioWhatsapp: whatsapp || null,
                negocioTelefono: telefono || null,
                negocioRnc: rnc || null,
                negocioDireccion: direccion || null,
                negocioMensajeTicket: mensaje || null,
                negocioLogo: logo || null
            }),

            setLogo: (logo) => set({ negocioLogo: logo }),
            setPinAdmin: (pin) => set({ pinAdmin: pin }),

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
                rolUsuario: 'admin',
                nombreUsuario: null,
                negocioWhatsapp: null,
                negocioTelefono: null,
                negocioRnc: null,
                negocioDireccion: null,
                negocioMensajeTicket: null,
                negocioLogo: null,
                isAdminMode: false,
                isOfflineUnlocked: false,
        }),
});

/**
 * Devuelve el código corto de esta caja, generándolo la primera vez.
 * Ej: "C7K" — se usa como prefijo de los tickets para que dos cajas
 * nunca generen el mismo número, incluso offline.
 */
export function getDispositivoId(): string {
    const actual = useConfigStore.getState().dispositivoId;
    if (actual) return actual;
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos (0/O, 1/I/L)
    let codigo = 'C';
    for (let i = 0; i < 2; i++) codigo += chars[Math.floor(Math.random() * chars.length)];
    useConfigStore.setState({ dispositivoId: codigo });
    return codigo;
}

export const useConfigStore = create<ConfigState>()(
    persist(configCreator, {
        name: 'ventard-config',
        partialize: (state) => ({
            dispositivoId: state.dispositivoId,
            ultimoTicket: state.ultimoTicket,
            negocioId: state.negocioId,
            negocioNombre: state.negocioNombre,
            sucursalId: state.sucursalId,
            pinAdmin: state.pinAdmin,
            rolUsuario: state.rolUsuario,
            nombreUsuario: state.nombreUsuario,
            negocioWhatsapp: state.negocioWhatsapp,
            negocioTelefono: state.negocioTelefono,
            negocioRnc: state.negocioRnc,
            negocioDireccion: state.negocioDireccion,
            negocioMensajeTicket: state.negocioMensajeTicket,
            negocioLogo: state.negocioLogo,
            planActivo: state.planActivo,
            planTier: state.planTier,
            trialHasta: state.trialHasta,
            accesoHasta: state.accesoHasta,
            ultimaFechaVista: state.ultimaFechaVista,
            aperturasSinServidor: state.aperturasSinServidor,
            // Firma de integridad de los campos de acceso (anti-edición manual)
            firmaAcc: firmarAcceso({
                negocioId: state.negocioId,
                accesoHasta: state.accesoHasta,
                trialHasta: state.trialHasta,
                planActivo: state.planActivo,
                ultimaFechaVista: state.ultimaFechaVista,
                aperturasSinServidor: state.aperturasSinServidor,
            }),
            ncf: state.ncf,
            impresion: state.impresion,
            garantiaDiasDefault: state.garantiaDiasDefault,
            tema: state.tema,
            colorMarca: state.colorMarca,
            fuenteMarca: state.fuenteMarca,
            catalogoPublico: state.catalogoPublico,
            datosPago: state.datosPago,
            cobrarRepuestosAparte: state.cobrarRepuestosAparte,
        }),
        merge: (persisted, current) => {
            const p = persisted as Partial<ConfigState> & { firmaAcc?: string };

            // Verificación de integridad: si los campos de acceso fueron editados a
            // mano (F12 → localStorage), la firma no cuadra → se anula el acceso
            // local y el dispositivo debe reconectarse para que el servidor (única
            // fuente de verdad) lo restaure. Si la firma no existe (config de una
            // versión anterior), se acepta una vez y se firma en el próximo guardado.
            let acceso: Partial<ConfigState> = {};
            if (p.firmaAcc !== undefined) {
                const esperada = firmarAcceso({
                    negocioId: p.negocioId ?? null,
                    accesoHasta: p.accesoHasta ?? null,
                    trialHasta: p.trialHasta ?? null,
                    planActivo: p.planActivo ?? false,
                    ultimaFechaVista: p.ultimaFechaVista ?? 0,
                    aperturasSinServidor: p.aperturasSinServidor ?? 0,
                });
                if (p.firmaAcc !== esperada) {
                    acceso = { planActivo: false, accesoHasta: null, trialHasta: null };
                }
            }

            return {
                ...current,
                ...p,
                ...acceso,
                // Mezclar con defaults por si se agregan campos nuevos (migración suave)
                impresion: { ...IMPRESION_DEFAULT, ...(p.impresion ?? {}) },
                ncf: { ...NCF_DEFAULT, ...(p.ncf ?? {}) },
            };
        },
    })
);