'use client';

import { useConfigStore } from '@/store/useConfigStore';
import { MessageCircle, ShoppingCart } from 'lucide-react';

const WHATSAPP_NUMBER = '18294515303';
const WHATSAPP_MSG = encodeURIComponent('Hola, quiero activar mi cuenta de VentaRD');

export default function SubscriptionGate({ children }: { children: React.ReactNode }) {
    const { planActivo, trialHasta, negocioNombre } = useConfigStore();

    const ahora = Date.now();
    const enTrial = trialHasta !== null && ahora < trialHasta;
    const tieneAcceso = planActivo || enTrial;

    // Calcular días restantes de trial
    const diasRestantes = trialHasta
        ? Math.max(0, Math.ceil((trialHasta - ahora) / (1000 * 60 * 60 * 24)))
        : 0;

    const trialVencido = trialHasta !== null && ahora >= trialHasta && !planActivo;

    if (tieneAcceso) {
        return (
            <>
                {/* Banner de trial — solo si está en prueba y quedan pocos días */}
                {enTrial && diasRestantes <= 7 && (
                    <div className="bg-gold/10 border-b border-gold/20 px-4 py-2 flex items-center justify-center gap-3 text-center flex-wrap">
                        <span className="text-gold text-sm font-bold">
                            {diasRestantes === 0
                                ? 'Tu período de prueba termina hoy'
                                : `${diasRestantes} día${diasRestantes !== 1 ? 's' : ''} de prueba restante${diasRestantes !== 1 ? 's' : ''}`}
                        </span>
                        <a
                            href={`https://wa.me/${WHATSAPP_NUMBER}?text=${WHATSAPP_MSG}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 bg-gold text-navy px-3 py-1 rounded-full text-xs font-extrabold hover:brightness-110 transition-all"
                        >
                            <MessageCircle className="w-3 h-3" />
                            Activar cuenta
                        </a>
                    </div>
                )}
                {children}
            </>
        );
    }

    // Trial vencido o sin plan — mostrar gate completo
    return (
        <div className="min-h-screen bg-navy flex items-center justify-center p-6">
            <div className="max-w-lg w-full text-center">
                <div className="w-16 h-16 bg-gold/10 border border-gold/30 rounded-2xl flex items-center justify-center mx-auto mb-6">
                    <ShoppingCart className="w-8 h-8 text-gold" />
                </div>

                <h1 className="text-3xl font-display font-black text-white mb-3">
                    {negocioNombre || 'VentaRD'}
                </h1>

                {trialVencido ? (
                    <p className="text-vr-gray text-base mb-2">
                        Tu período de prueba gratuita ha terminado.
                    </p>
                ) : (
                    <p className="text-vr-gray text-base mb-2">
                        Tu cuenta aún no está activada.
                    </p>
                )}

                <p className="text-vr-gray text-sm mb-8">
                    Para continuar usando VentaRD, activa tu cuenta escribiéndonos por WhatsApp.
                    El proceso toma menos de 5 minutos.
                </p>

                <a
                    href={`https://wa.me/${WHATSAPP_NUMBER}?text=${WHATSAPP_MSG}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 bg-gold-gradient text-navy px-8 py-4 rounded-2xl font-extrabold text-lg hover:brightness-110 transition-all shadow-[0_0_30px_rgba(212,160,23,0.3)] mb-4"
                >
                    <MessageCircle className="w-5 h-5" />
                    Activar por WhatsApp
                </a>

                <p className="text-vr-gray text-xs">
                    ¿Ya activaste y sigue bloqueado?{' '}
                    <button
                        onClick={() => window.location.reload()}
                        className="text-gold hover:underline"
                    >
                        Recargar la página
                    </button>
                </p>
            </div>
        </div>
    );
}
