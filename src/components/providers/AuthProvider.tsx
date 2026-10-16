'use client';

import { useEffect, useRef, useState } from 'react';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase/client';
import { useConfigStore, type RolUsuario } from '@/store/useConfigStore';
import { useRouter, usePathname } from 'next/navigation';
import PinScreen from '@/components/ui/PinScreen';
import SubscriptionGate from '@/components/ui/SubscriptionGate';
import { puedeAcceder } from '@/lib/acceso';
import { hayServidor } from '@/lib/red';
import { iniciarMedicion, registrarMetrica, type ResultadoMetrica } from '@/lib/rendimiento';
import { canUseCachedBusiness, canUseOfflineBusiness } from '@/lib/auth/cached-identity';
import { resolveStartupSession } from '@/lib/auth/startup';
import { validateCachedBranch } from '@/lib/auth/cached-branch';
import { db } from '@/lib/db/dexie';

// Una red 'conectada pero muerta' (WiFi sin internet) deja navigator.onLine
// en true y las peticiones colgadas por 30-60s — el arranque se eternizaba.
// Timeout corto: si Supabase no responde rápido, caemos al caché local.
function conTimeout<T>(p: PromiseLike<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([
        Promise.resolve(p),
        new Promise<T>(res => setTimeout(() => res(fallback), ms)),
    ]);
}

const RUTAS_PUBLICAS = ['/login', '/registro', '/landing', '/offline', '/pin', '/recuperar-contrasena', '/actualizar-contrasena', '/superadmin', '/auth/confirm', '/onboarding', '/select-branch', '/unirse', '/catalogo', '/terminos', '/privacidad', '/ayuda', '/pagar'];

