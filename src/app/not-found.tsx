import Link from 'next/link';
import { ShoppingCart } from 'lucide-react';

export default function NotFound() {
    return (
        <div className="min-h-screen bg-navy flex items-center justify-center p-6">
            <div className="text-center max-w-md">
                <div className="w-16 h-16 bg-gold/10 border border-gold/30 rounded-2xl flex items-center justify-center mx-auto mb-6">
                    <ShoppingCart className="w-8 h-8 text-gold" />
                </div>

                <p className="text-gold font-mono font-bold text-sm mb-3 tracking-widest">404</p>
                <h1 className="text-3xl font-display font-black text-white mb-3">
                    Esta página no existe
                </h1>
                <p className="text-vr-gray mb-8">
                    Puede que la URL esté mal escrita o que la página haya sido movida.
                </p>

                <Link
                    href="/"
                    className="inline-flex items-center gap-2 bg-gold-gradient text-navy px-6 py-3 rounded-xl font-extrabold hover:brightness-110 transition-all"
                >
                    Volver al POS
                </Link>
            </div>
        </div>
    );
}
