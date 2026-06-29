// src/components/shared/TopBar.tsx
'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db/dexie';
import { supabase } from '@/lib/supabase/client';
import { ACCESOS } from '@/lib/acceso';
import ConfirmModal from '@/components/ui/ConfirmModal';

const navItems = [
    { href: '/',              label: 'Ventas',       icon: '💰' },
    { href: '/historial',     label: 'Historial',    icon: '🗒️' },
    { href: '/inventario',    label: 'Inventario',   icon: '📦' },
    { href: '/reparaciones',  label: 'Reparaciones', icon: '🔧', soloPro: true },
    { href: '/garantias',     label: 'Garantías',    icon: '🛡️', soloPro: true },
    { href: '/apartados',     label: 'Apartados',    icon: '🔖', soloPro: true },
    { href: '/clientes',      label: 'Clientes',     icon: '👥' },
    { href: '/gastos',        label: 'Gastos',       icon: '💸' },
    { href: '/dashboard',     label: 'Resumen',      icon: '📊' },
    { href: '/reportes',      label: 'Reportes',     icon: '📁' },
    { href: '/configuracion', label: 'Ajustes',      icon: '⚙️' },
    { href: '/admin',         label: 'Admin',        icon: '🛠️', soloAdmin: true },
];

const ROL_LABEL: Record<string, string> = { admin: 'Admin', vendedor: 'Vendedor', cajero: 'Cajero', dueño: 'Dueño' };

export default function TopBar() {
    const pathname = usePathname();
    const router = useRouter();
    const { isOnline, isAdminMode, negocioNombre, rolUsuario, nombreUsuario, planTier, tema, setTema, cerrarSesionUsuario } = useConfigStore();

    const [menuOpen, setMenuOpen] = useState(false);
    const [confirmLogout, setConfirmLogout] = useState(false);

    const ventasPendientes = useLiveQuery(
        () => db.ventas.where('estado_sincronizacion').equals(0).count(),
        []
    ) || 0;

    // Nombre y rol a mostrar: empleado usa su nombre; el dueño no tiene nombreUsuario
    const displayNombre = nombreUsuario || negocioNombre || 'Mi cuenta';
    const displayRol = nombreUsuario ? (ROL_LABEL[rolUsuario] || 'Cajero') : 'Dueño';
    const inicial = (displayNombre.trim()[0] || '?').toUpperCase();

    const cerrarSesion = async () => {
        setConfirmLogout(false);
        setMenuOpen(false);
        // Cierra la sesión en Supabase (si falla por estar offline, igual seguimos)
        try { await supabase.auth.signOut(); } catch { /* offline */ }
        cerrarSesionUsuario(); // limpia el usuario del estado, conserva el cache del negocio
        router.push('/login');
    };

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
                    const rutasPermitidas = ACCESOS[rolUsuario] ?? ACCESOS.cajero;
                    if (!rutasPermitidas.includes(item.href)) return null;
                    if (item.soloAdmin && !isAdminMode) return null;
                    if (item.soloPro && planTier !== 'pro') return null;

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

                {/* Menú de usuario — disponible para todos (incluido cajero/vendedor) */}
                <div className="relative">
                    <button
                        onClick={() => setMenuOpen(v => !v)}
                        className="flex items-center gap-1.5 pl-1 pr-1 sm:pr-2 py-1 rounded-lg hover:bg-navy-3 transition-colors"
                        aria-label="Menú de usuario"
                    >
                        <span className="w-8 h-8 rounded-full bg-gold/20 text-gold font-black flex items-center justify-center text-sm shrink-0">{inicial}</span>
                        <span className="hidden sm:block text-left">
                            <span className="block text-xs font-bold text-white leading-tight truncate max-w-[90px]">{displayNombre}</span>
                            <span className="block text-[10px] text-vr-gray leading-tight">{displayRol}</span>
                        </span>
                    </button>

                    {menuOpen && (
                        <>
                            {/* Backdrop para cerrar al tocar afuera */}
                            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                            <div className="absolute right-0 mt-2 w-52 bg-navy-2 border border-navy-3 rounded-xl shadow-2xl overflow-hidden z-50 animate-fade-in">
                                <div className="px-4 py-3 border-b border-navy-3">
                                    <p className="text-sm font-bold text-white truncate">{displayNombre}</p>
                                    <p className="text-xs text-vr-gray">{displayRol}</p>
                                </div>
                                <button
                                    onClick={() => setTema(tema === 'claro' ? 'oscuro' : 'claro')}
                                    className="w-full text-left px-4 py-3 text-sm font-bold text-vr-gray hover:text-white hover:bg-navy-3 transition-colors flex items-center gap-2 border-b border-navy-3"
                                >
                                    <span>{tema === 'claro' ? '🌙' : '☀️'}</span> {tema === 'claro' ? 'Tema oscuro' : 'Tema claro'}
                                </button>
                                <button
                                    onClick={() => { setMenuOpen(false); setConfirmLogout(true); }}
                                    className="w-full text-left px-4 py-3 text-sm font-bold text-vr-red hover:bg-vr-red/10 transition-colors flex items-center gap-2"
                                >
                                    <span>🚪</span> Cerrar sesión
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>

            <ConfirmModal
                isOpen={confirmLogout}
                title="Cerrar sesión"
                mensaje={<>¿Seguro que quieres salir? Necesitarás <span className="font-bold text-white">conexión a internet</span> para volver a iniciar sesión.</>}
                confirmLabel="Cerrar sesión"
                onConfirm={cerrarSesion}
                onClose={() => setConfirmLogout(false)}
            />
        </header>
    );
}
