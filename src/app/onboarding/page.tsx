// src/app/onboarding/page.tsx
'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useConfigStore } from '@/store/useConfigStore';

export default function OnboardingPage() {
    const [telefono, setTelefono] = useState('');
    const [tipoNegocio, setTipoNegocio] = useState('colmado');
    const [direccion, setDireccion] = useState('');
    const [loading, setLoading] = useState(false);

    const negocioId = useConfigStore((state) => state.negocioId);

    const handleCompletarOnboarding = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        if (!negocioId) return;

        const { error } = await supabase
            .from('negocios')
            .update({
                telefono,
                tipo_negocio: tipoNegocio,
                direccion,
                onboarding_completado: true,
            })
            .eq('id', negocioId);

        if (!error) {
            window.location.href = '/';
        } else {
            console.error("Error guardando el onboarding:", error.message);
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-navy p-4">
            <div className="max-w-lg w-full bg-navy-2 p-8 rounded-2xl border border-navy-3 shadow-2xl">
                <div className="text-center mb-8">
                    <h1 className="text-3xl font-display font-extrabold text-gold mb-2">¡Bienvenido a VentaRD! 🎉</h1>
                    <p className="text-vr-gray">
                        Necesitamos un par de datos básicos para configurar tu punto de venta.
                    </p>
                </div>

                <form onSubmit={handleCompletarOnboarding} className="space-y-5">
                    <div>
                        <label className="block text-sm font-bold text-vr-gray mb-1.5">¿Qué tipo de negocio tienes?</label>
                        <select
                            className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                            value={tipoNegocio} onChange={(e) => setTipoNegocio(e.target.value)}
                        >
                            <option value="colmado">Colmado / Minimarket</option>
                            <option value="tienda_ropa">Tienda de Ropa / Boutique</option>
                            <option value="ferreteria">Ferretería</option>
                            <option value="restaurante">Restaurante / Cafetería</option>
                            <option value="servicios">Servicios Generales</option>
                            <option value="otro">Otro</option>
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Teléfono Principal</label>
                        <input
                            type="tel" required placeholder="Ej: 809-555-0000"
                            className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white placeholder-vr-gray-2 focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                            value={telefono} onChange={(e) => setTelefono(e.target.value)}
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Dirección Básica</label>
                        <input
                            type="text" required placeholder="Sector, Ciudad"
                            className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white placeholder-vr-gray-2 focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                            value={direccion} onChange={(e) => setDireccion(e.target.value)}
                        />
                    </div>

                    <button
                        type="submit" disabled={loading || !negocioId}
                        className="w-full bg-gold-gradient text-navy py-4 rounded-xl font-extrabold text-lg hover:brightness-110 transition-all disabled:opacity-40 mt-4"
                    >
                        {loading ? 'Configurando sistema...' : 'Comenzar a Vender 🚀'}
                    </button>
                </form>
            </div>
        </div>
    );
}