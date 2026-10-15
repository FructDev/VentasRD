'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';

function UnirsePage() {
    const searchParams = useSearchParams();
    const token = searchParams.get('token');
    return <InvitationContent key={token} token={token} />;
}

function InvitationContent({ token }: { token: string | null }) {
    const router = useRouter();

    const [estado, setEstado] = useState<'cargando' | 'listo' | 'error' | 'exito'>('cargando');
    const [empleado, setEmpleado] = useState<{ nombre: string; email: string } | null>(null);
    const [password, setPassword] = useState('');
    const [password2, setPassword2] = useState('');
    const [enviando, setEnviando] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');
    const [existingAccount, setExistingAccount] = useState(false);

    // Verificar token contra nuestra API (server-side, evita problemas de RLS)
    useEffect(() => {
        if (!token) return;
        const controller = new AbortController();

        fetch(`/api/usuarios/activar?token=${encodeURIComponent(token)}`, { cache: 'no-store', signal: controller.signal })
            .then(r => r.json())
            .then(data => {
                if (controller.signal.aborted) return;
                if (data.error) { setEstado('error'); return; }
                setEmpleado({ nombre: data.nombre, email: data.email });
                setEstado('listo');
            })
            .catch(() => { if (!controller.signal.aborted) setEstado('error'); });
        return () => controller.abort();
    }, [token]);

    const registrar = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!empleado || !token) return;
        if (password.length < 6) { setErrorMsg('La contraseña debe tener al menos 6 caracteres.'); return; }
        if (!existingAccount && password !== password2) { setErrorMsg('Las contraseñas no coinciden.'); return; }

        setEnviando(true);
        setErrorMsg('');

        try {
            let tokenHeader: Record<string, string> = {};
            if (existingAccount) {
                const { data, error } = await supabase.auth.signInWithPassword({ email: empleado.email, password });
                if (error || !data.session) throw new Error('No se pudo iniciar sesión con ese correo y contraseña.');
                tokenHeader = { Authorization: 'Bearer ' + data.session.access_token };
            }
            const res = await fetch(existingAccount ? '/api/usuarios/vincular' : '/api/usuarios/activar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...tokenHeader },
                body: JSON.stringify(existingAccount ? { token } : { token, password }),
            });
            const data = await res.json();
            if (!res.ok) {
                if (data.code === 'ACCOUNT_EXISTS' || data.code === 'SIGN_IN_TO_RECOVER') setExistingAccount(true);
                throw new Error(data.error);
            }

            setEstado('exito');

            // Iniciar sesión automáticamente con las credenciales recién creadas
            if (!existingAccount) await supabase.auth.signInWithPassword({ email: empleado.email, password });
            setTimeout(() => router.push('/'), 1500);
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : 'Error al crear la cuenta.');
        } finally {
            setEnviando(false);
        }
    };

    return (
        <div className="min-h-screen bg-navy flex items-center justify-center p-4">
            <div className="w-full max-w-sm">
                <div className="text-center mb-8">
                    <h1 className="text-3xl font-display font-extrabold text-gold">VentaRD</h1>
                    <p className="text-vr-gray text-sm mt-1">Activación de cuenta</p>
                </div>

                {estado === 'cargando' && token && (
                    <div className="text-center text-vr-gray">
                        <div className="w-10 h-10 border-4 border-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                        <p className="animate-pulse">Verificando invitación…</p>
                    </div>
                )}

                {(estado === 'error' || !token) && (
                    <div className="bg-navy-2 rounded-2xl border border-vr-red/30 p-8 text-center">
                        <p className="text-5xl mb-4">❌</p>
                        <h2 className="text-white font-bold text-lg mb-2">Link inválido</h2>
                        <p className="text-vr-gray text-sm leading-relaxed">
                            Este link ya fue utilizado o expiró.<br />
                            Pide al administrador que genere uno nuevo.
                        </p>
                    </div>
                )}

                {estado === 'exito' && (
                    <div className="bg-navy-2 rounded-2xl border border-vr-green/30 p-8 text-center animate-scale-in">
                        <p className="text-5xl mb-4">✅</p>
                        <h2 className="text-white font-bold text-lg mb-2">¡Bienvenido!</h2>
                        <p className="text-vr-gray text-sm">Entrando al sistema…</p>
                    </div>
                )}

                {estado === 'listo' && empleado && (
                    <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden animate-scale-in">
                        <div className="p-5 border-b border-navy-3">
                            <h2 className="text-xl font-display font-bold text-white">{existingAccount ? 'Acepta la invitación' : 'Crea tu contraseña'}</h2>
                            <p className="text-vr-gray text-sm mt-0.5">
                                Hola, <span className="text-white font-bold">{empleado.nombre}</span>
                            </p>
                        </div>
                        <form onSubmit={registrar} className="p-5 space-y-4">
                            {/* Email de solo lectura */}
                            <div>
                                <label className="block text-xs font-bold text-vr-gray mb-1.5 uppercase tracking-wider">Tu usuario</label>
                                <div className="w-full bg-navy-3/40 border border-navy-3 rounded-xl p-3 text-vr-gray font-mono text-sm">
                                    {empleado.email}
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-vr-gray mb-1.5 uppercase tracking-wider">Contraseña *</label>
                                <input
                                    type="password"
                                    required
                                    autoFocus
                                    minLength={6}
                                    placeholder="Mínimo 6 caracteres"
                                    className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all"
                                    value={password}
                                    onChange={e => setPassword(e.target.value)}
                                />
                            </div>

                            {!existingAccount && <div>
                                <label className="block text-xs font-bold text-vr-gray mb-1.5 uppercase tracking-wider">Confirmar contraseña *</label>
                                <input
                                    type="password"
                                    required
                                    placeholder="Repite la contraseña"
                                    className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all"
                                    value={password2}
                                    onChange={e => setPassword2(e.target.value)}
                                />
                            </div>}

                            {errorMsg && (
                                <div className="text-vr-red text-sm font-bold bg-vr-red/10 p-3 rounded-xl border border-vr-red/20">
                                    {errorMsg}
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={enviando}
                                className="w-full py-4 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-50 text-base"
                            >
                                {enviando ? 'Comprobando cuenta…' : 'Entrar al sistema →'}
                            </button>
                            <button type="button" disabled={enviando} onClick={() => { setExistingAccount(v => !v); setErrorMsg(''); }} className="w-full py-2 text-sm text-vr-gray hover:text-gold">
                                {existingAccount ? 'Crear una cuenta nueva' : 'Ya tengo una cuenta con este correo'}
                            </button>
                        </form>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function UnirsePageWrapper() {
    return (
        <Suspense fallback={
            <div className="min-h-screen bg-navy flex items-center justify-center">
                <div className="w-10 h-10 border-4 border-gold border-t-transparent rounded-full animate-spin" />
            </div>
        }>
            <UnirsePage />
        </Suspense>
    );
}
