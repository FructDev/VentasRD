'use client';

import { useEffect, useState, useMemo } from 'react';
import { ShoppingCart, RefreshCw, MessageCircle, Check, X, Clock, Users, AlertCircle, Search, Lock, Eye, EyeOff } from 'lucide-react';

interface Negocio {
    id: string;
    nombre: string;
    email: string;
    telefono: string | null;
    tipo_negocio: string | null;
    whatsapp_dueno: string | null;
    plan_activo: boolean;
    trial_hasta: number | null;
    onboarding_completado: boolean;
    created_at: string;
}

function getEstado(n: Negocio): { label: string; color: string } {
    const ahora = Date.now();
    if (n.plan_activo) return { label: 'Activo', color: 'text-vr-green bg-vr-green/10 border-vr-green/20' };
    if (n.trial_hasta && ahora < n.trial_hasta) {
        const dias = Math.ceil((n.trial_hasta - ahora) / 86400000);
        return { label: `Trial · ${dias}d`, color: 'text-gold bg-gold/10 border-gold/20' };
    }
    if (n.trial_hasta && ahora >= n.trial_hasta) return { label: 'Vencido', color: 'text-vr-red bg-vr-red/10 border-vr-red/20' };
    return { label: 'Sin activar', color: 'text-vr-gray bg-white/5 border-white/10' };
}

const TIPOS: Record<string, string> = {
    colmado: 'Colmado',
    tienda_ropa: 'Tienda ropa',
    ferreteria: 'Ferretería',
    restaurante: 'Restaurante',
    servicios: 'Servicios',
    otro: 'Otro',
};

const SESSION_KEY = 'vrd_sa_secret';

