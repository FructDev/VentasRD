'use client';

// Componente separado para aislar useSearchParams() en su propio Suspense boundary.
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import Link from 'next/link';

type Status = 'loading' | 'success' | 'error';

export default function ConfirmHandler() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const [status, setStatus] = useState<Status>('loading');
    const [errorMsg, setErrorMsg] = useState('');

    useEffect(() => {
        const tokenHash = searchParams.get('token_hash');
        const type = searchParams.get('type') as 'email' | 'recovery' | null;

        if (!tokenHash || !type) {
            setStatus('error');
            setErrorMsg('El enlace no es válido o ya fue utilizado.');
            return;
        }

        supabase.auth.verifyOtp({ token_hash: tokenHash, type })
            .then(({ error }) => {
                if (error) {
                    setStatus('error');
                    setErrorMsg(error.message.includes('expired')
                        ? 'El enlace expiró. Solicita uno nuevo desde la página de registro.'
                        : error.message
                    );
                } else {
                    setStatus('success');
                    // Cerrar la sesión que abre verifyOtp para que el usuario haga login limpio
                    supabase.auth.signOut().finally(() => {
                        setTimeout(() => router.push('/login?confirmed=true'), 1800);
                    });
                }
            });
    }, [searchParams, router]);

    if (status === 'loading') {
        return (
            <>
                <div className="w-12 h-12 border-4 border-gold border-t-transparent rounded-full animate-spin mx-auto mb-5" />
                <p className="text-vr-gray font-medium">Verificando tu correo...</p>
            </>
        );
    }

    if (status === 'success') {
        return (
            <>
                <div className="w-16 h-16 bg-vr-green/15 border border-vr-green/30 rounded-2xl flex items-center justify-center mx-auto mb-5 text-3xl">
                    ✅
                </div>
                <h2 className="text-xl font-display font-bold text-white mb-2">¡Correo confirmado!</h2>
                <p className="text-vr-gray text-sm">Redirigiendo al inicio de sesión...</p>
            </>
        );
    }

    return (
        <>
            <div className="w-16 h-16 bg-vr-red/15 border border-vr-red/30 rounded-2xl flex items-center justify-center mx-auto mb-5 text-3xl">
                ❌
            </div>
            <h2 className="text-xl font-display font-bold text-white mb-2">Enlace inválido</h2>
            <p className="text-vr-gray text-sm mb-6">{errorMsg}</p>
            <Link href="/registro" className="text-gold hover:text-gold-2 font-bold transition-colors text-sm">
                Volver al registro →
            </Link>
        </>
    );
}
