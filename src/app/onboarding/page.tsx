// src/app/onboarding/page.tsx
'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useConfigStore } from '@/store/useConfigStore';
import { db } from '@/lib/db/dexie';
import { v4 as uuidv4 } from 'uuid';

const TIPOS_NEGOCIO = [
    { value: 'colmado',      label: 'Colmado / Minimarket' },
    { value: 'tienda_ropa',  label: 'Tienda de Ropa / Boutique' },
    { value: 'ferreteria',   label: 'Ferretería' },
    { value: 'restaurante',  label: 'Restaurante / Cafetería' },
    { value: 'servicios',    label: 'Servicios Generales' },
    { value: 'farmacia',     label: 'Farmacia / Botica' },
    { value: 'otro',         label: 'Otro' },
];

export default function OnboardingPage() {
    const { negocioId, setSucursal } = useConfigStore();

    const [tipoNegocio,    setTipoNegocio]    = useState('colmado');
    const [telefono,       setTelefono]        = useState('');
    const [direccion,      setDireccion]       = useState('');
    const [nombreSucursal, setNombreSucursal]  = useState('');
    const [loading,        setLoading]         = useState(false);
    const [error,          setError]           = useState('');

    const handleCompletarOnboarding = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId) return;
        setLoading(true);
        setError('');

        try {
            // 1. Completar info del negocio
            const { error: negocioError } = await supabase
                .from('negocios')
                .update({
                    telefono,
                    tipo_negocio: tipoNegocio,
                    direccion,
                    onboarding_completado: true,
                })
                .eq('id', negocioId);

            if (negocioError) throw negocioError;

            // 2. Crear la primera sucursal
            const sucursalId = uuidv4();
            const { error: sucursalError } = await supabase
                .from('sucursales')
                .insert({
                    id:         sucursalId,
                    negocio_id: negocioId,
                    nombre:     nombreSucursal.trim() || 'Local Principal',
                    direccion:  direccion,
                });

            if (sucursalError) throw sucursalError;

            // 3. Cachear la sucursal en Dexie para uso offline
            await db.sucursales.put({
                id:         sucursalId,
                negocio_id: negocioId,
                nombre:     nombreSucursal.trim() || 'Local Principal',
                direccion:  direccion,
            });

            // 4. Activar la sucursal en el estado global
            setSucursal(sucursalId);

            // 5. Al POS directo — sin pasar por select-branch
            window.location.href = '/';

        } catch (err: any) {
            console.error('Error en onboarding:', err);
            setError('Hubo un problema al guardar tu información. Intenta de nuevo.');
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-navy p-4">
            <div className="max-w-lg w-full">

                {/* Header */}
                <div className="text-center mb-8">
                    <span className="text-5xl block mb-4">🎉</span>
                    <h1 className="text-3xl font-display font-extrabold text-gold mb-2">¡Bienvenido a VentaRD!</h1>
                    <p className="text-vr-gray">Configura tu negocio en 30 segundos y empieza a vender.</p>
                </div>

                <div className="bg-navy-2 p-8 rounded-2xl border border-navy-3 shadow-2xl space-y-5">

                    {/* Tipo de negocio */}
                    <div>
                        <label className="block text-sm font-bold text-vr-gray mb-1.5">
                            ¿Qué tipo de negocio tienes?
                        </label>
                        <select
                            className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                            value={tipoNegocio}
                            onChange={e => setTipoNegocio(e.target.value)}
                        >
                            {TIPOS_NEGOCIO.map(t => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                            ))}
                        </select>
                    </div>

                    {/* Teléfono */}
                    <div>
                        <label className="block text-sm font-bold text-vr-gray mb-1.5">
                            Teléfono Principal
                        </label>
                        <input
                            type="tel" required placeholder="Ej: 809-555-0000"
                            className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white placeholder-vr-gray/50 focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                            value={telefono}
                            onChange={e => setTelefono(e.target.value)}
                        />
                    </div>

                    {/* Dirección */}
                    <div>
                        <label className="block text-sm font-bold text-vr-gray mb-1.5">
                            Dirección
                        </label>
                        <input
                            type="text" required placeholder="Ej: C/ Duarte #14, Santiago"
                            className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white placeholder-vr-gray/50 focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                            value={direccion}
                            onChange={e => setDireccion(e.target.value)}
                        />
                    </div>

                    {/* Nombre del local — NUEVO */}
                    <div className="pt-2 border-t border-navy-3">
                        <label className="block text-sm font-bold text-vr-gray mb-1">
                            ¿Cómo se llama tu local?
                        </label>
                        <p className="text-xs text-vr-gray/70 mb-2">
                            Puedes agregar más sucursales después desde el panel administrativo.
                        </p>
                        <input
                            type="text" placeholder="Ej: Local Principal, Sucursal Centro..."
                            className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white placeholder-vr-gray/50 focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                            value={nombreSucursal}
                            onChange={e => setNombreSucursal(e.target.value)}
                        />
                    </div>

                    {/* Error */}
                    {error && (
                        <div className="bg-vr-red/10 border border-vr-red/30 text-vr-red text-sm font-bold rounded-xl p-3 text-center">
                            {error}
                        </div>
                    )}

                    {/* Submit */}
                    <button
                        onClick={handleCompletarOnboarding}
                        disabled={loading || !negocioId || !telefono || !direccion}
                        className="w-full bg-gold-gradient text-navy py-4 rounded-xl font-extrabold text-lg hover:brightness-110 transition-all disabled:opacity-40 mt-2"
                    >
                        {loading ? (
                            <span className="flex items-center justify-center gap-2">
                                <span className="w-5 h-5 border-2 border-navy border-t-transparent rounded-full animate-spin" />
                                Configurando...
                            </span>
                        ) : 'Comenzar a Vender →'}
                    </button>
                </div>
            </div>
        </div>
    );
}
