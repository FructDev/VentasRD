'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import Link from 'next/link';
import { ShoppingCart, Check } from 'lucide-react';

const FEATURES = [
    'Período de prueba gratis — sin tarjeta de crédito',
    'Configuración completa en menos de 5 minutos',
    'Funciona en celular, tablet y computadora',
    'Sin internet también funciona — ese es el punto',
];

export default function RegistroPage() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [nombreNegocio, setNombreNegocio] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [exito, setExito] = useState(false);

    const handleRegistro = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        const { error: signUpError } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: { nombre_negocio: nombreNegocio },
            },
        });

        if (signUpError) {
            setError(signUpError.message);
            setLoading(false);
        } else {
            setExito(true);
            setLoading(false);
        }
    };

    if (exito) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-navy p-4">
                <div className="max-w-md w-full text-center">
                    <div className="flex items-center gap-2.5 justify-center mb-10">
                        <div className="w-8 h-8 bg-gold rounded-lg flex items-center justify-center">
                            <ShoppingCart className="w-4 h-4 text-navy" />
                        </div>
                        <span className="font-display font-extrabold text-lg text-white">VentaRD</span>
                    </div>
                    <div className="w-16 h-16 bg-vr-green/15 border border-vr-green/30 rounded-2xl flex items-center justify-center mx-auto mb-5 text-3xl">
                        📧
                    </div>
                    <h2 className="text-2xl font-display font-bold text-white mb-2">¡Revisa tu correo!</h2>
                    <p className="text-vr-gray mb-2 leading-relaxed">
                        Enviamos un enlace de confirmación a{' '}
                        <strong className="text-white">{email}</strong>.
                    </p>
                    <p className="text-vr-gray text-sm mb-8">
                        Haz clic en el enlace para activar tu negocio y continuar.
                    </p>
                    <Link href="/login" className="inline-flex items-center gap-2 text-gold hover:text-gold-2 font-bold transition-colors text-sm">
                        Ir al inicio de sesión →
                    </Link>
                </div>
            </div>
        );
    }

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
                        Empieza a vender<br />
                        <span className="text-gold">hoy mismo, gratis.</span>
                    </h2>
                    <p className="text-vr-gray text-base leading-relaxed mb-10">
                        Crea tu cuenta, configura tu negocio y comienza a cobrar
                        en minutos. Sin contratos, sin sorpresas.
                    </p>

                    {/* Features */}
                    <ul className="space-y-4">
                        {FEATURES.map(f => (
                            <li key={f} className="flex items-start gap-3">
                                <div className="w-5 h-5 rounded-full bg-gold/15 border border-gold/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                                    <Check className="w-3 h-3 text-gold" />
                                </div>
                                <span className="text-white/80 text-sm leading-snug">{f}</span>
                            </li>
                        ))}
                    </ul>

                    {/* Testimonial / trust signal */}
                    <div className="mt-10 p-4 bg-white/3 border border-white/8 rounded-2xl">
                        <p className="text-white/70 text-sm leading-relaxed italic mb-2">
                            "Antes cuadraba caja en una libreta. Ahora lo hago en el celular y el sistema lleva todo solo."
                        </p>
                        <p className="text-vr-gray text-xs font-medium">— Dueño de colmado, Santiago</p>
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
                    <div className="mb-8">
                        <h1 className="text-2xl font-display font-black text-white mb-1">Crea tu cuenta</h1>
                        <p className="text-vr-gray text-sm">Período de prueba gratis — sin tarjeta</p>
                    </div>

                    <form onSubmit={handleRegistro} className="space-y-4">
                        <div>
                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Nombre del Negocio</label>
                            <input
                                type="text" required autoComplete="organization"
                                placeholder="Ej: Colmado El Buen Precio"
                                className="w-full px-4 py-3 bg-navy-2 border border-navy-3 rounded-xl text-white placeholder-vr-gray/50 focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                                value={nombreNegocio} onChange={(e) => setNombreNegocio(e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Correo Electrónico</label>
                            <input
                                type="email" required autoComplete="email"
                                className="w-full px-4 py-3 bg-navy-2 border border-navy-3 rounded-xl text-white focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                                value={email} onChange={(e) => setEmail(e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Contraseña</label>
                            <input
                                type="password" required minLength={6} autoComplete="new-password"
                                placeholder="Mínimo 6 caracteres"
                                className="w-full px-4 py-3 bg-navy-2 border border-navy-3 rounded-xl text-white placeholder-vr-gray/50 focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                                value={password} onChange={(e) => setPassword(e.target.value)}
                            />
                        </div>

                        {error && (
                            <div className="text-vr-red text-sm bg-vr-red/10 p-3 rounded-xl border border-vr-red/20 font-medium">
                                {error}
                            </div>
                        )}

                        <button
                            type="submit" disabled={loading}
                            className="w-full bg-gold-gradient text-navy py-3.5 rounded-xl font-extrabold text-base hover:brightness-110 transition-all disabled:opacity-40 mt-2"
                        >
                            {loading ? 'Creando negocio...' : 'Crear cuenta gratis'}
                        </button>
                    </form>

                    <p className="mt-6 text-sm text-vr-gray">
                        ¿Ya tienes cuenta?{' '}
                        <Link href="/login" className="text-gold hover:text-gold-2 font-bold transition-colors">
                            Inicia sesión
                        </Link>
                    </p>

                    <p className="mt-4 text-xs text-vr-gray/60 leading-relaxed">
                        Al crear tu cuenta aceptas que VentaRD guarde los datos de tu negocio
                        para ofrecer el servicio.
                    </p>
                </div>
            </div>
        </div>
    );
}
