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

    // Contar ventas pendientes de sync
    const ventasPendientes = useLiveQuery(
        () => db.ventas.where('estado_sincronizacion').equals(0).count(),
        []
    ) || 0;

    return (
        <header className="bg-navy-2 border-b border-navy-3 px-4 py-0 flex items-center justify-between h-14 shrink-0 z-40">
            {/* Logo + Nombre del negocio */}
            <Link href="/" className="flex items-center gap-2.5 shrink-0">
                <span className="font-display font-extrabold text-xl text-gold tracking-tight">VentaRD</span>
                {negocioNombre && (
                    <>
                        <span className="text-navy-3 text-lg">|</span>
                        <span className="text-vr-gray text-sm font-semibold truncate max-w-[160px]">{negocioNombre}</span>
                    </>
                )}
            </Link>

            {/* Navegación central */}
            <nav className="flex items-center gap-1 mx-4 overflow-x-auto">
                {navItems.map(item => {
                    const isActive = pathname === item.href;
                    if (item.requiresAdmin && !isAdminMode) return null;

                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={`
                                flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-all whitespace-nowrap
                                ${isActive
                                    ? 'bg-gold/15 text-gold'
                                    : 'text-vr-gray hover:text-white hover:bg-navy-3'
                                }
                            `}
                        >
                            <span className="text-base">{item.icon}</span>
                            <span className="hidden md:inline">{item.label}</span>
                        </Link>
                    );
                })}
            </nav>

            {/* Estado derecho */}
            <div className="flex items-center gap-3 shrink-0">
                {/* Ventas Pendientes */}
                {ventasPendientes > 0 && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-gold/10 border border-gold/20 rounded-lg">
                        <div className="w-2 h-2 rounded-full bg-gold animate-pulse" />
                        <span className="text-xs font-bold text-gold">{ventasPendientes} pendiente{ventasPendientes > 1 ? 's' : ''}</span>
                    </div>
                )}

                {/* Indicador Online/Offline */}
                <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold ${
                    isOnline
                        ? 'bg-vr-green/10 border-vr-green/20 text-vr-green'
                        : 'bg-vr-red/10 border-vr-red/20 text-vr-red'
                }`}>
                    <div className={`w-2 h-2 rounded-full ${isOnline ? 'bg-vr-green' : 'bg-vr-red animate-pulse'}`} />
                    {isOnline ? 'Online' : 'Offline'}
                </div>
            </div>
        </header>
    );
}
