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
    acceso_hasta: number | null;
    onboarding_completado: boolean;
    created_at: string;
}

const DIA = 86400000;
const GRACIA_DIAS = 5;

// Fecha de vencimiento efectiva (acceso_hasta, o trial legado como respaldo)
function venceDe(n: Negocio): number | null {
    return n.acceso_hasta ?? n.trial_hasta ?? null;
}

function getEstado(n: Negocio): { label: string; color: string } {
    const vence = venceDe(n);
    const ahora = Date.now();
    if (vence == null) return { label: 'Sin activar', color: 'text-vr-gray bg-white/5 border-white/10' };
    if (ahora <= vence) {
        const dias = Math.ceil((vence - ahora) / DIA);
        return { label: `Vigente · ${dias}d`, color: 'text-vr-green bg-vr-green/10 border-vr-green/20' };
    }
    const diasVencido = (ahora - vence) / DIA;
    if (diasVencido <= GRACIA_DIAS) {
        return { label: `Gracia · ${Math.max(1, Math.ceil(GRACIA_DIAS - diasVencido))}d`, color: 'text-vr-orange bg-vr-orange/10 border-vr-orange/20' };
    }
    return { label: 'Bloqueado', color: 'text-vr-red bg-vr-red/10 border-vr-red/20' };
}

const TIPOS: Record<string, string> = {
    colmado: 'Colmado',
    tienda_ropa: 'Tienda ropa',
    ferreteria: 'Ferretería',
    restaurante: 'Restaurante',
    servicios: 'Servicios',
    otro: 'Otro',
};

interface DetalleNegocio {
    sucursales: number;
    productos: number;
    ventas: number;
    clientes: number;
    empleados: number;
    ultimaVenta: number | null;
    totalFacturado: number | null;
    pagos: { dias: number | null; nuevo_acceso_hasta: number | null; nota: string | null; creado_en: string }[];
}

const SESSION_KEY = 'vrd_sa_secret';