function rolSeguro(rol: string): RolUsuario {
    return rol === 'admin' || rol === 'vendedor' || rol === 'cajero' ? rol : 'cajero';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const pathnameRef = useRef(pathname);
    const [isReady, setIsReady] = useState(false);
    const [needsPin, setNeedsPin] = useState(false);
    const [cachedIdentityDenied, setCachedIdentityDenied] = useState(false);

    useEffect(() => {
        pathnameRef.current = pathname;
    }, [pathname]);

    useEffect(() => {
        let montado = true;
        const authCallbacks = new Set<ReturnType<typeof setTimeout>>();
        // Candado de concurrencia: los eventos de auth (INITIAL_SESSION, SIGNED_IN,
        // TOKEN_REFRESHED) disparan en ráfaga. Dos ejecuciones simultáneas de
        // procesarUsuario llegaban a la auto-sanación a la vez y creaban negocios
        // DUPLICADOS para el mismo dueño (raíz de los logins erráticos).
        // IMPORTANTE: el evento que llega durante una ejecución NO se descarta —
        // se guarda y se procesa al terminar (descartar el SIGNED_IN del registro
        // dejaba al usuario sin negocioId y el onboarding con el botón muerto).
        let procesando = false;
        let usuarioEnProceso: string | null | undefined;
        let offlineEnProceso = false;
        let pendiente: { user: SupabaseUser | null | undefined; forzarOffline: boolean } | null = null;

        const procesarUsuario = async (user: SupabaseUser | null | undefined, forzarOffline = false) => {
            if (!montado) return;
            if (procesando) {
                // getSession e INITIAL_SESSION pueden informar exactamente la misma
                // sesión durante el arranque. No repetir todas las consultas por un
                // evento equivalente; sí conservar un login/logout realmente nuevo.
                if (usuarioEnProceso === user?.id && offlineEnProceso === forzarOffline) return;
                pendiente = { user, forzarOffline };
                return;
            }
            procesando = true;
            usuarioEnProceso = user?.id;
            offlineEnProceso = forzarOffline;
            try {
                await procesarUsuarioInterno(user, forzarOffline);
                // Procesar el último evento que llegó mientras trabajábamos
                while (pendiente && montado) {
                    const siguiente = pendiente;
                    pendiente = null;
                    usuarioEnProceso = siguiente.user?.id;
                    offlineEnProceso = siguiente.forzarOffline;
                    await procesarUsuarioInterno(siguiente.user, siguiente.forzarOffline);
                }
            } finally {
                procesando = false;
                usuarioEnProceso = undefined;
                offlineEnProceso = false;
            }
        };

        const procesarUsuarioInterno = async (user: SupabaseUser | null | undefined, forzarOffline = false) => {
            const inicioProceso = performance.now();
            const finalizarArranque = iniciarMedicion();
            const rutaActual = pathnameRef.current;
            const rutasPublicas = RUTAS_PUBLICAS;
            // Coincidencia por prefijo: cubre rutas con parámetros como /catalogo/:id
            const esPublica = (p: string) => rutasPublicas.some(r => p === r || p.startsWith(r + '/'));
            // Repair only an incompatible *selection*, never cached business
            // data. This also catches configurations persisted before the fix.
            // No network query: a valid legacy offline cache stays usable.
            await validateCachedBranch({
                getScope: () => useConfigStore.getState(),
                readBranch: id => db.sucursales.get(id),
                invalidate: () => useConfigStore.getState().setSucursal(null),
            });
            if (!montado) return;
            const currentState = useConfigStore.getState();

            // Nunca se usa el cache de otro usuario ni uno sin identidad historica.
            const identidadCacheValida = canUseCachedBusiness({
                sessionUserId: user?.id,
                cachedUserId: currentState.usuarioCacheId,
                businessId: currentState.negocioId,
            });

            // SIN INTERNET — usar caché directamente.
            // Comprobamos el servidor de verdad: con el router muerto (se fue la
            // luz) navigator.onLine sigue en true y antes caíamos al camino online,
            // que terminaba expulsando al cajero a /login sin poder autenticarse.
            const inicioRed = performance.now();
            const servidorAlcanzable = forzarOffline ? false : await hayServidor();
            registrarMetrica('arranque.comprobar_servidor', performance.now() - inicioRed, 'ok', { alcanzable: servidorAlcanzable });
            // Con servidor alcanzable y la MISMA identidad ya validada, Dexie
            // puede pintar de inmediato. La actualizacion remota de negocio,
            // plan y rol continua debajo sin bloquear la interfaz.
            if (servidorAlcanzable && identidadCacheValida) {
                if (montado) setIsReady(true);
                registrarMetrica('arranque.cache_local_visible', performance.now() - inicioProceso, 'ok');
            }
            if (!servidorAlcanzable) {
                if (canUseOfflineBusiness({ sessionUserId: user?.id, cachedUserId: currentState.usuarioCacheId, businessId: currentState.negocioId })) {
                    if (montado) setCachedIdentityDenied(false);
                    // El dispositivo conoce este negocio
                    // ¿Ya desbloqueó con el PIN en esta sesión offline? → dejar pasar
                    // ¿No ha desbloqueado? → pedir PIN siempre (ignorar si el dueño dejó la sesión web abierta)
                    if (!currentState.isOfflineUnlocked) {
                        setNeedsPin(true);
                    } else {
                        if (rutasPublicas.includes(rutaActual)) router.push('/');
                        // Empleados: respetar las rutas permitidas por su rol también offline
                        else if (currentState.nombreUsuario && !puedeAcceder(currentState.rolUsuario, rutaActual)) router.push('/');
                    }
                } else {
                    // Dispositivo nuevo sin datos → no puede hacer nada offline
                    if (!esPublica(rutaActual)) router.push('/login');
                    // Preserve local data, but never expose an ambiguous cached tenant.
                    if (montado) { setCachedIdentityDenied(true); setIsReady(true); }
                    finalizarArranque('arranque.autenticacion', 'error', { modo: 'offline-identidad-no-verificada' });
                    return;
                }
                if (montado) setIsReady(true);
                finalizarArranque('arranque.autenticacion', 'ok', { modo: 'offline-cache' });
                return;
            }

            // CON INTERNET — flujo normal con Supabase
            if (!user) {
                if (montado) setCachedIdentityDenied(false);
                useConfigStore.getState().cerrarSesionUsuario();
                if (!esPublica(rutaActual)) {
                    const navigatorPwa = window.navigator as Navigator & { standalone?: boolean };
                    const isPWA = window.matchMedia('(display-mode: standalone)').matches || navigatorPwa.standalone === true;
                    router.push(isPWA ? '/login' : '/landing');
                }
                if (montado) setIsReady(true);
                finalizarArranque('arranque.autenticacion', 'ok', { modo: 'sin-sesion' });
                return;
            }

            let resultadoArranque: ResultadoMetrica = 'ok';
            try {

                // 2A. Buscar si es el DUEÑO del negocio.
                // limit(1) + prioridad al onboarding completado: si el dueño quedó
                // con negocios duplicados (bug histórico), maybeSingle() a secas
                // lanzaba error con >1 fila y el login entraba en bucle.
                const { data: negocioDueno, error } = await conTimeout(
                    supabase
                        .from('negocios')
                        .select('id, nombre, onboarding_completado, pin_admin, whatsapp_dueno, telefono, rnc, direccion, mensaje_ticket, logo_url, plan_activo, plan_tier, color_marca, fuente_marca, catalogo_publico, banco_nombre, banco_cuenta, banco_titular, trial_hasta, acceso_hasta')
                        .eq('dueño_id', user.id)
                        .order('onboarding_completado', { ascending: false })
                        .limit(1)
                        .maybeSingle(),
                    5000,
                    // Red muerta: tratar como error → cae al fallback del caché local
                    { data: null, error: { message: 'timeout_red_muerta' } } as never
                );
                let negocio = negocioDueno;

                // 2B. Si no es dueño, buscar en usuarios_negocio (empleado)
                let empleado: { negocio_id: string; nombre: string; rol: string } | null = null;
                if (!negocio && !error) {
                    const { data: empData } = await supabase
                        .from('usuarios_negocio')
                        .select('negocio_id, nombre, rol')
                        .eq('user_id', user.id)
                        .eq('activo', true)
                        .limit(1)
                        .maybeSingle();
                    if (empData) {
                        empleado = empData;
                        // Cargar el negocio del empleado
                        const { data: negEmp } = await supabase
                            .from('negocios')
                            .select('id, nombre, onboarding_completado, pin_admin, whatsapp_dueno, telefono, rnc, direccion, mensaje_ticket, logo_url, plan_activo, plan_tier, color_marca, fuente_marca, catalogo_publico, banco_nombre, banco_cuenta, banco_titular, trial_hasta, acceso_hasta')
                            .eq('id', empData.negocio_id)
                            .single();
                        negocio = negEmp;
                    }
                }

                if (error) {
                    console.warn("No se pudo conectar a Supabase (posiblemente offline). Usando caché local.");
                    // FALLBACK OFFLINE
                    if (identidadCacheValida) {
                        if (montado && !currentState.isOfflineUnlocked) setNeedsPin(true);
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
                            plan_tier: currentState.planTier,
                            color_marca: currentState.colorMarca,
                            fuente_marca: currentState.fuenteMarca,
                            catalogo_publico: currentState.catalogoPublico,
                            banco_nombre: currentState.datosPago?.banco ?? null,
                            banco_cuenta: currentState.datosPago?.cuenta ?? null,
                            banco_titular: currentState.datosPago?.titular ?? null,
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
                        .select('id, nombre, onboarding_completado, pin_admin, whatsapp_dueno, telefono, rnc, direccion, mensaje_ticket, logo_url, plan_activo, plan_tier, color_marca, fuente_marca, catalogo_publico, banco_nombre, banco_cuenta, banco_titular, trial_hasta, acceso_hasta')
                        .single();

                    if (insertError) {
                        // Otra ejecución/pestaña lo creó primero (o el índice único lo
                        // bloqueó): re-consultar en vez de fallar.
                        const { data: reintento } = await supabase
                            .from('negocios')
                            .select('id, nombre, onboarding_completado, pin_admin, whatsapp_dueno, telefono, rnc, direccion, mensaje_ticket, logo_url, plan_activo, plan_tier, color_marca, fuente_marca, catalogo_publico, banco_nombre, banco_cuenta, banco_titular, trial_hasta, acceso_hasta')
                            .eq('dueño_id', user.id)
                            .order('onboarding_completado', { ascending: false })
                            .limit(1)
                            .maybeSingle();
                        if (!reintento) throw insertError;
                        negocio = reintento;
                    } else {
                        negocio = nuevoNegocio;
                    }
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
                if (montado) setCachedIdentityDenied(false);
                useConfigStore.getState().setPlan(
                    negocio?.plan_activo ?? false,
                    negocio?.trial_hasta ?? null,
                );
                // Nivel de plan: 'pro' habilita el módulo de reparaciones.
                // Si la fecha viene del servidor lo fijamos; si es el fallback offline
                // (sin plan_tier) NO se toca, para no perder el "pro" sin conexión.
                const tier = (negocio as { plan_tier?: string } | null)?.plan_tier;
                if (tier === 'pro' || tier === 'basico') {
                    useConfigStore.getState().setPlanTier(tier);
                }
                // Color de marca del negocio (personalización). Si no viene (fallback
                // offline), se conserva el cacheado.
                const marca = (negocio as { color_marca?: string } | null)?.color_marca;
                if (marca) useConfigStore.getState().setColorMarca(marca);
                const fuente = (negocio as { fuente_marca?: string } | null)?.fuente_marca;
                if (fuente) useConfigStore.getState().setFuenteMarca(fuente);
                const catPub = (negocio as { catalogo_publico?: boolean } | null)?.catalogo_publico;
                useConfigStore.getState().setCatalogoPublico(catPub === true);
                // Datos de pago para el QR de transferencia
                const nb = negocio as { banco_nombre?: string | null; banco_cuenta?: string | null; banco_titular?: string | null } | null;
                useConfigStore.getState().setDatosPago(
                    nb?.banco_cuenta ? { banco: nb.banco_nombre || '', cuenta: nb.banco_cuenta, titular: nb.banco_titular || '' } : null
                );
                // Fecha de acceso (trial o pago). Fallback al trial legado si la
                // columna aún no existe en negocios viejos.
                useConfigStore.getState().setAcceso(negocio?.acceso_hasta ?? negocio?.trial_hasta ?? null);
                // Estamos online y acabamos de hablar con el servidor: el reloj es
                // confiable → avanzar la marca de agua anti-retroceso de reloj y
                // resetear el contador de aperturas sin servidor.
                if (!error) {
                    useConfigStore.getState().marcarTiempoVisto();
                    useConfigStore.getState().resetAperturasServidor();
                    useConfigStore.getState().registrarConexionExitosa();
                } else {
                    useConfigStore.getState().marcarTiempoVisto();
                }
                // Establecer rol: empleado usa su rol asignado, dueño siempre es admin.
                // OJO: solo cuando el servidor confirmó quién es. En el fallback
                // offline `empleado` siempre viene null, y asignar 'admin' ahí
                // convertía a un cajero en administrador con solo abrir la app sin
                // señal. Sin confirmación del servidor se conserva el rol cacheado.
                if (empleado) {
                    useConfigStore.getState().setRol(rolSeguro(empleado.rol), empleado.nombre);
                } else if (!error) {
                    useConfigStore.getState().setRol('admin', null);
                }

                // Contexto para Sentry: identifica el negocio/rol en cada error
                // (sin datos personales de clientes finales)
                if (process.env.NEXT_PUBLIC_SENTRY_DSN && negocio) {
                    import('@sentry/nextjs').then(Sentry => {
                        Sentry.setTag('negocio_id', negocio!.id);
                        Sentry.setTag('rol', empleado ? empleado.rol : 'admin');
                    }).catch(() => { });
                }

                // 5. ENRUTADOR ESTRICTO
                // Mientras el usuario está restableciendo su contraseña (llegó por el
                // enlace de recuperación), NO redirigir a ningún lado: debe poder
                // completar el cambio aunque la sesión ya esté activa.
                const enRecuperacion = rutaActual.startsWith('/actualizar-contrasena') || rutaActual.startsWith('/recuperar-contrasena');
                // El catálogo es una vista pública: no aplicar el enrutador estricto
                // (evita rebotar al dueño a /select-branch cuando abre su propio link).
                if (negocio && !enRecuperacion && !rutaActual.startsWith('/catalogo')) {
                    const { sucursalId } = useConfigStore.getState();

                    if (!empleado && negocio.onboarding_completado === false && rutaActual !== '/onboarding') {
                        router.push('/onboarding');
                    } else if (negocio.onboarding_completado === true || empleado) {
                        if (rutaActual === '/login' || rutaActual === '/registro' || rutaActual === '/onboarding' || rutaActual === '/landing' || rutaActual === '/unirse') {
                            router.push('/');
                        }
                        // Todos (dueño y empleados) deben seleccionar sucursal para que el stock sincronice correctamente
                        if (!sucursalId && rutaActual !== '/select-branch' && !rutaActual.startsWith('/admin') && !rutaActual.startsWith('/superadmin')) {
                            router.push('/select-branch');
                        }
                        // Empleados: bloquear rutas fuera de su rol (la navegación las oculta,
                        // pero esto cubre el acceso directo por URL)
                        if (empleado && !rutasPublicas.includes(rutaActual) && !puedeAcceder(rolSeguro(empleado.rol), rutaActual)) {
                            router.push('/');
                        }
                    }
                }
            } catch (error) {
                resultadoArranque = 'error';
                console.error("Error en AuthProvider:", error);
                if (!identidadCacheValida) {
                    if (montado) setCachedIdentityDenied(true);
                    if (!esPublica(rutaActual)) router.push('/login');
                }
            } finally {
                finalizarArranque('arranque.autenticacion', resultadoArranque, { modo: 'online' });
                // Solo mostramos la app cuando todo este proceso haya terminado
                if (montado) setIsReady(true);
            }
        };

        // Revisar la sesión al entrar a la página.
        // getSession() intenta refrescar el token si expiró — y a las 7 de la
        // mañana SIEMPRE expiró. Con el router muerto esa petición se cuelga y
        // el arranque nunca termina. Con timeout: si no responde, arrancamos por
        // el camino offline en vez de quedarnos en "Iniciando VentaRD…".
        resolveStartupSession<SupabaseUser>({
            probe: () => hayServidor(1200),
            getSession: () => supabase.auth.getSession().then(({ data: { session } }) => session?.user),
        }).then(({ offline, user }) => {
            // Si getSession no respondió no sabemos si hay sesión: NO expulsar al
            // login. Forzamos el camino offline, que pide PIN y deja trabajar.
            void procesarUsuario(user, offline);
        });

        // Escuchar si el usuario inicia sesión o se sale
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            // La sesión inicial ya la obtiene getSession con timeout y fallback
            // offline. Procesarla también aquí duplicaba todas las consultas.
            if (event === 'INITIAL_SESSION') return;
            // Supabase auth holds its lock during callbacks. Never await remote
            // queries under that lock; defer work, and fence it on unmount.
            const handle = setTimeout(() => {
                authCallbacks.delete(handle);
                if (montado) void procesarUsuario(session?.user);
            }, 0);
            authCallbacks.add(handle);
        });

        return () => {
            montado = false;
            for (const handle of authCallbacks) clearTimeout(handle);
            subscription.unsubscribe();
        };
    }, [router]);

    // La autorización de navegación usa únicamente el estado local ya validado.
    // Cambiar de módulo nunca debe volver a consultar sesión, negocio ni plan.
    useEffect(() => {
        if (!isReady || needsPin) return;

        const esPublica = RUTAS_PUBLICAS.some(r => pathname === r || pathname.startsWith(r + '/'));
        if (cachedIdentityDenied) {
            if (!esPublica) router.push('/login');
            return;
        }
        const state = useConfigStore.getState();
        const enRecuperacion = pathname.startsWith('/actualizar-contrasena') || pathname.startsWith('/recuperar-contrasena');
        if (enRecuperacion || pathname.startsWith('/catalogo')) return;

        if (!state.negocioId) {
            if (!esPublica) router.push('/login');
            return;
        }

        if (state.user && ['/login', '/registro', '/onboarding', '/landing', '/unirse'].includes(pathname)) {
            router.push('/');
            return;
        }

        if (!state.sucursalId && pathname !== '/select-branch' && !pathname.startsWith('/admin') && !pathname.startsWith('/superadmin')) {
            router.push('/select-branch');
            return;
        }

        const esEmpleado = state.rolUsuario !== 'admin';
        if (esEmpleado && !esPublica && !puedeAcceder(state.rolUsuario, pathname)) {
            router.push('/');
        }
    }, [isReady, needsPin, cachedIdentityDenied, pathname, router]);

    // Pantalla de carga mientras piensa a dónde enviarte
    if (!isReady || cachedIdentityDenied && !RUTAS_PUBLICAS.some(r => pathname === r || pathname.startsWith(r + '/'))) {
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
