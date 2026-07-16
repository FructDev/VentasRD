// src/components/ui/Novedades.tsx
// Modal "Novedades" que aparece una vez tras cada actualización mayor.
// Se reabre desde el Dashboard disparando el evento 'abrir-novedades'.
'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useConfigStore } from '@/store/useConfigStore';

// Subir esta versión cuando haya novedades nuevas que anunciar.
const NOVEDADES_VERSION = '2026-07.2';
const STORAGE_KEY = 'vrd_novedades_version';

const RUTAS_SETUP = ['/login', '/registro', '/landing', '/onboarding', '/select-branch', '/pin', '/unirse', '/auth', '/offline'];

interface Item { titulo: string; probar: string; }
interface Seccion { emoji: string; titulo: string; items: Item[]; }

const SECCIONES: Seccion[] = [
    {
        emoji: '🧠', titulo: 'Tu negocio ahora te habla',
        items: [
            { titulo: 'Asistente "Tu día"', probar: 'Entra a Resumen: arriba verás avisos como "el aceite se acaba el jueves", "Juan lleva 45 días sin abonar" o "mañana es quincena, prepárate". Todo sale de TUS datos.' },
            { titulo: 'Lista de compras sugerida', probar: 'El asistente calcula qué reponer para los próximos 15 días y cuánta inversión necesitas.' },
            { titulo: 'Compártelo por WhatsApp', probar: 'Botón "📱 Enviar a WhatsApp" en la tarjeta — mándate el resumen o compártelo con tu socio.' },
        ],
    },
    {
        emoji: '📷', titulo: 'Tu celular es una pistola de escaneo',
        items: [
            { titulo: 'Escanea para vender', probar: 'En la caja toca "📷 Escanear", apunta la cámara al código de barras y el producto cae al carrito.' },
        ],
    },
    {
        emoji: '⏸️', titulo: 'Ventas en espera',
        items: [
            { titulo: 'Pausa al cliente indeciso', probar: 'Con productos en el carrito toca "⏸ En espera" — atiende al siguiente y retoma la venta pausada cuando el cliente vuelva.' },
        ],
    },
    {
        emoji: '🚚', titulo: 'Facturas listas para delivery',
        items: [
            { titulo: 'Nombre del cliente y ubicación en el ticket', probar: 'Asigna el cliente en el carrito e imprime: el ticket sale con "Cliente:" y la ubicación de cada producto (llénala en Inventario).' },
        ],
    },
    {
        emoji: '⚡', titulo: 'Varias cajas, un solo inventario',
        items: [
            { titulo: 'Stock en vivo entre equipos', probar: 'Vende algo en una caja y mira la otra: el stock se actualiza en segundos, aunque esté minimizada.' },
            { titulo: '🩺 Estado del Sistema', probar: 'Ajustes → Estado del Sistema: si algo anda lento, toca "Copiar diagnóstico" y envíanoslo por WhatsApp.' },
            { titulo: 'Centro de Ayuda', probar: 'Las preguntas más comunes con sus respuestas: ventard.vercel.app/ayuda (también desde Ajustes).' },
        ],
    },
    {
        emoji: '🎨', titulo: 'Haz la app TUYA',
        items: [
            { titulo: 'Tu color de marca en toda la app', probar: 'Ajustes → "Color de Marca" → toca un color y mira cómo cambia todo al instante. Guarda para aplicarlo en todos tus dispositivos.' },
            { titulo: 'Elige la letra de tus títulos', probar: 'Ajustes → "Tipografía" → prueba las 7 letras disponibles.' },
            { titulo: 'Tu logo arriba en la app', probar: 'Si ya subiste tu logo en Ajustes, ahora aparece en la barra superior en vez de "VentaRD".' },
        ],
    },
    {
        emoji: '🛍️', titulo: 'Tu catálogo por WhatsApp',
        items: [
            { titulo: 'Mini-tienda con un link', probar: 'Ajustes → "🛍️ Catálogo Público" → actívalo y comparte el link. Tus clientes ven tus productos con fotos y precios.' },
            { titulo: 'Te llegan pedidos por WhatsApp', probar: 'El cliente arma su pedido en el catálogo y te llega directo a tu WhatsApp, listo para despachar.' },
        ],
    },
    {
        emoji: '🎁', titulo: 'Invita y gana',
        items: [
            { titulo: '15 días gratis por cada negocio que invites', probar: 'Ajustes → "🎁 Invita y Gana" → comparte tu link. Cuando el otro negocio se registre, AMBOS ganan 15 días de acceso. Sin límite.' },
        ],
    },
    {
        emoji: '📱', titulo: 'Recibos por WhatsApp',
        items: [
            { titulo: 'Recibo directo al cliente', probar: 'Al terminar una venta toca "📱 WhatsApp": si la venta tiene cliente con teléfono, el recibo le llega a ÉL directamente.' },
            { titulo: 'Instala la app con un toque', probar: 'Si usas VentaRD en el navegador, ahora te ofrece instalarse sola — un toque y queda como app.' },
        ],
    },
];

