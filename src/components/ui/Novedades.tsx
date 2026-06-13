// src/components/ui/Novedades.tsx
// Modal "Novedades" que aparece una vez tras cada actualización mayor.
// Se reabre desde el Dashboard disparando el evento 'abrir-novedades'.
'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useConfigStore } from '@/store/useConfigStore';

// Subir esta versión cuando haya novedades nuevas que anunciar.
const NOVEDADES_VERSION = '2026-06';
const STORAGE_KEY = 'vrd_novedades_version';

const RUTAS_SETUP = ['/login', '/registro', '/landing', '/onboarding', '/select-branch', '/pin', '/unirse', '/auth', '/offline'];

interface Item { titulo: string; probar: string; }
interface Seccion { emoji: string; titulo: string; items: Item[]; }

const SECCIONES: Seccion[] = [
    {
        emoji: '🛒', titulo: 'Vender más rápido',
        items: [
            { titulo: 'Fotos en tus productos', probar: 'Inventario → edita un producto → "📷 Agregar foto". Aparece en la caja.' },
            { titulo: 'Cliente con su precio al facturar', probar: 'En el carrito busca el cliente; sus precios de mayoreo se aplican solos.' },
        ],
    },
    {
        emoji: '📦', titulo: 'Maneja tu inventario',
        items: [
            { titulo: 'Importar desde Excel', probar: 'Inventario → "📥 Importar". Descarga la plantilla, llénala y súbela.' },
            { titulo: 'Reorden inteligente', probar: 'Inventario te dice "te quedan ~3 días" y arma la lista de compras por WhatsApp.' },
        ],
    },
    {
        emoji: '💰', titulo: 'Sabe si ganas o pierdes',
        items: [
            { titulo: 'Registro de gastos', probar: 'Menú "💸 Gastos". Anota compras, luz, alquiler. Tu ganancia ahora es la REAL.' },
            { titulo: 'Resumen diario', probar: 'Cada mañana en "Resumen" ves cómo te fue ayer y lo mandas a tu WhatsApp.' },
            { titulo: 'A quién cobrar hoy', probar: 'En Clientes, lista de quién te debe y hace más tiempo no abona.' },
        ],
    },
    {
        emoji: '🧾', titulo: 'Para la DGII',
        items: [
            { titulo: 'Reporte 607', probar: 'Reportes → elige el mes → "Generar 607". Listo para la Oficina Virtual.' },
            { titulo: 'Tu logo en la factura', probar: 'Ajustes → sube tu logo; sale en el recibo impreso.' },
        ],
    },
    {
        emoji: '👥', titulo: 'Tu equipo',
        items: [
            { titulo: 'Invitar cajeros y vendedores', probar: 'Ajustes → Mi Equipo → "+ Agregar". Le mandas un link, pone su clave y entra.' },
            { titulo: 'El vendedor sale en la factura', probar: 'Sabes quién hizo cada venta en el ticket y el historial.' },
        ],
    },
    {
        emoji: '🖨️', titulo: 'Imprime mejor',
        items: [
            { titulo: 'Ajustes de impresión', probar: 'Ajustes → 🖨️ Impresión. Papel 58/80mm, letra grande, 2 copias, automático.' },
        ],
    },
    {
        emoji: '⚡', titulo: 'Por debajo (no se ve, pero importa)',
        items: [
            { titulo: 'Varias cajas a la vez', probar: 'El inventario nunca se descuadra y los comprobantes (NCF) no se repiten entre cajas.' },
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