// ── Login screen ─────────────────────────────────────────────────────────────
function LoginPanel({ onUnlock }: { onUnlock: (secret: string) => void }) {
    const [value, setValue] = useState('');
    const [show, setShow] = useState(false);
    const [error, setError] = useState(false);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(false);
        setLoading(true);

        // Verify against the API — if 401, wrong password
        const res = await fetch('/api/superadmin/negocios', {
            headers: { 'x-superadmin-secret': value },
        });

        setLoading(false);
        if (res.ok) {
            sessionStorage.setItem(SESSION_KEY, value);
            onUnlock(value);
        } else {
            setError(true);
        }
    };

    return (
        <div className="min-h-screen bg-navy flex items-center justify-center p-4">
            <div className="w-full max-w-sm">
                <div className="flex items-center gap-3 justify-center mb-8">
                    <div className="w-9 h-9 bg-gold rounded-xl flex items-center justify-center">
                        <ShoppingCart className="w-4.5 h-4.5 text-navy" />
                    </div>
                    <span className="font-display font-extrabold text-xl text-white">VentaRD</span>
                </div>

                <div className="bg-navy-2 border border-navy-3 rounded-2xl p-8">
                    <div className="flex items-center gap-2 mb-1">
                        <Lock className="w-4 h-4 text-gold" />
                        <h1 className="font-display font-extrabold text-white text-lg">Panel operador</h1>
                    </div>
                    <p className="text-sm text-vr-gray mb-6">Ingresa la contraseña de administrador para continuar.</p>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="relative">
                            <input
                                type={show ? 'text' : 'password'}
                                placeholder="Contraseña"
                                autoFocus
                                className={`w-full pr-10 pl-4 py-2.5 bg-navy border rounded-xl text-sm text-white placeholder-vr-gray/50 outline-none transition-all ${
                                    error ? 'border-vr-red focus:border-vr-red' : 'border-navy-3 focus:border-gold'
                                }`}
                                value={value}
                                onChange={e => { setValue(e.target.value); setError(false); }}
                            />
                            <button
                                type="button"
                                onClick={() => setShow(s => !s)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-vr-gray hover:text-white transition-colors"
                            >
                                {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                        </div>

                        {error && (
                            <p className="text-xs text-vr-red flex items-center gap-1.5">
                                <AlertCircle className="w-3.5 h-3.5" />
                                Contraseña incorrecta.
                            </p>
                        )}

                        <button
                            type="submit"
                            disabled={!value || loading}
                            className="w-full py-2.5 bg-gold text-navy font-bold text-sm rounded-xl hover:bg-gold/90 transition-all disabled:opacity-40"
                        >
                            {loading ? 'Verificando…' : 'Entrar'}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function SuperAdminPage() {
    const [secret, setSecret] = useState<string | null>(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        const stored = sessionStorage.getItem(SESSION_KEY);
        setSecret(stored);
        setReady(true);
    }, []);

    if (!ready) return null;
    if (!secret) return <LoginPanel onUnlock={s => setSecret(s)} />;
    return <Panel secret={secret} onLogout={() => { sessionStorage.removeItem(SESSION_KEY); setSecret(null); }} />;
}

function Panel({ secret, onLogout }: { secret: string; onLogout: () => void }) {
    const [negocios, setNegocios] = useState<Negocio[]>([]);
    const [loading, setLoading] = useState(true);
    const [busqueda, setBusqueda] = useState('');
    const [accionando, setAccionando] = useState<string | null>(null);

    const fetchNegocios = async () => {
        setLoading(true);
        const res = await fetch('/api/superadmin/negocios', {
            headers: { 'x-superadmin-secret': secret },
        });
        if (res.status === 401) { onLogout(); return; }
        if (res.ok) setNegocios(await res.json());
        setLoading(false);
    };

    useEffect(() => { fetchNegocios(); }, []);

    const accion = async (id: string, body: object) => {
        setAccionando(id);
        await fetch(`/api/superadmin/negocios/${id}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-superadmin-secret': secret,
            },
            body: JSON.stringify(body),
        });
        await fetchNegocios();
        setAccionando(null);
    };

    const togglePlan = (n: Negocio) => accion(n.id, { plan_activo: !n.plan_activo });

    const extenderTrial = (n: Negocio, dias: number) => {
        const base = n.trial_hasta && n.trial_hasta > Date.now() ? n.trial_hasta : Date.now();
        accion(n.id, { trial_hasta: base + dias * 86400000 });
    };

    const whatsapp = (n: Negocio) => {
        const tel = (n.whatsapp_dueno || n.telefono || '').replace(/\D/g, '');
        if (!tel) return;
        const msg = encodeURIComponent(`Hola ${n.nombre}, te contactamos del equipo de VentaRD.`);
        window.open(`https://wa.me/${tel}?text=${msg}`, '_blank');
    };

    const negociosFiltrados = useMemo(() => {
        if (!busqueda.trim()) return negocios;
        const q = busqueda.toLowerCase();
        return negocios.filter(n =>
            n.nombre.toLowerCase().includes(q) ||
            n.email.toLowerCase().includes(q) ||
            (n.tipo_negocio || '').toLowerCase().includes(q)
        );
    }, [negocios, busqueda]);

    const ahora = Date.now();
    const stats = {
        total: negocios.length,
        activos: negocios.filter(n => n.plan_activo).length,
        enTrial: negocios.filter(n => !n.plan_activo && n.trial_hasta && ahora < n.trial_hasta).length,
        vencidos: negocios.filter(n => !n.plan_activo && n.trial_hasta && ahora >= n.trial_hasta).length,
    };

    return (
        <div className="min-h-screen bg-navy text-white">

            {/* Header */}
            <header className="border-b border-white/5 bg-navy/80 backdrop-blur-md sticky top-0 z-50">
                <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <div className="w-7 h-7 bg-gold rounded-lg flex items-center justify-center">
                            <ShoppingCart className="w-3.5 h-3.5 text-navy" />
                        </div>
                        <span className="font-display font-extrabold text-base text-white">VentaRD</span>
                        <span className="text-[10px] font-bold text-vr-red bg-vr-red/10 border border-vr-red/20 px-2 py-0.5 rounded-full uppercase tracking-widest">
                            Operador
                        </span>
                    </div>
                    <div className="flex items-center gap-3">
                        <button
                            onClick={fetchNegocios}
                            disabled={loading}
                            className="flex items-center gap-1.5 text-xs text-vr-gray hover:text-white transition-colors disabled:opacity-40"
                        >
                            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                            Actualizar
                        </button>
                        <button
                            onClick={onLogout}
                            className="text-xs text-vr-gray hover:text-vr-red transition-colors"
                        >
                            Salir
                        </button>
                    </div>
                </div>
            </header>

            <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">

                {/* Stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
                    {[
                        { icon: Users,       label: 'Total',    value: stats.total,    color: 'text-white'    },
                        { icon: Check,       label: 'Activos',  value: stats.activos,  color: 'text-vr-green' },
                        { icon: Clock,       label: 'En trial', value: stats.enTrial,  color: 'text-gold'     },
                        { icon: AlertCircle, label: 'Vencidos', value: stats.vencidos, color: 'text-vr-red'   },
                    ].map(({ icon: Icon, label, value, color }) => (
                        <div key={label} className="bg-navy-2 border border-navy-3 rounded-2xl p-4">
                            <div className="flex items-center gap-2 mb-2">
                                <Icon className={`w-4 h-4 ${color}`} />
                                <span className="text-xs text-vr-gray font-semibold uppercase tracking-wider">{label}</span>
                            </div>
                            {loading
                                ? <div className="h-8 w-12 bg-navy-3 rounded-lg animate-pulse" />
                                : <p className={`text-3xl font-display font-extrabold ${color}`}>{value}</p>
                            }
                        </div>
                    ))}
                </div>

                {/* Búsqueda */}
                <div className="relative mb-4">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-vr-gray pointer-events-none" />
                    <input
                        type="text"
                        placeholder="Buscar por nombre, email o tipo..."
                        className="w-full sm:max-w-sm pl-9 pr-4 py-2.5 bg-navy-2 border border-navy-3 rounded-xl text-sm text-white placeholder-vr-gray/50 focus:border-gold outline-none transition-all"
                        value={busqueda}
                        onChange={e => setBusqueda(e.target.value)}
                    />
                </div>

                {/* Tabla */}
                <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-sm">
                            <thead>
                                <tr className="border-b border-navy-3 text-vr-gray text-xs uppercase tracking-wider">
                                    <th className="px-4 py-3 font-semibold">Negocio</th>
                                    <th className="px-4 py-3 font-semibold hidden md:table-cell">Contacto</th>
                                    <th className="px-4 py-3 font-semibold hidden lg:table-cell">Registro</th>
                                    <th className="px-4 py-3 font-semibold">Estado</th>
                                    <th className="px-4 py-3 font-semibold text-center">Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                {loading ? (
                                    Array.from({ length: 5 }).map((_, i) => (
                                        <tr key={i} className="border-b border-navy-3/50">
                                            {Array.from({ length: 5 }).map((_, j) => (
                                                <td key={j} className="px-4 py-3">
                                                    <div className="h-4 bg-navy-3 rounded animate-pulse" style={{ width: `${60 + (i * 7 + j * 11) % 30}%` }} />
                                                </td>
                                            ))}
                                        </tr>
                                    ))
                                ) : negociosFiltrados.length === 0 ? (
                                    <tr><td colSpan={5} className="px-4 py-12 text-center text-vr-gray">
                                        {busqueda ? 'Sin resultados para esa búsqueda.' : 'No hay negocios registrados aún.'}
                                    </td></tr>
                                ) : (
                                    negociosFiltrados.map(n => {
                                        const estado = getEstado(n);
                                        const tel = (n.whatsapp_dueno || n.telefono || '').replace(/\D/g, '');
                                        const cargando = accionando === n.id;
                                        return (
                                            <tr key={n.id} className="border-b border-navy-3/40 hover:bg-navy-3/20 transition-colors">

                                                {/* Negocio */}
                                                <td className="px-4 py-3">
                                                    <p className="font-bold text-white">{n.nombre || '—'}</p>
                                                    <p className="text-xs text-vr-gray mt-0.5">
                                                        {n.tipo_negocio ? TIPOS[n.tipo_negocio] || n.tipo_negocio : 'Sin tipo'}
                                                        {!n.onboarding_completado && <span className="ml-2 text-gold/70">· onboarding pendiente</span>}
                                                    </p>
                                                    <p className="md:hidden text-xs text-vr-gray font-mono mt-0.5 truncate max-w-[180px]">{n.email}</p>
                                                </td>

                                                {/* Contacto */}
                                                <td className="px-4 py-3 hidden md:table-cell">
                                                    <p className="text-vr-gray font-mono text-xs truncate max-w-[200px]">{n.email}</p>
                                                    {(n.whatsapp_dueno || n.telefono) && (
                                                        <p className="text-vr-gray text-xs mt-0.5">{n.whatsapp_dueno || n.telefono}</p>
                                                    )}
                                                </td>

                                                {/* Registro */}
                                                <td className="px-4 py-3 hidden lg:table-cell text-vr-gray text-xs">
                                                    {n.created_at ? new Date(n.created_at).toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                                                </td>

                                                {/* Estado */}
                                                <td className="px-4 py-3">
                                                    <span className={`inline-flex items-center text-xs font-bold px-2 py-1 rounded-full border ${estado.color}`}>
                                                        {estado.label}
                                                    </span>
                                                </td>

                                                {/* Acciones */}
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center justify-center gap-1.5 flex-wrap">
                                                        <button
                                                            onClick={() => togglePlan(n)}
                                                            disabled={cargando}
                                                            title={n.plan_activo ? 'Desactivar plan' : 'Activar plan'}
                                                            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-all disabled:opacity-40 ${
                                                                n.plan_activo
                                                                    ? 'bg-vr-red/10 text-vr-red border-vr-red/20 hover:bg-vr-red/20'
                                                                    : 'bg-vr-green/10 text-vr-green border-vr-green/20 hover:bg-vr-green/20'
                                                            }`}
                                                        >
                                                            {n.plan_activo ? <X className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                                                            <span className="hidden sm:inline">{n.plan_activo ? 'Desactivar' : 'Activar'}</span>
                                                        </button>

                                                        <button
                                                            onClick={() => extenderTrial(n, 7)}
                                                            disabled={cargando}
                                                            title="Extender trial 7 días"
                                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-gold/10 text-gold border border-gold/20 hover:bg-gold/20 transition-all disabled:opacity-40"
                                                        >
                                                            <Clock className="w-3 h-3" />
                                                            <span>+7d</span>
                                                        </button>

                                                        <button
                                                            onClick={() => extenderTrial(n, 30)}
                                                            disabled={cargando}
                                                            title="Extender trial 30 días"
                                                            className="hidden sm:flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-gold/10 text-gold border border-gold/20 hover:bg-gold/20 transition-all disabled:opacity-40"
                                                        >
                                                            <Clock className="w-3 h-3" />
                                                            <span>+30d</span>
                                                        </button>

                                                        <button
                                                            onClick={() => whatsapp(n)}
                                                            disabled={!tel}
                                                            title="Contactar por WhatsApp"
                                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-vr-green/10 text-vr-green border border-vr-green/20 hover:bg-vr-green/20 transition-all disabled:opacity-30"
                                                        >
                                                            <MessageCircle className="w-3 h-3" />
                                                            <span className="hidden md:inline">WA</span>
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>

                    {!loading && negociosFiltrados.length > 0 && (
                        <div className="px-4 py-3 border-t border-navy-3 text-xs text-vr-gray">
                            {negociosFiltrados.length} negocio{negociosFiltrados.length !== 1 ? 's' : ''}
                            {busqueda && ` · filtrando "${busqueda}"`}
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}