const fmtDOP = (n: number) => `RD$${n.toLocaleString('es-DO', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const haceDias = (ts: number | null) => {
    if (!ts) return null;
    const d = Math.floor((Date.now() - ts) / 86400000);
    return d <= 0 ? 'hoy' : d === 1 ? 'ayer' : `hace ${d}d`;
};

// ── Login screen ─────────────────────────────────────────────────────────────
function LoginPanel({ onUnlock }: { onUnlock: (secret: string) => void }) {
    const [value, setValue] = useState('');
    const [show, setShow] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setLoading(true);

        try {
            const res = await fetch('/api/superadmin/negocios', {
                headers: { 'x-superadmin-secret': value },
            });
            setLoading(false);

            if (res.ok) {
                sessionStorage.setItem(SESSION_KEY, value);
                onUnlock(value);
            } else if (res.status === 401) {
                setError('Contraseña incorrecta.');
            } else {
                // La clave es correcta pero el servidor falló (ej. falta correr un SQL)
                const body = await res.json().catch(() => ({}));
                setError(`Error del servidor (${res.status}): ${body.error || 'revisa la configuración de la base de datos.'}`);
            }
        } catch {
            setLoading(false);
            setError('No se pudo conectar con el servidor.');
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
                                onChange={e => { setValue(e.target.value); setError(null); }}
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
                            <p className="text-xs text-vr-red flex items-start gap-1.5">
                                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                {error}
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
    const [confirmandoCorte, setConfirmandoCorte] = useState<string | null>(null);
    const [filtro, setFiltro] = useState<'todos' | 'vigentes' | 'porvencer' | 'vencidos' | 'sinactivar'>('todos');
    const [detalle, setDetalle] = useState<{ negocio: Negocio; data: DetalleNegocio | null } | null>(null);

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

    // Extiende el acceso: parte de la fecha actual de vencimiento si aún es futura,
    // o de hoy si ya venció (no regala días al que pagó tarde, no quita al que pagó antes)
    const extender = (n: Negocio, dias: number, nota: string) => {
        const vence = venceDe(n);
        const base = vence && vence > Date.now() ? vence : Date.now();
        accion(n.id, { acceso_hasta: base + dias * DIA, dias, nota });
    };
    const registrarPago = (n: Negocio) => extender(n, 30, 'Pago +30d');

    const cortarAcceso = (n: Negocio) => accion(n.id, { acceso_hasta: Date.now(), nota: 'Corte de acceso' });

    // Fijar una fecha exacta de vencimiento (corrección manual)
    const fijarFecha = (n: Negocio, fechaISO: string) => {
        const ts = new Date(fechaISO + 'T23:59:59').getTime();
        if (isNaN(ts)) return;
        accion(n.id, { acceso_hasta: ts, nota: 'Ajuste manual de fecha' });
    };

    const whatsapp = (n: Negocio) => {
        const tel = (n.whatsapp_dueno || n.telefono || '').replace(/\D/g, '');
        if (!tel) return;
        const msg = encodeURIComponent(`Hola ${n.nombre}, te contactamos del equipo de VentaRD.`);
        window.open(`https://wa.me/${tel}?text=${msg}`, '_blank');
    };

    // Abrir el panel de detalle de un negocio (carga métricas de actividad)
    const abrirDetalle = async (n: Negocio) => {
        setDetalle({ negocio: n, data: null });
        try {
            const res = await fetch(`/api/superadmin/negocios/${n.id}/detalle`, {
                headers: { 'x-superadmin-secret': secret },
            });
            if (res.ok) setDetalle({ negocio: n, data: await res.json() });
        } catch { /* sin métricas */ }
    };

    const negociosFiltrados = useMemo(() => {
        const now = Date.now();
        const pasaFiltro = (n: Negocio) => {
            const v = venceDe(n);
            if (filtro === 'todos') return true;
            if (filtro === 'sinactivar') return v == null;
            if (v == null) return false;
            if (filtro === 'vigentes') return now <= v;
            if (filtro === 'porvencer') return now <= v && (v - now) <= 5 * DIA;
            if (filtro === 'vencidos') return now > v;
            return true;
        };
        const q = busqueda.trim().toLowerCase();
        return negocios.filter(n => pasaFiltro(n) && (
            !q || n.nombre.toLowerCase().includes(q) || n.email.toLowerCase().includes(q) || (n.tipo_negocio || '').toLowerCase().includes(q)
        ));
    }, [negocios, busqueda, filtro]);

    const ahora = Date.now();
    const stats = {
        total: negocios.length,
        vigentes: negocios.filter(n => { const v = venceDe(n); return v != null && ahora <= v; }).length,
        porVencer: negocios.filter(n => { const v = venceDe(n); return v != null && ahora <= v && (v - ahora) <= 5 * DIA; }).length,
        vencidos: negocios.filter(n => { const v = venceDe(n); return v != null && ahora > v; }).length,
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
                        { icon: Users,       label: 'Total',     value: stats.total,     color: 'text-white'     },
                        { icon: Check,       label: 'Vigentes',  value: stats.vigentes,  color: 'text-vr-green'  },
                        { icon: Clock,       label: 'Por vencer (5d)', value: stats.porVencer, color: 'text-vr-orange' },
                        { icon: AlertCircle, label: 'Vencidos',  value: stats.vencidos,  color: 'text-vr-red'    },
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

                {/* Búsqueda + filtros por estado */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
                    <div className="relative sm:max-w-sm flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-vr-gray pointer-events-none" />
                        <input
                            type="text"
                            placeholder="Buscar por nombre, email o tipo..."
                            className="w-full pl-9 pr-4 py-2.5 bg-navy-2 border border-navy-3 rounded-xl text-sm text-white placeholder-vr-gray/50 focus:border-gold outline-none transition-all"
                            value={busqueda}
                            onChange={e => setBusqueda(e.target.value)}
                        />
                    </div>
                    <div className="flex gap-1.5 flex-wrap">
                        {([
                            { k: 'todos', l: 'Todos' },
                            { k: 'vigentes', l: 'Vigentes' },
                            { k: 'porvencer', l: 'Por vencer' },
                            { k: 'vencidos', l: 'Vencidos' },
                            { k: 'sinactivar', l: 'Sin activar' },
                        ] as const).map(({ k, l }) => (
                            <button
                                key={k}
                                onClick={() => setFiltro(k)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                                    filtro === k ? 'bg-gold/15 border-gold/30 text-gold' : 'bg-navy-2 border-navy-3 text-vr-gray hover:text-white'
                                }`}
                            >
                                {l}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Tabla */}
                <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-sm">
                            <thead>
                                <tr className="border-b border-navy-3 text-vr-gray text-xs uppercase tracking-wider">
                                    <th className="px-4 py-3 font-semibold">Negocio</th>
                                    <th className="px-4 py-3 font-semibold hidden md:table-cell">Contacto</th>
                                    <th className="px-4 py-3 font-semibold hidden lg:table-cell">Vence</th>
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
                                                    <button onClick={() => abrirDetalle(n)} className="text-left group/n">
                                                        <p className="font-bold text-white group-hover/n:text-gold transition-colors">{n.nombre || '—'} <span className="text-vr-gray font-normal text-xs">· ver</span></p>
                                                        <p className="text-xs text-vr-gray mt-0.5">
                                                            {n.tipo_negocio ? TIPOS[n.tipo_negocio] || n.tipo_negocio : 'Sin tipo'}
                                                            {!n.onboarding_completado && <span className="ml-2 text-gold/70">· onboarding pendiente</span>}
                                                        </p>
                                                        <p className="md:hidden text-xs text-vr-gray font-mono mt-0.5 truncate max-w-[180px]">{n.email}</p>
                                                    </button>
                                                </td>

                                                {/* Contacto */}
                                                <td className="px-4 py-3 hidden md:table-cell">
                                                    <p className="text-vr-gray font-mono text-xs truncate max-w-[200px]">{n.email}</p>
                                                    {(n.whatsapp_dueno || n.telefono) && (
                                                        <p className="text-vr-gray text-xs mt-0.5">{n.whatsapp_dueno || n.telefono}</p>
                                                    )}
                                                </td>

                                                {/* Vence */}
                                                <td className="px-4 py-3 hidden lg:table-cell text-vr-gray text-xs">
                                                    {venceDe(n)
                                                        ? new Date(venceDe(n)!).toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' })
                                                        : '—'}
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
                                                        {/* Registrar pago = +30 días (acción principal) */}
                                                        <button
                                                            onClick={() => { setConfirmandoCorte(null); registrarPago(n); }}
                                                            disabled={cargando}
                                                            title="Registrar pago: extiende el acceso 30 días"
                                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-vr-green/10 text-vr-green border border-vr-green/20 hover:bg-vr-green/20 transition-all disabled:opacity-40"
                                                        >
                                                            <Check className="w-3 h-3" />
                                                            <span className="hidden sm:inline">Pago +30d</span>
                                                            <span className="sm:hidden">+30</span>
                                                        </button>

                                                        {/* Extensión corta (gracia / cortesía) */}
                                                        <button
                                                            onClick={() => { setConfirmandoCorte(null); extender(n, 7, '+7d cortesía'); }}
                                                            disabled={cargando}
                                                            title="Extender 7 días (cortesía)"
                                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-gold/10 text-gold border border-gold/20 hover:bg-gold/20 transition-all disabled:opacity-40"
                                                        >
                                                            <Clock className="w-3 h-3" />
                                                            <span>+7d</span>
                                                        </button>

                                                        {/* Cortar acceso (confirmación en dos clics, sin diálogo nativo) */}
                                                        <button
                                                            onClick={() => {
                                                                if (confirmandoCorte === n.id) { cortarAcceso(n); setConfirmandoCorte(null); }
                                                                else setConfirmandoCorte(n.id);
                                                            }}
                                                            onBlur={() => setConfirmandoCorte(c => c === n.id ? null : c)}
                                                            disabled={cargando}
                                                            title="Cortar acceso (entra en gracia y se bloquea)"
                                                            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-all disabled:opacity-40 ${
                                                                confirmandoCorte === n.id
                                                                    ? 'bg-vr-red text-white border-vr-red'
                                                                    : 'bg-vr-red/10 text-vr-red border-vr-red/20 hover:bg-vr-red/20'
                                                            }`}
                                                        >
                                                            <X className="w-3 h-3" />
                                                            <span className="hidden sm:inline">{confirmandoCorte === n.id ? '¿Seguro?' : 'Cortar'}</span>
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

            {/* Panel de detalle del negocio */}
            {detalle && (() => {
                const n = detalle.negocio;
                const d = detalle.data;
                const estado = getEstado(n);
                const vence = venceDe(n);
                const fechaInput = vence ? new Date(vence).toISOString().slice(0, 10) : '';
                const tel = (n.whatsapp_dueno || n.telefono || '').replace(/\D/g, '');
                return (
                    <div className="fixed inset-0 z-[60] flex justify-end">
                        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDetalle(null)} />
                        <div className="relative w-full max-w-md bg-navy-2 border-l border-navy-3 h-full overflow-y-auto animate-fade-in">
                            {/* Header */}
                            <div className="sticky top-0 bg-navy-2 border-b border-navy-3 px-5 py-4 flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h2 className="font-display font-extrabold text-white text-lg truncate">{n.nombre || '—'}</h2>
                                    <span className={`inline-flex items-center text-xs font-bold px-2 py-0.5 rounded-full border mt-1 ${estado.color}`}>{estado.label}</span>
                                </div>
                                <button onClick={() => setDetalle(null)} className="text-vr-gray hover:text-white text-xl shrink-0">✕</button>
                            </div>

                            <div className="p-5 space-y-5">
                                {/* Contacto */}
                                <div className="space-y-1 text-sm">
                                    <p className="text-vr-gray font-mono text-xs break-all">{n.email || 'sin email'}</p>
                                    {(n.whatsapp_dueno || n.telefono) && <p className="text-vr-gray text-xs">📞 {n.whatsapp_dueno || n.telefono}</p>}
                                    <p className="text-vr-gray text-xs">
                                        Registro: {n.created_at ? new Date(n.created_at).toLocaleDateString('es-DO') : '—'} ·
                                        Vence: {vence ? new Date(vence).toLocaleDateString('es-DO') : '—'}
                                    </p>
                                </div>

                                {/* Métricas de actividad */}
                                <div>
                                    <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider mb-2">Actividad</p>
                                    {!d ? (
                                        <p className="text-vr-gray text-sm animate-pulse">Cargando métricas…</p>
                                    ) : (
                                        <div className="grid grid-cols-2 gap-2">
                                            {[
                                                { l: 'Ventas', v: d.ventas },
                                                { l: 'Facturado', v: d.totalFacturado != null ? fmtDOP(d.totalFacturado) : '—' },
                                                { l: 'Productos', v: d.productos },
                                                { l: 'Clientes', v: d.clientes },
                                                { l: 'Sucursales', v: d.sucursales },
                                                { l: 'Empleados', v: d.empleados },
                                            ].map(m => (
                                                <div key={m.l} className="bg-navy border border-navy-3 rounded-xl p-3">
                                                    <p className="text-[10px] text-vr-gray uppercase tracking-wider">{m.l}</p>
                                                    <p className="text-lg font-black font-mono text-white truncate">{m.v}</p>
                                                </div>
                                            ))}
                                            <div className="col-span-2 bg-navy border border-navy-3 rounded-xl p-3">
                                                <p className="text-[10px] text-vr-gray uppercase tracking-wider">Última venta</p>
                                                <p className={`text-sm font-bold ${!d.ultimaVenta ? 'text-vr-gray' : haceDias(d.ultimaVenta)?.includes('hace') && (Date.now() - d.ultimaVenta) > 14 * DIA ? 'text-vr-red' : 'text-vr-green'}`}>
                                                    {d.ultimaVenta ? haceDias(d.ultimaVenta) : 'Nunca ha vendido'}
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Acciones de cobro */}
                                <div>
                                    <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider mb-2">Cobro</p>
                                    <div className="flex gap-2 flex-wrap">
                                        <button onClick={() => registrarPago(n)} disabled={accionando === n.id}
                                            className="flex-1 py-2.5 bg-vr-green/15 text-vr-green border border-vr-green/20 rounded-xl text-sm font-bold hover:bg-vr-green/25 transition-all disabled:opacity-40">
                                            💵 Registrar pago (+30d)
                                        </button>
                                        <button onClick={() => extender(n, 7, '+7d cortesía')} disabled={accionando === n.id}
                                            className="px-4 py-2.5 bg-gold/10 text-gold border border-gold/20 rounded-xl text-sm font-bold hover:bg-gold/20 transition-all disabled:opacity-40">
                                            +7d
                                        </button>
                                    </div>
                                    <label className="block text-[11px] text-vr-gray mt-3 mb-1">O fija una fecha exacta de vencimiento:</label>
                                    <input type="date" defaultValue={fechaInput}
                                        onChange={e => e.target.value && fijarFecha(n, e.target.value)}
                                        className="w-full bg-navy border border-navy-3 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-gold" />
                                </div>

                                {/* Historial de pagos */}
                                <div>
                                    <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider mb-2">Historial</p>
                                    {!d || d.pagos.length === 0 ? (
                                        <p className="text-vr-gray text-xs">{d ? 'Sin movimientos registrados.' : '…'}</p>
                                    ) : (
                                        <div className="space-y-1.5">
                                            {d.pagos.map((p, i) => (
                                                <div key={i} className="flex items-center justify-between text-xs border-b border-navy-3/40 pb-1.5">
                                                    <span className="text-white">{p.nota || 'Cambio de acceso'}</span>
                                                    <span className="text-vr-gray">{new Date(p.creado_en).toLocaleDateString('es-DO', { day: '2-digit', month: 'short' })}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}
