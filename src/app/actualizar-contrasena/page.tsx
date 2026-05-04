'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

export default function ActualizarContrasenaPage() {
    const router = useRouter();
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [listo, setListo] = useState(false);
    const [sessionReady, setSessionReady] = useState(false);

    useEffect(() => {
        // Supabase envía el token en el hash de la URL.
        // onAuthStateChange con evento PASSWORD_RECOVERY detecta la sesión automáticamente.
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
            if (event === 'PASSWORD_RECOVERY') {
                setSessionReady(true);
            }
        });
        return () => subscription.unsubscribe();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (password !== confirm) {
            setError('Las contraseñas no coinciden.');
            return;
        }
        if (password.length < 6) {
            setError('La contraseña debe tener al menos 6 caracteres.');
            return;
        }

        setLoading(true);
        setError(null);

        const { error } = await supabase.auth.updateUser({ password });

        if (error) {
            setError('No pudimos actualizar la contraseña. El enlace puede haber expirado.');
            setLoading(false);
        } else {
            setListo(true);
            setTimeout(() => router.push('/'), 2500);
        }
    };

    if (!sessionReady) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-navy p-4">
                <div className="max-w-md w-full bg-navy-2 p-8 rounded-2xl border border-navy-3 text-center">
                    <div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                    <p className="text-vr-gray">Verificando enlace...</p>
                    <p className="text-vr-gray text-xs mt-2">
                        Si este mensaje no desaparece, el enlace puede haber expirado.{' '}
                        <a href="/recuperar-contrasena" className="text-gold hover:underline">
                            Solicitar uno nuevo
                        </a>
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-navy p-4">
            <div className="max-w-md w-full bg-navy-2 p-8 rounded-2xl border border-navy-3 shadow-2xl">
                {listo ? (
                    <div className="text-center">
                        <div className="w-16 h-16 bg-vr-green/10 border border-vr-green/30 rounded-2xl flex items-center justify-center mx-auto mb-4 text-3xl">
                            ✓
                        </div>
                        <h1 className="text-2xl font-display font-extrabold text-white mb-2">
                            Contraseña actualizada
                        </h1>
                        <p className="text-vr-gray text-sm">Redirigiendo al POS...</p>
                    </div>
                ) : (
                    <>
                        <div className="mb-8">
                            <h1 className="text-2xl font-display font-extrabold text-white mb-2">
                                Nueva contraseña
                            </h1>
                            <p className="text-vr-gray text-sm">
                                Elige una contraseña segura para tu cuenta.
                            </p>
                        </div>

                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-vr-gray mb-1.5">
                                    Nueva contraseña
                                </label>
                                <input
                                    type="password"
                                    required
                                    autoFocus
                                    minLength={6}
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-vr-gray mb-1.5">
                                    Confirmar contraseña
                                </label>
                                <input
                                    type="password"
                                    required
                                    minLength={6}
                                    value={confirm}
                                    onChange={(e) => setConfirm(e.target.value)}
                                    className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                                />
                            </div>

                            {error && (
                                <div className="text-vr-red text-sm bg-vr-red/10 p-3 rounded-xl border border-vr-red/20 font-medium">
                                    {error}
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full bg-gold-gradient text-navy py-3.5 rounded-xl font-extrabold text-base hover:brightness-110 transition-all disabled:opacity-40"
                            >
                                {loading ? 'Guardando...' : 'Guardar nueva contraseña'}
                            </button>
                        </form>
                    </>
                )}
            </div>
        </div>
    );
}
