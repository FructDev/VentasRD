'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import Link from 'next/link';
import { useConfigStore } from '@/store/useConfigStore';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
    const router = useRouter();
    const { isOnline, negocioId, pinAdmin, setOfflineUnlock } = useConfigStore();
    
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        const { error } = await supabase.auth.signInWithPassword({
            email,
            password,
        });

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
        <div className="min-h-screen flex items-center justify-center bg-navy p-4">
            <div className="max-w-md w-full bg-navy-2 p-8 rounded-2xl border border-navy-3 shadow-2xl">
                <div className="text-center mb-8">
                    <h1 className="text-4xl font-display font-extrabold text-gold mb-2">VentaRD</h1>
                    <p className="text-vr-gray">Inicia sesión en tu punto de venta</p>
                </div>

                <form onSubmit={handleLogin} className="space-y-4">
                    <div>
                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Correo Electrónico</label>
                        <input
                            type="email" required
                            className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                            value={email} onChange={(e) => setEmail(e.target.value)}
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Contraseña</label>
                        <input
                            type="password" required
                            className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                            value={password} onChange={(e) => setPassword(e.target.value)}
                        />
                    </div>

                    {error && <div className="text-vr-red text-sm bg-vr-red/10 p-3 rounded-xl border border-vr-red/20 font-medium">{error}</div>}

                    <button
                        type="submit" disabled={loading}
                        className="w-full bg-gold-gradient text-navy py-3.5 rounded-xl font-extrabold text-lg hover:brightness-110 transition-all disabled:opacity-40 mt-2"
                    >
                        {loading ? 'Entrando...' : 'Ingresar al POS'}
                    </button>
                </form>

                <div className="mt-6 space-y-3 text-center text-sm">
                    <div>
                        <Link
                            href="/recuperar-contrasena"
                            className="text-vr-gray hover:text-white transition-colors"
                        >
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
    );
}