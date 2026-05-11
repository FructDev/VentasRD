'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useConfigStore } from '@/store/useConfigStore';
import { useRouter, usePathname } from 'next/navigation';
import PinScreen from '@/components/ui/PinScreen';
import SubscriptionGate from '@/components/ui/SubscriptionGate';

const RUTAS_PUBLICAS = ['/login', '/registro', '/landing', '/offline', '/pin', '/recuperar-contrasena', '/actualizar-contrasena', '/superadmin', '/auth/confirm', '/onboarding', '/select-branch'];

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const [isReady, setIsReady] = useState(false);
    const [needsPin, setNeedsPin] = useState(false);

    useEffect(() => {
        let montado = true;

        const procesarUsuario = async (user: any) => {
            const rutasPublicas = RUTAS_PUBLICAS;
            const currentState = useConfigStore.getState();

            // SIN INTERNET — usar caché directamente
            if (!navigator.onLine) {
                if (currentState.negocioId) {
                    // El dispositivo conoce este negocio
                    // ¿Ya desbloqueó con el PIN en esta sesión offline? → dejar pasar
                    // ¿No ha desbloqueado? → pedir PIN siempre (ignorar si el dueño dejó la sesión web abierta)
                    if (!currentState.isOfflineUnlocked) {
                        setNeedsPin(true);
                    } else {
                        if (rutasPublicas.includes(pathname)) router.push('/');
                    }
                } else {
                    // Dispositivo nuevo sin datos → no puede hacer nada offline
                    if (!rutasPublicas.includes(pathname)) router.push('/login');
                }
                if (montado) setIsReady(true);
                return;
            }

            // CON INTERNET — flujo normal con Supabase
            if (!user) {
                useConfigStore.getState().cerrarSesionUsuario();
                if (!rutasPublicas.includes(pathname)) {
                    const isPWA = window.matchMedia('(display-mode: standalone)').matches || ('standalone' in window.navigator && (window.navigator as any).standalone);
                    router.push(isPWA ? '/login' : '/landing');
                }
                if (montado) setIsReady(true);
                return;
            }

            try {

                // 2. Buscar si el usuario tiene un negocio
                let { data: negocio, error } = await supabase
                    .from('negocios')
                    .select('id, nombre, onboarding_completado, pin_admin, whatsapp_dueno, rnc, direccion, mensaje_ticket, plan_activo, trial_hasta')
                    .eq('dueño_id', user.id)
                    .maybeSingle();

                if (error) {
                    console.warn("No se pudo conectar a Supabase (posiblemente offline). Usando caché local.");
                    // FALLBACK OFFLINE
                    if (currentState.negocioId) {
                        negocio = {
                            id: currentState.negocioId,
                            nombre: currentState.negocioNombre,
                            pin_admin: currentState.pinAdmin,
                            whatsapp_dueno: currentState.negocioWhatsapp,
                            rnc: currentState.negocioRnc,
                            direccion: currentState.negocioDireccion,
                            mensaje_ticket: currentState.negocioMensajeTicket,
                            onboarding_completado: true,
                            plan_activo: currentState.planActivo,
                            trial_hasta: currentState.trialHasta,
                        };
                    } else {
                        throw error;
                    }
                }

                // 3. AUTO-SANACIÓN: Si no tiene negocio, crearlo ahora
                if (!negocio && !error) {
                    console.log("Creando negocio faltante...");
                    const trialHasta = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 días
                    const { data: nuevoNegocio, error: insertError } = await supabase
                        .from('negocios')
                        .insert({ dueño_id: user.id, nombre: 'Mi Negocio', pin_admin: '1234', plan_activo: false, trial_hasta: trialHasta })
                        .select('id, nombre, onboarding_completado, pin_admin, whatsapp_dueno, rnc, direccion, mensaje_ticket, plan_activo, trial_hasta')
                        .single();

                    if (insertError) throw insertError;
                    negocio = nuevoNegocio;
                }

                // 3.B AUTO-TRIAL: Si el negocio existe pero no tiene trial ni plan activo
                // (puede pasar si un trigger de Supabase creó el negocio sin trial_hasta)
                if (negocio && !negocio.plan_activo && !negocio.trial_hasta) {
                    const trialHasta = Date.now() + 30 * 24 * 60 * 60 * 1000;
                    await supabase
                        .from('negocios')
                        .update({ trial_hasta: trialHasta })
                        .eq('id', negocio.id);
                    negocio = { ...negocio, trial_hasta: trialHasta };
                }

                // 4. Guardar en el estado global
                useConfigStore.getState().setAuth(
                    user,
                    negocio?.id || null,
                    negocio?.nombre || null,
                    negocio?.pin_admin || '1234',
                    negocio?.whatsapp_dueno || null,
                    negocio?.rnc || null,
                    negocio?.direccion || null,
                    negocio?.mensaje_ticket || null
                );
                useConfigStore.getState().setPlan(
                    negocio?.plan_activo ?? false,
                    negocio?.trial_hasta ?? null,
                );

                // 5. ENRUTADOR ESTRICTO
                if (negocio) {
                    const { sucursalId } = useConfigStore.getState();

                    if (negocio.onboarding_completado === false && pathname !== '/onboarding') {
                        router.push('/onboarding');
                    } else if (negocio.onboarding_completado === true) {
                        // Si el usuario intenta ir al login estando logueado, lo mandamos al inicio
                        if (pathname === '/login' || pathname === '/registro' || pathname === '/onboarding' || pathname === '/landing') {
                            router.push('/');
                        }
                        
                        // FASE 5: Control de Sucursal Físico
                        // Si no ha seleccionado sucursal, lo obligamos a menos que esté en el dashboard admin o ya eligiendo
                        if (!sucursalId && pathname !== '/select-branch' && !pathname.startsWith('/admin') && !pathname.startsWith('/superadmin')) {
                            router.push('/select-branch');
                        }
                    }
                }
            } catch (error) {
                console.error("Error en AuthProvider:", error);
            } finally {
                // Solo mostramos la app cuando todo este proceso haya terminado
                if (montado) setIsReady(true);
            }
        };

        // Revisar la sesión al entrar a la página
        supabase.auth.getSession().then(({ data: { session } }) => {
            procesarUsuario(session?.user);
        });

        // Escuchar si el usuario inicia sesión o se sale
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            procesarUsuario(session?.user);
        });

        return () => {
            montado = false;
            subscription.unsubscribe();
        };
    }, [pathname, router]);

    // Pantalla de carga mientras piensa a dónde enviarte
    if (!isReady) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-navy">
                <div className="animate-pulse flex flex-col items-center">
                    <div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin mb-4"></div>
                    <p className="text-vr-gray font-medium">Iniciando VentaRD...</p>
                </div>
            </div>
        );
    }

    if (needsPin) {
        // Envolvemos PinScreen para que al tener éxito limpie el estado y deje ver los children
        return <div className="fixed inset-0 z-[99999] bg-navy"><PinScreen onUnlock={() => setNeedsPin(false)} /></div>;
    }

    // En rutas públicas no aplicar el gate de suscripcion
    const esRutaPublica = RUTAS_PUBLICAS.some(r => pathname.startsWith(r));
    if (esRutaPublica) return <>{children}</>;

    return <SubscriptionGate>{children}</SubscriptionGate>;
}