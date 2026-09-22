'use client';

import React from 'react';
import { CLAVE_PRECARGA_TS } from '@/lib/precarga';

// Cada deploy cambia el hash de todos los chunks de JavaScript y Vercel borra
// los del build anterior. El service worker sirve el HTML desde cache al
// instante (eso es lo que hace que la app abra sin internet), así que la
// primera apertura después de un deploy carga el shell VIEJO, que pide chunks
// que ya no existen: 404 y "Algo salió mal" con la app aparentemente al día.
//
// La única cura es botar ese HTML viejo y recargar una vez. Hace falta internet
// para bajar el build nuevo, así que sin señal no recargamos a ciegas: eso
// dejaría al colmado con una pantalla en blanco en medio del turno.
const ES_ERROR_DE_CHUNK =
    /ChunkLoadError|Loading (?:CSS )?chunk .+ failed|(?:Failed to fetch|error loading) dynamically imported module|Importing a module script failed/i;

const CLAVE_RECUPERACION = 'vrd_recuperacion_chunk';
const ESPERA_MS = 60_000; // dos recargas seguidas serían un bucle

/** Nombre del cache de páginas del service worker (ver next.config.ts). */
const CACHE_PAGINAS = 'ventard-pages';

function esErrorDeChunk(error: Error | null): boolean {
    if (!error) return false;
    // webpack lo nombra ChunkLoadError; los navegadores traen su propio texto.
    return error.name === 'ChunkLoadError' || ES_ERROR_DE_CHUNK.test(error.message || '');
}

/** ¿Vale la pena recargar? Solo con señal y si no acabamos de intentarlo. */
function puedeRecargar(): boolean {
    if (typeof window === 'undefined' || !navigator.onLine) return false;
    try {
        const ultimo = Number(sessionStorage.getItem(CLAVE_RECUPERACION) || 0);
        return Date.now() - ultimo > ESPERA_MS;
    } catch {
        return false; // sin dónde anotar el intento, no arriesgamos el bucle
    }
}

async function recargarConElBuildNuevo(): Promise<void> {
    try {
        sessionStorage.setItem(CLAVE_RECUPERACION, String(Date.now()));
        // Aquí vive el HTML viejo: sin borrarlo la recarga sirve lo mismo otra
        // vez. Buscamos por nombre para no depender del prefijo de workbox.
        const nombres = await caches.keys();
        await Promise.all(
            nombres.filter(n => n.includes(CACHE_PAGINAS)).map(n => caches.delete(n))
        );
        // Que la precarga vuelva a bajar las pantallas hoy mismo, ya con el
        // build nuevo, en vez de esperar a que venza su marca de 24 horas.
        localStorage.removeItem(CLAVE_PRECARGA_TS);
        const reg = await navigator.serviceWorker?.getRegistration();
        await reg?.update();
    } catch {
        // Si algo de esto falla, recargar sigue siendo la mejor jugada.
    }
    window.location.reload();
}

const ESTILO_PANTALLA: React.CSSProperties = {
    minHeight: '100vh',
    background: '#0D1B2E',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    fontFamily: 'sans-serif',
    textAlign: 'center',
};

const ESTILO_BOTON: React.CSSProperties = {
    background: '#D4A017',
    color: '#0D1B2E',
    border: 'none',
    borderRadius: 12,
    padding: '12px 28px',
    fontSize: 15,
    fontWeight: 800,
    cursor: 'pointer',
};

const ESTILO_BOTON_SECUNDARIO: React.CSSProperties = {
    ...ESTILO_BOTON,
    background: 'transparent',
    color: '#8899AA',
    border: '1px solid rgba(136,153,170,0.3)',
};

interface Props {
    children: React.ReactNode;
    fallback?: React.ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
    actualizando: boolean;
}

export class ErrorBoundary extends React.Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null, actualizando: false };
    }

    static getDerivedStateFromError(error: Error): State {
        return {
            hasError: true,
            error,
            actualizando: esErrorDeChunk(error) && puedeRecargar(),
        };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error('[ErrorBoundary] Error no capturado:', error, info.componentStack);
        if (this.state.actualizando) void recargarConElBuildNuevo();
    }

    // Reintento a mano: el usuario ya se conectó, así que saltamos la espera
    // que evita bucles automáticos y vamos directo por el build nuevo.
    handleRetry = () => {
        this.setState({ actualizando: true });
        void recargarConElBuildNuevo();
    };

    handleReset = () => {
        this.setState({ hasError: false, error: null, actualizando: false });
        window.location.href = '/';
    };

    render() {
        if (this.state.hasError) {
            // Estamos recargando con el build nuevo: dura un parpadeo, pero
            // mejor "actualizando" que un error rojo que el dueño no entiende.
            if (this.state.actualizando) {
                return (
                    <div style={ESTILO_PANTALLA}>
                        <p style={{ color: '#8899AA', fontSize: 15 }}>Actualizando la app…</p>
                    </div>
                );
            }

            if (this.props.fallback) return this.props.fallback;

            const deChunk = esErrorDeChunk(this.state.error);

            return (
                <div style={ESTILO_PANTALLA}>
                    <div
                        style={{
                            width: 64, height: 64,
                            background: 'rgba(239,68,68,0.15)',
                            border: '1px solid rgba(239,68,68,0.3)',
                            borderRadius: 16,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 28,
                            marginBottom: 24,
                        }}
                    >
                        ⚠️
                    </div>

                    <h1 style={{ color: '#fff', fontSize: 22, fontWeight: 800, marginBottom: 8 }}>
                        {deChunk ? 'Falta descargar esta pantalla' : 'Algo salió mal'}
                    </h1>
                    <p style={{ color: '#8899AA', fontSize: 14, marginBottom: 8, maxWidth: 360 }}>
                        {deChunk
                            ? 'La app se actualizó y esta pantalla aún no está guardada en el dispositivo. Conéctate a internet un momento y reintenta. Tus datos están seguros.'
                            : 'Hubo un error inesperado. Tus datos están seguros — están guardados localmente.'}
                    </p>

                    {/* El mensaje técnico solo estorba cuando ya explicamos qué pasó */}
                    {this.state.error && !deChunk && (
                        <code
                            style={{
                                display: 'block',
                                background: 'rgba(239,68,68,0.08)',
                                border: '1px solid rgba(239,68,68,0.2)',
                                borderRadius: 8,
                                padding: '8px 16px',
                                color: '#EF4444',
                                fontSize: 11,
                                maxWidth: 480,
                                wordBreak: 'break-all',
                                marginBottom: 32,
                            }}
                        >
                            {this.state.error.message}
                        </code>
                    )}

                    <div
                        style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 12,
                            justifyContent: 'center',
                            marginTop: 24,
                        }}
                    >
                        {deChunk && (
                            <button onClick={this.handleRetry} style={ESTILO_BOTON}>
                                Reintentar
                            </button>
                        )}
                        <button
                            onClick={this.handleReset}
                            style={deChunk ? ESTILO_BOTON_SECUNDARIO : ESTILO_BOTON}
                        >
                            Volver al inicio
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
