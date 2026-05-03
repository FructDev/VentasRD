'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import Link from 'next/link';

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

        const { data, error: signUpError } = await supabase.auth.signUp({
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
                <div className="max-w-md w-full bg-navy-2 p-8 rounded-2xl border border-navy-3 text-center shadow-2xl">
                    <div className="w-16 h-16 bg-vr-green/15 text-vr-green rounded-full flex items-center justify-center mx-auto mb-4 text-3xl border border-vr-green/30">📧</div>
                    <h2 className="text-2xl font-display font-bold text-white mb-2">¡Revisa tu correo!</h2>
                    <p className="text-vr-gray mb-6">
                        Te hemos enviado un enlace de confirmación a <strong className="text-white">{email}</strong>.
                        Haz clic en él para activar tu negocio y continuar.
                    </p>
                    <Link href="/login" className="text-gold hover:text-gold-2 font-bold transition-colors">
                        Ir al inicio de sesión
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-navy p-4">
            <div className="max-w-md w-full bg-navy-2 p-8 rounded-2xl border border-navy-3 shadow-2xl">
                <div className="text-center mb-8">
                    <h1 className="text-4xl font-display font-extrabold text-gold mb-2">VentaRD</h1>
                    <p className="text-vr-gray">Configura tu POS en segundos</p>
                </div>

                <form onSubmit={handleRegistro} className="space-y-4">
                    <div>
                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Nombre del Negocio</label>
                        <input type="text" required className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all" value={nombreNegocio} onChange={(e) => setNombreNegocio(e.target.value)} />
                    </div>
                    <div>
                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Correo Electrónico</label>
                        <input type="email" required className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all" value={email} onChange={(e) => setEmail(e.target.value)} />
                    </div>
                    <div>
                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Contraseña</label>
                        <input type="password" required minLength={6} className="w-full px-4 py-3 bg-navy-3 border border-navy-3 rounded-xl text-white focus:border-gold focus:ring-1 focus:ring-gold/30 outline-none transition-all" value={password} onChange={(e) => setPassword(e.target.value)} />
                    </div>

                    {error && <div className="text-vr-red text-sm bg-vr-red/10 p-3 rounded-xl border border-vr-red/20 font-medium">{error}</div>}

                    <button type="submit" disabled={loading} className="w-full bg-gold-gradient text-navy py-3.5 rounded-xl font-extrabold text-lg hover:brightness-110 transition-all disabled:opacity-40 mt-2">
                        {loading ? 'Creando negocio...' : 'Registrar Negocio'}
                    </button>
                </form>

                <p className="mt-4 text-center text-sm text-vr-gray">
                    ¿Ya tienes cuenta? <Link href="/login" className="text-gold hover:text-gold-2 font-bold transition-colors">Inicia sesión</Link>
                </p>
            </div>
        </div>
    );
}