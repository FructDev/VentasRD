// src/app/auth/confirm/page.tsx
// Página de destino del enlace de confirmación de correo que envía Supabase.
// Verifica el token y redirige al login con un mensaje de éxito.
import { Suspense } from 'react';
import ConfirmHandler from './ConfirmHandler';
import { ShoppingCart } from 'lucide-react';

export default function AuthConfirmPage() {
    return (
        <div className="min-h-screen flex items-center justify-center bg-navy p-4">
            <div className="max-w-sm w-full text-center">
                {/* Logo */}
                <div className="flex items-center justify-center gap-2.5 mb-10">
                    <div className="w-8 h-8 bg-gold rounded-lg flex items-center justify-center">
                        <ShoppingCart className="w-4 h-4 text-navy" />
                    </div>
                    <span className="font-display font-extrabold text-lg text-white">VentaRD</span>
                </div>

                <Suspense fallback={<LoadingState />}>
                    <ConfirmHandler />
                </Suspense>
            </div>
        </div>
    );
}

function LoadingState() {
    return (
        <>
            <div className="w-12 h-12 border-4 border-gold border-t-transparent rounded-full animate-spin mx-auto mb-5" />
            <p className="text-vr-gray font-medium">Verificando tu correo...</p>
        </>
    );
}
