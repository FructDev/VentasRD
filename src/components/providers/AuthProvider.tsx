'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useConfigStore } from '@/store/useConfigStore';
import { useRouter, usePathname } from 'next/navigation';
import PinScreen from '@/components/ui/PinScreen';
import SubscriptionGate from '@/components/ui/SubscriptionGate';
import { puedeAcceder } from '@/lib/acceso';

const RUTAS_PUBLICAS = ['/login', '/registro', '/landing', '/offline', '/pin', '/recuperar-contrasena', '/actualizar-contrasena', '/superadmin', '/auth/confirm', '/onboarding', '/select-branch', '/unirse'];

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
                        // Empleados: respetar las rutas permitidas por su rol también offline
                        else if (currentState.nombreUsuario && !puedeAcceder(currentState.rolUsuario, pathname)) router.push('/');
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

                // 2A. Buscar si es el DUEÑO del negocio
                let { data: negocio, error } = await supabase
                    .from('negocios')
                    .select('id, nombre, onboarding_completado, pin_admin, whatsapp_dueno, telefono, rnc, direccion, mensaje_ticket, logo_url, plan_activo, trial_hasta, acceso_hasta')
                    .eq('dueño_id', user.id)
                    .maybeSingle();

                // 2B. Si no es dueño, buscar en usuarios_negocio (empleado)
                let empleado: { negocio_id: string; nombre: string; rol: string } | null = null;
                if (!negocio && !error) {
                    const { data: empData } = await supabase
                        .from('usuarios_negocio')
                        .select('negocio_id, nombre, rol')
                        .eq('user_id', user.id)
                        .eq('activo', true)
                        .maybeSingle();
                    if (empData) {
                        empleado = empData;
                        // Cargar el negocio del empleado
                        const { data: negEmp } = await supabase
                            .from('negocios')
                            .select('id, nombre, onboarding_completado, pin_admin, whatsapp_dueno, telefono, rnc, direccion, mensaje_ticket, logo_url, plan_activo, trial_hasta, acceso_hasta')
                            .eq('id', empData.negocio_id)
                            .single();
                        negocio = negEmp;
                    }
                }

                if (error) {
                    console.warn("No se pudo conectar a Supabase (posiblemente offline). Usando caché local.");
                    // FALLBACK OFFLINE
                    if (currentState.negocioId) {
                        negocio = {
                            id: currentState.negocioId,
                            nombre: currentState.negocioNombre,
                            pin_admin: currentState.pinAdmin,
                            whatsapp_dueno: currentState.negocioWhatsapp,
                            telefono: currentState.negocioTelefono,
                            rnc: currentState.negocioRnc,
                            direccion: currentState.negocioDireccion,
                            mensaje_ticket: currentState.negocioMensajeTicket,
                            logo_url: currentState.negocioLogo,
                            onboarding_completado: true,
                            plan_activo: currentState.planActivo,
                            trial_hasta: currentState.trialHasta,
                            acceso_hasta: currentState.accesoHasta,
                        };
                    } else {
                        throw error;
                    }
                }

                // 3. AUTO-SANACIÓN: Si no tiene negocio y no es empleado, crearlo
                if (!negocio && !empleado && !error) {
                    console.log("Creando negocio faltante...");
                    const trialHasta = Date.now() + 30 * 24 * 60 * 60 * 1000;
                    // Usar el nombre que el dueño escribió al registrarse (si el trigger no creó el negocio)
                    const nombreInicial = (user.user_metadata?.nombre_negocio as string) || 'Mi Negocio';
                    const { data: nuevoNegocio, error: insertError } = await supabase
                        .from('negocios')
                        .insert({ dueño_id: user.id, nombre: nombreInicial, pin_admin: '1234', plan_activo: false, trial_hasta: trialHasta })
                        .select('id, nombre, onboarding_completado, pin_admin, whatsapp_dueno, telefono, rnc, direccion, mensaje_ticket, logo_url, plan_activo, trial_hasta, acceso_hasta')
                        .single();

                    if (insertError) throw insertError;
                    negocio = nuevoNegocio;
                }

                // 3.B AUTO-TRIAL
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
                    negocio?.mensaje_ticket || null,
                    negocio?.telefono || null,
                    negocio?.logo_url || null
                );
                useConfigStore.getState().setPlan(
                    negocio?.plan_activo ?? false,
                    negocio?.trial_hasta ?? null,
                );
                // Fecha de acceso (trial o pago). Fallback al trial legado si la
                // columna aún no existe en negocios viejos.
                useConfigStore.getState().setAcceso(negocio?.acceso_hasta ?? negocio?.trial_hasta ?? null);
                // Estamos online y acabamos de hablar con el servidor: el reloj es
                // confiable → avanzar la marca de agua anti-retroceso de reloj.
                useConfigStore.getState().marcarTiempoVisto();
                // Establecer rol: empleado usa su rol asignado, dueño siempre es admin
                useConfigStore.getState().setRol(
                    empleado ? (empleado.rol as any) : 'admin',
                    empleado ? empleado.nombre : null
                );

                // Contexto para Sentry: identifica el negocio/rol en cada error
                // (sin datos personales de clientes finales)
                if (process.env.NEXT_PUBLIC_SENTRY_DSN && negocio) {
                    import('@sentry/nextjs').then(Sentry => {
                        Sentry.setTag('negocio_id', negocio!.id);
                        Sentry.setTag('rol', empleado ? empleado.rol : 'admin');
                    }).catch(() => { });
                }

                // 5. ENRUTADOR ESTRICTO
                if (negocio) {
                    const { sucursalId } = useConfigStore.getState();

                    if (!empleado && negocio.onboarding_completado === false && pathname !== '/onboarding') {
                        router.push('/onboarding');
                    } else if (negocio.onboarding_completado === true || empleado) {
                        if (pathname === '/login' || pathname === '/registro' || pathname === '/onboarding' || pathname === '/landing' || pathname === '/unirse') {
                            router.push('/');
                        }
                        // Todos (dueño y empleados) deben seleccionar sucursal para que el stock sincronice correctamente
                        if (!sucursalId && pathname !== '/select-branch' && !pathname.startsWith('/admin') && !pathname.startsWith('/superadmin')) {
                            router.push('/select-branch');
                        }
                        // Empleados: bloquear rutas fuera de su rol (la navegación las oculta,
                        // pero esto cubre el acceso directo por URL)
                        if (empleado && !rutasPublicas.includes(pathname) && !puedeAcceder(empleado.rol as any, pathname)) {
                            router.push('/');
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