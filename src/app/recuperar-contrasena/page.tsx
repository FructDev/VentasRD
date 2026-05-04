'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

export default function RecuperarContrasenaPage() {
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [enviado, setEnviado] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${window.location.origin}/actualizar-contrasena`,
        });

        if (error) {
            setError('No pudimos enviar el correo. Verifica que el email esté correcto.');
            setLoading(false);
        } else {
            setEnviado(true);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-navy p-4">
            <div className="max-w-md w-full bg-navy-2 p-8 rounded-2xl border border-navy-3 shadow-2xl">
                <Link
                    href="/login"
                    className="inline-flex items-center gap-1 text-vr-gray hover:text-white text-sm font-medium transition-colors mb-6"
                >
                    <ChevronLeft className="w-4 h-4" />
                    Volver al login
                </Link>

                {enviado ? (
                    <div className="text-center">
                        <div className="w-16 h-16 bg-vr-green/10 border border-vr-green/30 rounded-2xl flex items-center justify-center mx-auto mb-4 text-3xl">
                            ✉️
                        </div>
                        <h1 className="text-2xl font-display font-extrabold text-white mb-2">
                            Revisa tu correo
                        </h1>
                        <p className="text-vr-gray text-sm leading-relaxed">
                            Si <span className="text-white font-semibold">{email}</span> está registrado,
                            recibirás un enlace para restablecer tu contraseña en los próximos minutos.
                            Revisa también tu carpeta de spam.
                        </p>
                    </div>
                ) : (
                    <>
                        <div className="mb-8">
                            <h1 className="text-2xl font-display font-extrabold text-white mb-2">
                                Recuperar contraseña
                            </h1>
                            <p className="text-vr-gray text-sm">
                                Ingresa tu correo y te enviamos un enlace para crear una nueva contraseña.
                            </p>
                        </div>

                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-vr-gray mb-1.5">
                                    Correo Electrónico
                                </label>
                                <input
                                    type="email"
                                    required
                                    autoFocus
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all"
                                    placeholder="tu@correo.com"
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
                                {loading ? 'Enviando...' : 'Enviar enlace de recuperación'}
                            </button>
                        </form>
                    </>
                )}
            </div>
        </div>
    );
}
