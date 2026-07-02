// src/app/onboarding/page.tsx
'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useConfigStore } from '@/store/useConfigStore';
import { ShoppingCart, Check } from 'lucide-react';
import { db } from '@/lib/db/dexie';

const STEPS = [
    { label: 'Cuenta creada', done: true },
    { label: 'Configura tu negocio', done: false, active: true },
    { label: 'Primera sucursal', done: false },
];

const TIPOS = [
    { value: 'colmado',      label: 'Colmado / Minimarket' },
    { value: 'tienda_ropa',  label: 'Tienda de Ropa / Boutique' },
    { value: 'ferreteria',   label: 'Ferretería' },
    { value: 'restaurante',  label: 'Restaurante / Cafetería' },
    { value: 'servicios',    label: 'Servicios Generales' },
    { value: 'otro',         label: 'Otro' },
];

export default function OnboardingPage() {
    const [tipoNegocio, setTipoNegocio] = useState('colmado');
    const [telefono, setTelefono] = useState('');
    const [direccion, setDireccion] = useState('');
    const [nombreSucursal, setNombreSucursal] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const negocioId = useConfigStore((state) => state.negocioId);

    const handleCompletarOnboarding = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId) return;
        setLoading(true);
        setError(null);

        try {
            // El onboarding se completa en el servidor (service role): opera sobre el
            // negocio del usuario autenticado por su token, evitando bloqueos de RLS.
            const { data: { session } } = await supabase.auth.getSession();
            const token = session?.access_token;
            if (!token) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');

            const res = await fetch('/api/onboarding', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({
                    tipo_negocio: tipoNegocio,
                    telefono,
                    direccion,
                    nombre_sucursal: nombreSucursal,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(`${data.error || 'Error al guardar'}${data.code ? ` (código ${data.code})` : ''}`);

            // Cache offline de la sucursal creada
            await db.sucursales.put({
                id: data.sucursalId,
                negocio_id: data.negocioId,
                nombre: data.sucursalNombre,
                direccion,
                fecha_creacion: data.fecha_creacion,
            });

            window.location.href = '/';
        } catch (err: unknown) {
            // Los errores de Supabase son objetos { message, code, details, hint },
            // no instancias de Error — extraemos el mensaje real igual.
            const e = err as { message?: string; code?: string; details?: string; hint?: string };
            const msg = e?.message || (err instanceof Error ? err.message : 'Error desconocido');
            console.error('Error en onboarding:', e?.code, msg, e?.details, e?.hint, err);
            setError(`No se pudo guardar: ${msg}${e?.code ? ` (código ${e.code})` : ''}. Si persiste, envíanos una captura de este mensaje.`);
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex bg-navy">

            {/* ── Panel de marca — solo desktop ── */}
            <div className="hidden lg:flex lg:w-[45%] xl:w-1/2 bg-navy-2 border-r border-white/5 flex-col justify-between p-12 xl:p-16">
                <div>
                    {/* Logo */}
                    <div className="flex items-center gap-2.5 mb-14">
                        <div className="w-9 h-9 bg-gold rounded-xl flex items-center justify-center">
                            <ShoppingCart className="w-5 h-5 text-navy" />
                        </div>
                        <span className="font-display font-extrabold text-xl text-white tracking-tight">VentaRD</span>
                    </div>

                    {/* Headline */}
                    <h2 className="font-display font-black text-3xl xl:text-4xl text-white leading-tight mb-3">
                        Un paso más y<br />
                        <span className="text-gold">empiezas a vender.</span>
                    </h2>
                    <p className="text-vr-gray text-base leading-relaxed mb-12">
                        Cuéntanos un poco de tu negocio para que el sistema quede
                        listo desde el primer día.
                    </p>

                    {/* Pasos */}
                    <div className="space-y-5">
                        {STEPS.map((step, i) => (
                            <div key={i} className="flex items-center gap-4">
                                <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 border transition-all ${
                                    step.done
                                        ? 'bg-gold/20 border-gold/40'
                                        : step.active
                                            ? 'bg-gold border-gold'
                                            : 'bg-transparent border-white/15'
                                }`}>
                                    {step.done ? (
                                        <Check className="w-3.5 h-3.5 text-gold" />
                                    ) : (
                                        <span className={`text-xs font-black ${step.active ? 'text-navy' : 'text-vr-gray'}`}>
                                            {i + 1}
                                        </span>
                                    )}
                                </div>
                                <span className={`text-sm font-medium ${
                                    step.done ? 'text-white/60 line-through decoration-white/20'
                                        : step.active ? 'text-white font-bold'
                                        : 'text-vr-gray'
                                }`}>
                                    {step.label}
                                </span>
                            </div>
                        ))}
                    </div>

                    {/* Nota de tiempo */}
                    <div className="mt-10 flex items-center gap-2 text-xs text-vr-gray bg-white/3 border border-white/8 rounded-xl px-4 py-3">
                        <span className="text-base">⏱</span>
                        Esto toma menos de 2 minutos
                    </div>
                </div>

                <p className="flex items-center gap-2 text-xs text-vr-gray">
                    <span className="w-1.5 h-1.5 rounded-full bg-gold inline-block" />
                    Hecho en República Dominicana
                </p>
            </div>

            {/* ── Panel del formulario ── */}
            <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8">

                {/* Logo móvil */}
                <div className="lg:hidden flex items-center gap-2.5 mb-8">
                    <div className="w-8 h-8 bg-gold rounded-lg flex items-center justify-center">
                        <ShoppingCart className="w-4 h-4 text-navy" />
                    </div>
                    <span className="font-display font-extrabold text-lg text-white">VentaRD</span>
                </div>

                <div className="max-w-md w-full">
                    {/* Pasos compactos — solo mobile */}
                    <div className="lg:hidden flex items-center gap-2 mb-6">
                        {STEPS.map((step, i) => (
                            <div key={i} className="flex items-center gap-2">
                                <div className={`w-2 h-2 rounded-full ${
                                    step.done ? 'bg-gold/50' : step.active ? 'bg-gold' : 'bg-white/15'
                                }`} />
                                {i < STEPS.length - 1 && <div className="w-6 h-px bg-white/10" />}
                            </div>
                        ))}
                        <span className="text-xs text-vr-gray ml-1">Paso 2 de 3</span>
                    </div>

                    <div className="mb-8">
                        <h1 className="text-2xl font-display font-black text-white mb-1">Configura tu negocio</h1>
                        <p className="text-vr-gray text-sm">Esta información aparece en tus tickets y reportes</p>
                    </div>

                    <form onSubmit={handleCompletarOnboarding} className="space-y-5">
                        <div>
                            <label className="block text-sm font-bold text-vr-gray mb-1.5">¿Qué tipo de negocio tienes?</label>
                            <select
                                className="w-full px-4 py-3 bg-navy-2 border border-navy-3 rounded-xl text-white focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                                value={tipoNegocio} onChange={(e) => setTipoNegocio(e.target.value)}
                            >
                                {TIPOS.map(t => (
                                    <option key={t.value} value={t.value}>{t.label}</option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Teléfono Principal</label>
                            <input
                                type="tel" required placeholder="Ej: 809-555-0000"
                                className="w-full px-4 py-3 bg-navy-2 border border-navy-3 rounded-xl text-white placeholder-vr-gray/50 focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                                value={telefono} onChange={(e) => setTelefono(e.target.value)}
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Dirección</label>
                            <input
                                type="text" required placeholder="Sector, Ciudad"
                                className="w-full px-4 py-3 bg-navy-2 border border-navy-3 rounded-xl text-white placeholder-vr-gray/50 focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                                value={direccion} onChange={(e) => setDireccion(e.target.value)}
                            />
                        </div>

                        <div className="pt-1">
                            <label className="block text-sm font-bold text-vr-gray mb-1">
                                Nombre de tu local / sucursal
                            </label>
                            <p className="text-xs text-vr-gray mb-2">Si tienes un solo local, puedes dejarlo así.</p>
                            <input
                                type="text" placeholder="Local Principal"
                                className="w-full px-4 py-3 bg-navy-2 border border-navy-3 rounded-xl text-white placeholder-vr-gray/50 focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                                value={nombreSucursal} onChange={(e) => setNombreSucursal(e.target.value)}
                            />
                        </div>

                        {error && (
                            <div className="text-vr-red text-sm bg-vr-red/10 p-3 rounded-xl border border-vr-red/20 font-medium">
                                {error}
                            </div>
                        )}

                        <button
                            type="submit" disabled={loading || !negocioId}
                            className="w-full bg-gold-gradient text-navy py-4 rounded-xl font-extrabold text-base hover:brightness-110 transition-all disabled:opacity-40 mt-2"
                        >
                            {loading ? 'Configurando sistema...' : 'Comenzar a vender →'}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}
