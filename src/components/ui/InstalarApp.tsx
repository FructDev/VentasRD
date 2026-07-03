// src/components/ui/InstalarApp.tsx
// Banner para instalar la PWA con un toque. En Chrome/Edge/Android captura
// beforeinstallprompt y dispara el diálogo nativo; en iPhone/iPad (Safari,
// sin ese evento) muestra una mini-guía de 2 pasos. No aparece si la app
// ya está instalada, y al descartarlo espera 7 días antes de volver a salir.
'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const SNOOZE_KEY = 'ventard_instalar_snooze';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

// Rutas donde no tiene sentido ofrecer la instalación
const RUTAS_OCULTAS = ['/landing', '/catalogo', '/login', '/registro', '/recuperar-contrasena', '/actualizar-contrasena', '/superadmin', '/unirse', '/auth'];

function snoozed(): boolean {
    try {
        const t = Number(localStorage.getItem(SNOOZE_KEY) || 0);
        return t > 0 && Date.now() - t < SNOOZE_MS;
    } catch { return false; }
}

function esStandalone(): boolean {
    return window.matchMedia('(display-mode: standalone)').matches
        || ('standalone' in window.navigator && (window.navigator as unknown as { standalone?: boolean }).standalone === true);
}

function esIOS(): boolean {
    const ua = navigator.userAgent;
    return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
}

export default function InstalarApp() {
    const pathname = usePathname();
    const [promptEvt, setPromptEvt] = useState<BeforeInstallPromptEvent | null>(null);
    const [mostrarIOS, setMostrarIOS] = useState(false);
    const [guiaIOSAbierta, setGuiaIOSAbierta] = useState(false);
    const [oculto, setOculto] = useState(false);

    useEffect(() => {
        if (esStandalone() || snoozed()) return;

        // iOS no dispara beforeinstallprompt: ofrecer la guía manual
        // (con una pequeña espera para no saltar encima del primer render)
        if (esIOS()) {
            const t = setTimeout(() => setMostrarIOS(true), 3000);
            return () => clearTimeout(t);
        }

        const onPrompt = (e: Event) => {
            e.preventDefault(); // evita el mini-infobar de Chrome; lo mostramos nosotros
            setPromptEvt(e as BeforeInstallPromptEvent);
        };
        const onInstalled = () => { setPromptEvt(null); setMostrarIOS(false); };
        window.addEventListener('beforeinstallprompt', onPrompt);
        window.addEventListener('appinstalled', onInstalled);
        return () => {
            window.removeEventListener('beforeinstallprompt', onPrompt);
            window.removeEventListener('appinstalled', onInstalled);
        };
    }, []);

    const descartar = () => {
        try { localStorage.setItem(SNOOZE_KEY, String(Date.now())); } catch { /* noop */ }
        setOculto(true);
    };

    const instalar = async () => {
        if (!promptEvt) return;
        await promptEvt.prompt();
        const { outcome } = await promptEvt.userChoice;
        setPromptEvt(null);
        if (outcome === 'dismissed') descartar();
    };

    const visible = !oculto
        && (promptEvt !== null || mostrarIOS)
        && !RUTAS_OCULTAS.some(r => pathname.startsWith(r));
    if (!visible) return null;

    return (
        <>
            {/* Banner flotante */}
            <div className="fixed bottom-4 inset-x-3 sm:inset-x-auto sm:right-4 sm:w-96 z-[60] animate-slide-up">
                <div className="bg-navy-2 border border-gold/30 rounded-2xl shadow-2xl p-4 glow-gold">
                    <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gold-gradient flex items-center justify-center text-xl shrink-0">📲</div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-white">Instala VentaRD</p>
                            <p className="text-xs text-vr-gray mt-0.5">Ábrela como una app, más rápida y a pantalla completa. Funciona sin internet.</p>
                        </div>
                        <button onClick={descartar} aria-label="Cerrar" className="text-vr-gray hover:text-white text-lg leading-none shrink-0 -mt-1">✕</button>
                    </div>
                    <div className="mt-3">
                        {promptEvt ? (
                            <button onClick={instalar} className="w-full py-2.5 bg-gold-gradient text-navy font-extrabold rounded-xl text-sm hover:brightness-110 transition-all">
                                Instalar ahora
                            </button>
                        ) : (
                            <button onClick={() => setGuiaIOSAbierta(true)} className="w-full py-2.5 bg-gold-gradient text-navy font-extrabold rounded-xl text-sm hover:brightness-110 transition-all">
                                Ver cómo instalarla
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Guía iOS */}
            {guiaIOSAbierta && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[70] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setGuiaIOSAbierta(false)}>
                    <div className="bg-navy-2 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl border border-navy-3 p-6 animate-slide-up" onClick={e => e.stopPropagation()}>
                        <h3 className="font-display font-black text-lg text-white mb-4">Instalar en iPhone/iPad</h3>
                        <ol className="space-y-4">
                            <li className="flex items-center gap-3">
                                <span className="w-8 h-8 rounded-full bg-gold/15 text-gold font-black flex items-center justify-center shrink-0">1</span>
                                <p className="text-sm text-white">Toca el botón <span className="font-bold text-gold">Compartir</span> <span className="inline-block border border-navy-3 rounded px-1.5">⬆️</span> abajo en Safari</p>
                            </li>
                            <li className="flex items-center gap-3">
                                <span className="w-8 h-8 rounded-full bg-gold/15 text-gold font-black flex items-center justify-center shrink-0">2</span>
                                <p className="text-sm text-white">Elige <span className="font-bold text-gold">&quot;Añadir a pantalla de inicio&quot;</span> <span className="inline-block border border-navy-3 rounded px-1.5">➕</span></p>
                            </li>
                        </ol>
                        <button onClick={() => { setGuiaIOSAbierta(false); descartar(); }} className="mt-6 w-full py-3 bg-gold-gradient text-navy font-extrabold rounded-xl text-sm">
                            Entendido
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}
