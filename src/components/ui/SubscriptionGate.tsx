'use client';

import { useEffect } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { MessageCircle, ShoppingCart } from 'lucide-react';

const WHATSAPP_NUMBER = '18294515303';
const WHATSAPP_MSG = encodeURIComponent('Hola, quiero activar/renovar mi cuenta de VentaRD');

const DIA = 24 * 60 * 60 * 1000;
const GRACIA_DIAS = 5; // días de tolerancia tras el vencimiento antes de bloquear

export default function SubscriptionGate({ children }: { children: React.ReactNode }) {
    const { accesoHasta, ultimaFechaVista, planActivo, trialHasta, negocioNombre, marcarTiempoVisto } = useConfigStore();

    // Avanzar la marca de agua de tiempo al montar (anti-retroceso de reloj offline)
    useEffect(() => { marcarTiempoVisto(); }, [marcarTiempoVisto]);

    // Tiempo efectivo: nunca menor que el máximo real ya visto (si atrasan el reloj, no sirve)
    const ahora = Math.max(Date.now(), ultimaFechaVista);
    const vence = accesoHasta ?? trialHasta; // fallback legado

    // Determinar estado de acceso
    let estado: 'ok' | 'gracia' | 'bloqueado';
    let diasParaVencer = 0;
    let diasDeGracia = 0;

    if (vence == null) {
        estado = planActivo ? 'ok' : 'bloqueado'; // negocio viejo sin fecha
    } else if (ahora <= vence) {
        estado = 'ok';
        diasParaVencer = Math.ceil((vence - ahora) / DIA);
    } else {
        const diasVencido = (ahora - vence) / DIA;
        if (diasVencido <= GRACIA_DIAS) {
            estado = 'gracia';
            diasDeGracia = Math.max(1, Math.ceil(GRACIA_DIAS - diasVencido));
        } else {
            estado = 'bloqueado';
        }
    }

    const linkWhatsApp = `https://wa.me/${WHATSAPP_NUMBER}?text=${WHATSAPP_MSG}`;

    if (estado === 'ok') {
        return (
            <>
                {/* Aviso suave cuando faltan pocos días para vencer */}
                {diasParaVencer > 0 && diasParaVencer <= 7 && (
                    <div className="bg-gold/10 border-b border-gold/20 px-4 py-2 flex items-center justify-center gap-3 text-center flex-wrap">
                        <span className="text-gold text-sm font-bold">
                            {diasParaVencer === 1 ? 'Tu acceso vence mañana' : `Tu acceso vence en ${diasParaVencer} días`}
                        </span>
                        <a href={linkWhatsApp} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 bg-gold text-navy px-3 py-1 rounded-full text-xs font-extrabold hover:brightness-110 transition-all">
                            <MessageCircle className="w-3 h-3" /> Renovar
                        </a>
                    </div>
                )}
                {children}
            </>
        );
    }

    if (estado === 'gracia') {
        // Vencido pero dentro del período de gracia: deja trabajar con aviso fuerte
        return (
            <>
                <div className="bg-vr-red/15 border-b border-vr-red/30 px-4 py-2.5 flex items-center justify-center gap-3 text-center flex-wrap">
                    <span className="text-vr-red text-sm font-bold">
                        ⚠️ Tu pago venció. El sistema se bloqueará en {diasDeGracia} día{diasDeGracia !== 1 ? 's' : ''}.
                    </span>
                    <a href={linkWhatsApp} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 bg-vr-red text-white px-3 py-1 rounded-full text-xs font-extrabold hover:brightness-110 transition-all">
                        <MessageCircle className="w-3 h-3" /> Regularizar ahora
                    </a>
                </div>
                {children}
            </>
        );
    }

    // Bloqueado — los datos se conservan; solo se bloquea la pantalla
    return (
        <div className="min-h-screen bg-navy flex items-center justify-center p-6">
            <div className="max-w-lg w-full text-center">
                <div className="w-16 h-16 bg-gold/10 border border-gold/30 rounded-2xl flex items-center justify-center mx-auto mb-6">
                    <ShoppingCart className="w-8 h-8 text-gold" />
                </div>

                <h1 className="text-3xl font-display font-black text-white mb-3">{negocioNombre || 'VentaRD'}</h1>

                <p className="text-vr-gray text-base mb-2">
                    {vence == null ? 'Tu cuenta aún no está activada.' : 'Tu acceso está vencido.'}
                </p>
                <p className="text-vr-gray text-sm mb-8">
                    Tus datos están a salvo. Para reactivar y seguir usando VentaRD, escríbenos por WhatsApp —
                    el proceso toma menos de 5 minutos.
                </p>

                <a href={linkWhatsApp} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 bg-gold-gradient text-navy px-8 py-4 rounded-2xl font-extrabold text-lg hover:brightness-110 transition-all shadow-[0_0_30px_rgba(212,160,23,0.3)] mb-4">
                    <MessageCircle className="w-5 h-5" /> Reactivar por WhatsApp
                </a>

                <p className="text-vr-gray text-xs">
                    ¿Ya pagaste y sigue bloqueado?{' '}
                    <button onClick={() => window.location.reload()} className="text-gold hover:underline">
                        Recargar la página
                    </button>
                </p>
            </div>
        </div>
    );
}
