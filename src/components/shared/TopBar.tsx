// src/components/shared/TopBar.tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useConfigStore } from '@/store/useConfigStore';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db/dexie';

const navItems = [
    { href: '/', label: 'Ventas', icon: '💰' },
    { href: '/historial', label: 'Historial', icon: '🗒️' },
    { href: '/inventario', label: 'Inventario', icon: '📦' },
    { href: '/clientes', label: 'Clientes', icon: '👥' },
    { href: '/dashboard', label: 'Resumen', icon: '📊' },
    { href: '/configuracion', label: 'Ajustes', icon: '⚙️', requiresAdmin: true },
    { href: '/admin', label: 'Admin', icon: '🛠️', requiresAdmin: true },
];

export default function TopBar() {
    const pathname = usePathname();
    const { isOnline, isAdminMode, negocioNombre } = useConfigStore();

    const ventasPendientes = useLiveQuery(
        () => db.ventas.where('estado_sincronizacion').equals(0).count(),
        []
    ) || 0;

    return (
        <header className="bg-navy-2 border-b border-navy-3 px-2 sm:px-4 py-0 flex items-center justify-between h-14 shrink-0 z-40">
            {/* Logo */}
            <Link href="/" className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
                <span className="font-display font-extrabold text-lg sm:text-xl text-gold tracking-tight">VentaRD</span>
                {negocioNombre && (
                    <>
                        <span className="hidden sm:inline text-navy-3 text-lg">|</span>
                        <span className="hidden sm:inline text-vr-gray text-sm font-semibold truncate max-w-[140px]">{negocioNombre}</span>
                    </>
                )}
            </Link>

            {/* Navegación central */}
            <nav className="flex items-center gap-0.5 sm:gap-1 mx-1 sm:mx-4 overflow-x-auto scrollbar-none">
                {navItems.map(item => {
                    const isActive = pathname === item.href;
                    if (item.requiresAdmin && !isAdminMode) return null;

                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={`
                                flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all whitespace-nowrap
                                ${isActive
                                    ? 'bg-gold/15 text-gold'
                                    : 'text-vr-gray hover:text-white hover:bg-navy-3'
                                }
                            `}
                        >
                            <span className="text-sm sm:text-base">{item.icon}</span>
                            <span className="hidden md:inline">{item.label}</span>
                        </Link>
                    );
                })}
            </nav>

            {/* Estado derecho */}
            <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
                {/* Ventas Pendientes */}
                {ventasPendientes > 0 && (
                    <div className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1.5 bg-gold/10 border border-gold/20 rounded-lg">
                        <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-gold animate-pulse" />
                        <span className="text-xs font-bold text-gold hidden sm:inline">{ventasPendientes} pendiente{ventasPendientes > 1 ? 's' : ''}</span>
                        <span className="text-xs font-bold text-gold sm:hidden">{ventasPendientes}</span>
                    </div>
                )}

                {/* Online/Offline */}
                <div className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg border text-xs font-bold ${
                    isOnline
                        ? 'bg-vr-green/10 border-vr-green/20 text-vr-green'
                        : 'bg-vr-red/10 border-vr-red/20 text-vr-red'
                }`}>
                    <div className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${isOnline ? 'bg-vr-green' : 'bg-vr-red animate-pulse'}`} />
                    <span className="hidden sm:inline">{isOnline ? 'Online' : 'Offline'}</span>
                </div>
            </div>
        </header>
    );
}
