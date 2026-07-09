// src/components/shared/PaginaLegal.tsx
// Cascarón compartido de las páginas públicas de texto (términos, privacidad, ayuda).
import Link from 'next/link';
import { ShoppingCart } from 'lucide-react';

export default function PaginaLegal({ titulo, actualizado, children }: {
    titulo: string;
    actualizado?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="min-h-screen bg-navy text-white">
            <nav className="border-b border-white/5 bg-navy/80 backdrop-blur-md sticky top-0 z-50">
                <div className="max-w-3xl mx-auto px-6 h-16 flex items-center justify-between">
                    <Link href="/landing" className="flex items-center gap-2.5">
                        <div className="w-8 h-8 bg-gold rounded-lg flex items-center justify-center">
                            <ShoppingCart className="w-4 h-4 text-navy" />
                        </div>
                        <span className="font-display font-extrabold text-lg tracking-tight">VentaRD</span>
                    </Link>
                    <Link href="/registro" className="text-sm bg-gold text-navy px-4 py-2 rounded-lg font-bold hover:bg-gold/90 transition-colors">
                        Empezar gratis
                    </Link>
                </div>
            </nav>
            <main className="max-w-3xl mx-auto px-6 py-12">
                <h1 className="font-display font-extrabold text-3xl md:text-4xl mb-2">{titulo}</h1>
                {actualizado && <p className="text-vr-gray text-sm mb-10">Última actualización: {actualizado}</p>}
                <div className="space-y-8 text-[15px] leading-relaxed text-vr-gray [&_h2]:font-display [&_h2]:font-bold [&_h2]:text-xl [&_h2]:text-white [&_h2]:mb-3 [&_b]:text-white [&_a]:text-gold [&_a]:underline [&_li]:mb-2">
                    {children}
                </div>
            </main>
            <footer className="border-t border-white/5 py-8 text-center text-xs text-vr-gray">
                © {new Date().getFullYear()} VentaRD · República Dominicana ·{' '}
                <Link href="/terminos" className="text-gold hover:underline">Términos</Link> ·{' '}
                <Link href="/privacidad" className="text-gold hover:underline">Privacidad</Link> ·{' '}
                <Link href="/ayuda" className="text-gold hover:underline">Ayuda</Link>
            </footer>
        </div>
    );
}