export default function Novedades() {
    const pathname = usePathname();
    const { negocioId } = useConfigStore();
    const [open, setOpen] = useState(false);

    // Auto-abrir una vez por versión
    useEffect(() => {
        if (!negocioId) return;
        if (RUTAS_SETUP.some(r => pathname.startsWith(r))) return;
        if (localStorage.getItem(STORAGE_KEY) !== NOVEDADES_VERSION) {
            setOpen(true);
        }
    }, [negocioId, pathname]);

    // Reabrir desde el Dashboard
    useEffect(() => {
        const abrir = () => setOpen(true);
        window.addEventListener('abrir-novedades', abrir);
        return () => window.removeEventListener('abrir-novedades', abrir);
    }, []);

    const cerrar = () => {
        localStorage.setItem(STORAGE_KEY, NOVEDADES_VERSION);
        setOpen(false);
    };

    if (!open) return null;

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[70] flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
            <div className="bg-navy-2 w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-gold/25 shadow-2xl overflow-hidden flex flex-col max-h-[92vh] sm:max-h-[85vh] animate-scale-in">
                {/* Header */}
                <div className="p-5 sm:p-6 bg-gradient-to-br from-gold/15 to-navy-2 border-b border-navy-3 shrink-0">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-[11px] font-black text-gold uppercase tracking-widest">Novedades</p>
                            <h2 className="text-xl sm:text-2xl font-display font-black text-white mt-0.5">¡VentaRD se actualizó! 🎉</h2>
                            <p className="text-sm text-vr-gray mt-1">Esto es lo nuevo que puedes hacer:</p>
                        </div>
                        <button onClick={cerrar} className="text-vr-gray hover:text-white font-bold text-xl px-1 shrink-0 transition-colors">✕</button>
                    </div>
                </div>

                {/* Contenido scrollable */}
                <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
                    {SECCIONES.map(sec => (
                        <div key={sec.titulo}>
                            <h3 className="text-sm font-display font-bold text-white flex items-center gap-2 mb-2">
                                <span className="text-lg">{sec.emoji}</span> {sec.titulo}
                            </h3>
                            <div className="space-y-2">
                                {sec.items.map(item => (
                                    <div key={item.titulo} className="bg-navy rounded-xl border border-navy-3 p-3">
                                        <p className="text-sm font-bold text-gold-2">{item.titulo}</p>
                                        <p className="text-xs text-vr-gray mt-0.5 leading-relaxed">
                                            <span className="font-bold text-vr-gray/80">Cómo probarlo:</span> {item.probar}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                {/* Footer */}
                <div className="p-4 sm:p-5 border-t border-navy-3 shrink-0">
                    <button
                        onClick={cerrar}
                        className="w-full py-3.5 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all text-base"
                    >
                        ¡Entendido, a probar! →
                    </button>
                    <p className="text-[11px] text-vr-gray/60 text-center mt-2">Puedes volver a ver esto en Resumen → ✨ Novedades</p>
                </div>
            </div>
        </div>
    );
}
