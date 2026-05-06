'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import Link from 'next/link';
import { useConfigStore } from '@/store/useConfigStore';
import { ShoppingCart, Check, WifiOff } from 'lucide-react';

const FEATURES = [
    'Funciona sin internet — todo guardado en el dispositivo',
    'Sincroniza automáticamente cuando vuelve la señal',
    'Historial, inventario y fiados en un solo lugar',
];

export default function LoginPage() {
    const { isOnline } = useConfigStore();

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        const { error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            if (error.message.includes('Failed to fetch')) {
                setError('Sin conexión a internet. No pudimos verificar tus credenciales.');
            } else {
                setError('Credenciales inválidas o correo no confirmado.');
            }
            setLoading(false);
        }
        // El AuthProvider hace el resto de la magia
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
                        El POS que no se cae<br />
                        <span className="text-gold">cuando se va la luz.</span>
                    </h2>
                    <p className="text-vr-gray text-base leading-relaxed mb-10">
                        Vende, registra fiados y cuadra caja aunque no haya internet.
                        Todo sincroniza solo cuando vuelve la señal.
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

                    {/* Offline badge */}
                    <div className="mt-10 inline-flex items-center gap-2 bg-gold/8 border border-gold/20 rounded-full px-3 py-1.5">
                        <WifiOff className="w-3.5 h-3.5 text-gold" />
                        <span className="text-gold text-xs font-bold">Funciona sin internet — de verdad</span>
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
                        <h1 className="text-2xl font-display font-black text-white mb-1">Inicia sesión</h1>
                        <p className="text-vr-gray text-sm">Bienvenido de vuelta a tu punto de venta</p>
                    </div>

                    <form onSubmit={handleLogin} className="space-y-4">
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
                                type="password" required autoComplete="current-password"
                                className="w-full px-4 py-3 bg-navy-2 border border-navy-3 rounded-xl text-white focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
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
                            {loading ? 'Entrando...' : 'Ingresar al POS'}
                        </button>
                    </form>

                    <div className="mt-6 space-y-3 text-sm">
                        <div>
                            <Link href="/recuperar-contrasena" className="text-vr-gray hover:text-white transition-colors">
                                ¿Olvidaste tu contraseña?
                            </Link>
                        </div>
                        <div className="text-vr-gray">
                            ¿No tienes una cuenta?{' '}
                            <Link href="/registro" className="text-gold hover:text-gold-2 font-bold transition-colors">
                                Crea tu negocio aquí
                            </Link>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
