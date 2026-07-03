'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useConfigStore } from '@/store/useConfigStore';
import TopBar from '@/components/shared/TopBar';
import ConfirmModal from '@/components/ui/ConfirmModal';

type Miembro = {
    id: string;
    nombre: string;
    email: string;
    rol: 'admin' | 'vendedor' | 'cajero';
    activo: boolean;
};

const ROL_LABEL: Record<string, string> = { admin: 'Admin', vendedor: 'Vendedor', cajero: 'Cajero' };
const ROL_COLOR: Record<string, string> = {
    admin:    'bg-gold/15 text-gold border-gold/20',
    vendedor: 'bg-vr-green/15 text-vr-green border-vr-green/20',
    cajero:   'bg-blue-400/15 text-blue-400 border-blue-400/20',
};

export default function EquipoPage() {
    const { negocioId, showToast, rolUsuario } = useConfigStore();
    const [miembros, setMiembros] = useState<Miembro[]>([]);
    const [loading, setLoading] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [form, setForm] = useState({ email: '', nombre: '', rol: 'cajero' });
    const [enviando, setEnviando] = useState(false);
    const [linkAcceso, setLinkAcceso] = useState<{ email: string; link: string; nombre: string } | null>(null);

    // Solo el admin puede gestionar el equipo
    if (rolUsuario !== 'admin') {
        return (
            <div className="min-h-screen bg-navy flex flex-col">
                <TopBar />
                <div className="flex-1 flex items-center justify-center text-vr-gray">
                    <p>No tienes permiso para ver esta sección.</p>
                </div>
            </div>
        );
    }

    const cargarMiembros = async () => {
        if (!negocioId) return;
        const { data } = await supabase
            .from('usuarios_negocio')
            .select('id, nombre, email, rol, activo')
            .eq('negocio_id', negocioId)
            .order('created_at', { ascending: true });
        setMiembros(data ?? []);
        setLoading(false);
    };

    useEffect(() => { cargarMiembros(); }, [negocioId]);

    const invitar = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId) return;
        setEnviando(true);
        try {
            const { data: { session } } = await supabase.auth.getSession();
            const res = await fetch('/api/usuarios/invitar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
                body: JSON.stringify({ ...form, negocioId }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            setIsModalOpen(false);
            setForm({ email: '', nombre: '', rol: 'cajero' });
            cargarMiembros();

            if (data.inviteLink) {
                setLinkAcceso({ email: form.email, link: data.inviteLink, nombre: form.nombre });
            } else {
                showToast('Usuario vinculado al equipo.', 'success');
            }
        } catch (e: any) {
            showToast(e.message || 'Error al crear usuario.', 'error');
        } finally {
            setEnviando(false);
        }
    };

    const cambiarRol = async (id: string, nuevoRol: string) => {
        await supabase.from('usuarios_negocio').update({ rol: nuevoRol }).eq('id', id);
        setMiembros(prev => prev.map(m => m.id === id ? { ...m, rol: nuevoRol as any } : m));
        showToast('Rol actualizado.', 'success');
    };

    const [miembroADesactivar, setMiembroADesactivar] = useState<Miembro | null>(null);

    const desactivar = async () => {
        if (!miembroADesactivar) return;
        const id = miembroADesactivar.id;
        await supabase.from('usuarios_negocio').update({ activo: false }).eq('id', id);
        setMiembros(prev => prev.map(m => m.id === id ? { ...m, activo: false } : m));
        setMiembroADesactivar(null);
        showToast('Usuario desactivado.', 'info');
    };

    const reactivar = async (id: string) => {
        await supabase.from('usuarios_negocio').update({ activo: true }).eq('id', id);
        setMiembros(prev => prev.map(m => m.id === id ? { ...m, activo: true } : m));
        showToast('Usuario reactivado.', 'success');
    };

    return (
        <div className="min-h-screen bg-navy flex flex-col">
            <TopBar />
            <div className="flex-1 p-3 sm:p-6 lg:p-8">
                <div className="max-w-3xl mx-auto">
                    <div className="flex justify-between items-center mb-6 sm:mb-8">
                        <div>
                            <h1 className="text-2xl sm:text-3xl font-display font-extrabold text-white">Mi Equipo</h1>
                            <p className="text-vr-gray text-sm mt-0.5">Gestiona cajeros y vendedores</p>
                        </div>
                        <button
                            onClick={() => setIsModalOpen(true)}
                            className="px-4 sm:px-6 py-2.5 sm:py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all shadow-md text-sm sm:text-base"
                        >
                            + Agregar
                        </button>
                    </div>

                    {/* Guía rápida de roles */}
                    <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-6">
                        {[
                            { rol: 'cajero',   desc: 'Solo POS' },
                            { rol: 'vendedor', desc: 'POS + Clientes + Historial' },
                            { rol: 'admin',    desc: 'Acceso total' },
                        ].map(r => (
                            <div key={r.rol} className={`p-2.5 rounded-xl border text-center ${ROL_COLOR[r.rol]}`}>
                                <p className="text-xs font-black uppercase">{ROL_LABEL[r.rol]}</p>
                                <p className="text-[10px] opacity-70 mt-0.5 leading-tight">{r.desc}</p>
                            </div>
                        ))}
                    </div>

                    {/* Lista de miembros */}
                    <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden">
                        {loading ? (
                            <div className="p-8 text-center text-vr-gray animate-pulse">Cargando equipo…</div>
                        ) : miembros.length === 0 ? (
                            <div className="p-10 text-center text-vr-gray">
                                <p className="text-4xl mb-3">👥</p>
                                <p className="font-medium">Aún no tienes empleados registrados.</p>
                                <p className="text-sm mt-1">Invita a tu cajero o vendedor para comenzar.</p>
                            </div>
                        ) : (
                            <div className="divide-y divide-navy-3">
                                {miembros.map(m => (
                                    <div key={m.id} className={`flex items-center gap-3 p-4 sm:p-5 ${!m.activo ? 'opacity-50' : ''}`}>
                                        <div className="w-10 h-10 rounded-full bg-navy-3 flex items-center justify-center text-lg font-black text-white shrink-0">
                                            {m.nombre.charAt(0).toUpperCase()}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <p className="font-bold text-white text-sm">{m.nombre}</p>
                                                {!m.activo && <span className="text-[10px] font-black text-vr-gray bg-navy-3 px-1.5 py-0.5 rounded">Inactivo</span>}
                                            </div>
                                            <p className="text-xs text-vr-gray font-mono truncate">{m.email}</p>
                                        </div>

                                        {/* Selector de rol inline */}
                                        <select
                                            value={m.rol}
                                            onChange={e => cambiarRol(m.id, e.target.value)}
                                            disabled={!m.activo}
                                            className={`text-xs font-bold px-2 py-1.5 rounded-lg border bg-navy-3 outline-none transition-all ${ROL_COLOR[m.rol]} disabled:opacity-50`}
                                        >
                                            <option value="cajero">Cajero</option>
                                            <option value="vendedor">Vendedor</option>
                                            <option value="admin">Admin</option>
                                        </select>

                                        {m.activo ? (
                                            <button
                                                onClick={() => setMiembroADesactivar(m)}
                                                className="text-xs text-vr-red hover:text-vr-red/70 font-bold px-2 py-1.5 rounded-lg hover:bg-vr-red/10 transition-all whitespace-nowrap"
                                            >
                                                Quitar
                                            </button>
                                        ) : (
                                            <button
                                                onClick={() => reactivar(m.id)}
                                                className="text-xs text-vr-green hover:text-vr-green/70 font-bold px-2 py-1.5 rounded-lg hover:bg-vr-green/10 transition-all whitespace-nowrap"
                                            >
                                                Activar
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Confirmación de desactivación */}
            <ConfirmModal
                isOpen={!!miembroADesactivar}
                title="Desactivar usuario"
                mensaje={<><span className="font-bold text-white">{miembroADesactivar?.nombre}</span> ya no podrá acceder al sistema. Podrás reactivarlo cuando quieras.</>}
                confirmLabel="Desactivar"
                onConfirm={desactivar}
                onClose={() => setMiembroADesactivar(null)}
            />

            {/* Modal link de acceso — mostrar tras crear usuario */}
            {linkAcceso && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                    <div className="bg-navy-2 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-vr-green/30 shadow-2xl overflow-hidden animate-scale-in">
                        <div className="p-4 sm:p-6 border-b border-navy-3">
                            <h2 className="text-xl font-display font-bold text-vr-green">✓ Usuario creado</h2>
                            <p className="text-sm text-vr-gray mt-0.5">Comparte este link con <span className="text-white font-bold">{linkAcceso.nombre}</span></p>
                        </div>
                        <div className="p-4 sm:p-6 space-y-3">
                            <div className="bg-navy rounded-xl border border-navy-3 p-4">
                                <p className="text-xs font-bold text-vr-gray uppercase tracking-wider mb-2">Link de acceso (un solo uso)</p>
                                <p className="font-mono text-gold text-xs break-all select-all leading-relaxed">{linkAcceso.link}</p>
                            </div>
                            <p className="text-xs text-vr-gray text-center">El empleado hace clic, pone su contraseña y entra. El link expira en 24 horas.</p>

                            <button
                                onClick={() => {
                                    const msg = `Hola ${linkAcceso.nombre}, aquí está tu acceso a VentaRD:\n\n🔗 ${linkAcceso.link}\n\nHaz clic en el link, pon una contraseña y listo. Expira en 24 horas.`;
                                    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
                                }}
                                className="w-full py-3 bg-vr-green/15 text-vr-green font-bold rounded-xl border border-vr-green/20 hover:bg-vr-green/25 transition-all flex items-center justify-center gap-2"
                            >
                                📱 Enviar por WhatsApp
                            </button>
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(linkAcceso.link);
                                    showToast('Link copiado', 'success');
                                }}
                                className="w-full py-2.5 bg-navy-3 text-vr-gray font-bold rounded-xl border border-navy-3 hover:text-white transition-all text-sm"
                            >
                                📋 Copiar link
                            </button>
                            <button
                                onClick={() => setLinkAcceso(null)}
                                className="w-full py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all"
                            >
                                Listo
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal invitar */}
            {isModalOpen && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in">
                    <div className="bg-navy-2 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in">
                        <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-center">
                            <h2 className="text-xl font-display font-bold text-white">Nuevo empleado</h2>
                            <button onClick={() => setIsModalOpen(false)} className="text-vr-gray hover:text-white font-bold text-xl">✕</button>
                        </div>
                        <form onSubmit={invitar} className="p-4 sm:p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-vr-gray mb-1.5">Nombre completo *</label>
                                <input
                                    required type="text"
                                    className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all"
                                    value={form.nombre}
                                    onChange={e => setForm({ ...form, nombre: e.target.value })}
                                    placeholder="Ej: María García"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-vr-gray mb-1.5">Email (usuario para entrar) *</label>
                                <input
                                    required type="email"
                                    className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono focus:border-gold outline-none transition-all"
                                    value={form.email}
                                    onChange={e => setForm({ ...form, email: e.target.value })}
                                    placeholder="empleado@email.com"
                                />
                                <p className="text-xs text-vr-gray mt-1">Se genera una contraseña automática — no se envía ningún email.</p>
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-vr-gray mb-2">Rol</label>
                                <div className="grid grid-cols-3 gap-2">
                                    {(['cajero', 'vendedor', 'admin'] as const).map(r => (
                                        <button
                                            key={r} type="button"
                                            onClick={() => setForm({ ...form, rol: r })}
                                            className={`py-2.5 rounded-xl border font-bold text-sm transition-all ${form.rol === r ? ROL_COLOR[r] : 'border-navy-3 text-vr-gray hover:text-white'}`}
                                        >
                                            {ROL_LABEL[r]}
                                        </button>
                                    ))}
                                </div>
                                <p className="text-xs text-vr-gray mt-2">
                                    {form.rol === 'cajero' && 'Solo puede usar el POS.'}
                                    {form.rol === 'vendedor' && 'POS, clientes y su historial de ventas.'}
                                    {form.rol === 'admin' && 'Acceso completo igual que el dueño.'}
                                </p>
                            </div>
                            <div className="flex gap-3 pt-2">
                                <button type="button" onClick={() => setIsModalOpen(false)} className="flex-1 py-3 font-bold text-vr-gray hover:text-white border border-navy-3 rounded-xl transition-colors">Cancelar</button>
                                <button type="submit" disabled={enviando} className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-50">
                                    {enviando ? 'Creando…' : 'Crear usuario'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
