'use client';

import { useState, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useConfigStore } from '@/store/useConfigStore';
import TopBar from '@/components/shared/TopBar';
import PinGuard from '@/components/ui/PinGuard';
import EstadoSistema from '@/components/shared/EstadoSistema';
import { AlertTriangle } from 'lucide-react';

import { comprimirImagen } from '@/lib/imagen';
import { PALETAS, FUENTES } from '@/lib/marca';

export default function ConfiguracionPage() {
    const { negocioId, showToast, negocioNombre, negocioWhatsapp, negocioTelefono, negocioRnc, negocioDireccion, negocioMensajeTicket, negocioLogo, setAuth, user, pinAdmin, isOnline, ncf, setNcfConfig, impresion, setImpresion, colorMarca, setColorMarca, fuenteMarca, setFuenteMarca, catalogoPublico, setCatalogoPublico, datosPago, setDatosPago } = useConfigStore();

    const [loading, setLoading] = useState(false);
    const [logoData, setLogoData] = useState<string | null>(null);
    const [copiado, setCopiado] = useState(false);
    const [pago, setPago] = useState({ banco: '', cuenta: '', titular: '' });
    const [guardandoCat, setGuardandoCat] = useState(false);
    const [ref, setRef] = useState<{ codigo: string | null; total: number; dias: number } | null>(null);
    const [copiadoRef, setCopiadoRef] = useState(false);
    const logoInputRef = useRef<HTMLInputElement>(null);

    const catalogoUrl = typeof window !== 'undefined' && negocioId ? `${window.location.origin}/catalogo/${negocioId}` : '';

    const toggleCatalogo = async (activar: boolean) => {
        if (!negocioId || guardandoCat) return;
        setGuardandoCat(true);
        const { error } = await supabase.from('negocios').update({ catalogo_publico: activar }).eq('id', negocioId);
        if (error) { showToast('No se pudo actualizar el catálogo.', 'error'); }
        else { setCatalogoPublico(activar); showToast(activar ? 'Catálogo público activado.' : 'Catálogo desactivado.', 'success'); }
        setGuardandoCat(false);
    };

    const copiarLink = async () => {
        try { await navigator.clipboard.writeText(catalogoUrl); setCopiado(true); setTimeout(() => setCopiado(false), 2000); }
        catch { showToast('No se pudo copiar. Copia el link manualmente.', 'info'); }
    };
    const [formData, setFormData] = useState({
        nombre: '',
        whatsapp_dueno: '',
        telefono: '',
        rnc: '',
        direccion: '',
        mensaje_ticket: ''
    });

    useEffect(() => {
        setFormData({
            nombre: negocioNombre || '',
            whatsapp_dueno: negocioWhatsapp || '',
            telefono: negocioTelefono || '',
            rnc: negocioRnc || '',
            direccion: negocioDireccion || '',
            mensaje_ticket: negocioMensajeTicket || ''
        });
        setLogoData(negocioLogo);
        setPago({ banco: datosPago?.banco || '', cuenta: datosPago?.cuenta || '', titular: datosPago?.titular || '' });
    }, [negocioNombre, negocioWhatsapp, negocioTelefono, negocioRnc, negocioDireccion, negocioMensajeTicket, negocioLogo, datosPago]);

    // Cargar el código de referido del negocio (se crea en el servidor si falta).
    useEffect(() => {
        if (!negocioId || !isOnline) return;
        let vivo = true;
        (async () => {
            try {
                const { data: { session } } = await supabase.auth.getSession();
                const token = session?.access_token;
                if (!token) return;
                const res = await fetch('/api/referidos', { headers: { Authorization: `Bearer ${token}` } });
                if (!res.ok) return;
                const d = await res.json();
                if (vivo) setRef({ codigo: d.codigo ?? null, total: d.total ?? 0, dias: d.dias ?? 15 });
            } catch { /* offline u otro: sección se oculta */ }
        })();
        return () => { vivo = false; };
    }, [negocioId, isOnline]);

    const refLink = ref?.codigo && typeof window !== 'undefined' ? `${window.location.origin}/registro?ref=${ref.codigo}` : '';
    const copiarRef = async () => {
        try { await navigator.clipboard.writeText(refLink); setCopiadoRef(true); setTimeout(() => setCopiadoRef(false), 2000); }
        catch { showToast('No se pudo copiar. Copia el link manualmente.', 'info'); }
    };

    const handleLogoFile = async (file: File) => {
        if (!file.type.startsWith('image/')) {
            showToast('El archivo debe ser una imagen (PNG, JPG…).', 'error');
            return;
        }
        try {
            const dataUrl = await comprimirImagen(file);
            setLogoData(dataUrl);
        } catch {
            showToast('No se pudo procesar la imagen.', 'error');
        }
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId || !user) return;
        setLoading(true);

        try {
            // Si el logo es nuevo (data URL local), subirlo a Cloudinary primero
            let logoFinal = logoData;
            if (logoData && logoData.startsWith('data:')) {
                const { data: { session } } = await supabase.auth.getSession();
                const res = await fetch('/api/upload/logo', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
                    body: JSON.stringify({ dataUrl: logoData, negocioId }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Error al subir el logo');
                logoFinal = data.url;
                setLogoData(logoFinal);
            }

            const { error } = await supabase
                .from('negocios')
                .update({
                    nombre: formData.nombre,
                    whatsapp_dueno: formData.whatsapp_dueno,
                    telefono: formData.telefono || null,
                    rnc: formData.rnc,
                    direccion: formData.direccion,
                    mensaje_ticket: formData.mensaje_ticket,
                    logo_url: logoFinal,
                    color_marca: colorMarca,
                    fuente_marca: fuenteMarca,
                    banco_nombre: pago.banco.trim() || null,
                    banco_cuenta: pago.cuenta.trim() || null,
                    banco_titular: pago.titular.trim() || null,
                })
                .eq('id', negocioId);

            if (error) throw error;

            // Guardar la secuencia NCF en la nube (centralizada para todas las cajas).
            // La RPC preserva el progreso: nunca re-emite números ya usados.
            if (ncf.hasta > 0 || ncf.habilitado) {
                const { error: ncfError } = await supabase.rpc('configurar_ncf', {
                    p_negocio_id: negocioId,
                    p_tipo: ncf.tipo,
                    p_desde: ncf.desde,
                    p_hasta: ncf.hasta,
                    p_habilitado: ncf.habilitado,
                });
                if (ncfError) throw ncfError;
                setNcfConfig({ sembrado: true });
            }

            setAuth(
                user,
                negocioId,
                formData.nombre,
                pinAdmin,
                formData.whatsapp_dueno,
                formData.rnc,
                formData.direccion,
                formData.mensaje_ticket,
                formData.telefono || null,
                logoFinal
            );

            setDatosPago(pago.cuenta.trim() ? { banco: pago.banco.trim(), cuenta: pago.cuenta.trim(), titular: pago.titular.trim() } : null);
            showToast('Configuraciones guardadas correctamente', 'success');
        } catch (err) {
            console.error(err);
            showToast('Error al guardar configuraciones', 'error');
        }
        
        setLoading(false);
    };

    return (
        <PinGuard>
            <div className="min-h-screen bg-navy flex flex-col">
                <TopBar />
                <div className="flex-1 p-4 sm:p-8">
                    <div className="max-w-3xl mx-auto">
                        <div className="mb-6 sm:mb-8">
                            <h1 className="text-2xl sm:text-3xl font-display font-black text-white">Configuración del Negocio</h1>
                            <p className="text-vr-gray mt-2">Personaliza la información que aparece en los tickets y reportes.</p>
                        </div>

                        <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden shadow-2xl">
                            <form onSubmit={handleSave} className="p-4 sm:p-8 space-y-6">
                                
                                {/* Información Básica */}
                                <div>
                                    <h3 className="text-lg font-bold text-gold mb-4 border-b border-navy-3 pb-2">Información Pública (Tickets)</h3>

                                    {/* Logo del negocio */}
                                    <div className="mb-6">
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Logo del Negocio</label>
                                        <p className="text-xs text-vr-gray mb-3">Aparecerá en la parte superior de la factura impresa.</p>
                                        <input
                                            ref={logoInputRef}
                                            type="file"
                                            accept="image/*"
                                            className="hidden"
                                            onChange={e => { const f = e.target.files?.[0]; if (f) handleLogoFile(f); e.target.value = ''; }}
                                        />
                                        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                                            {logoData ? (
                                                <div className="flex items-center gap-3">
                                                    <div className="w-20 h-20 rounded-xl bg-white border border-navy-3 overflow-hidden flex items-center justify-center shrink-0">
                                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                                        <img src={logoData} alt="Logo del negocio" className="max-w-full max-h-full object-contain" />
                                                    </div>
                                                    <div className="flex flex-col gap-1.5">
                                                        <button
                                                            type="button"
                                                            onClick={() => logoInputRef.current?.click()}
                                                            className="px-4 py-2 bg-navy-3 border border-navy-3 hover:border-gold/40 text-vr-gray hover:text-gold font-bold rounded-xl text-xs transition-all"
                                                        >
                                                            Cambiar logo
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => setLogoData(null)}
                                                            className="px-4 py-2 text-vr-red hover:bg-vr-red/10 font-bold rounded-xl text-xs transition-all border border-transparent hover:border-vr-red/20"
                                                        >
                                                            Quitar
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => logoInputRef.current?.click()}
                                                    className="w-full sm:w-auto px-6 py-4 bg-navy-3/50 border-2 border-dashed border-navy-3 hover:border-gold/50 text-vr-gray hover:text-gold font-bold rounded-xl text-sm transition-all"
                                                >
                                                    🖼️ Subir logo
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Vista previa de la marca */}
                                    <div className="mb-6">
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Vista previa</label>
                                        <div className="rounded-2xl border border-navy-3 bg-navy p-5 flex items-center gap-3">
                                            {logoData ? (
                                                <div className="w-11 h-11 rounded-xl bg-white border border-navy-3 overflow-hidden flex items-center justify-center shrink-0">
                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                    <img src={logoData} alt="Logo" className="max-w-full max-h-full object-contain" />
                                                </div>
                                            ) : (
                                                <div className="w-11 h-11 rounded-xl bg-gold-gradient flex items-center justify-center shrink-0 text-navy font-black text-lg glow-gold">
                                                    {(formData.nombre.trim()[0] || 'V').toUpperCase()}
                                                </div>
                                            )}
                                            <span className="font-display font-extrabold text-2xl text-gold tracking-tight truncate">
                                                {formData.nombre.trim() || 'Mi Negocio'}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Color de marca */}
                                    <div className="mb-6">
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Color de Marca</label>
                                        <p className="text-xs text-vr-gray mb-3">Personaliza el color principal de la app. Se aplica al instante; recuerda guardar para que aplique en todos tus dispositivos.</p>
                                        <div className="flex flex-wrap gap-2.5">
                                            {Object.entries(PALETAS).map(([clave, p]) => {
                                                const activo = colorMarca === clave;
                                                return (
                                                    <button
                                                        key={clave}
                                                        type="button"
                                                        onClick={() => setColorMarca(clave)}
                                                        title={p.label}
                                                        aria-label={p.label}
                                                        className={`w-9 h-9 rounded-full shrink-0 transition-all ${activo ? 'ring-2 ring-offset-2 ring-offset-navy-2 ring-white scale-110' : 'hover:scale-105'}`}
                                                        style={{ background: `linear-gradient(135deg, ${p.gold} 0%, ${p.gold2} 100%)` }}
                                                    />
                                                );
                                            })}
                                        </div>
                                    </div>

                                    {/* Fuente de marca */}
                                    <div className="mb-6">
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">Tipografía</label>
                                        <p className="text-xs text-vr-gray mb-3">Cambia la letra de los títulos y el logo. Recuerda guardar para aplicarla en todos tus dispositivos.</p>
                                        <div className="flex flex-wrap gap-2">
                                            {Object.entries(FUENTES).map(([clave, f]) => {
                                                const activo = fuenteMarca === clave;
                                                return (
                                                    <button
                                                        key={clave}
                                                        type="button"
                                                        onClick={() => setFuenteMarca(clave)}
                                                        className={`px-4 py-2.5 rounded-xl border text-base transition-all ${activo ? 'border-gold bg-gold/10 text-gold' : 'border-navy-3 bg-navy-3 text-white hover:border-gold/40'}`}
                                                        style={{ fontFamily: `var(${f.cssVar})` }}
                                                    >
                                                        {f.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        <div>
                                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Nombre del Negocio *</label>
                                            <input 
                                                required type="text" 
                                                className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all" 
                                                value={formData.nombre} onChange={e => setFormData({...formData, nombre: e.target.value})} 
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-sm font-bold text-vr-gray mb-1.5">RNC / Cédula</label>
                                            <input
                                                type="text"
                                                className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all"
                                                value={formData.rnc} onChange={e => setFormData({...formData, rnc: e.target.value})}
                                                placeholder="Ej: 132-00000-1"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Teléfono del Negocio</label>
                                            <input
                                                type="tel"
                                                className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono focus:border-gold outline-none transition-all"
                                                value={formData.telefono} onChange={e => setFormData({...formData, telefono: e.target.value})}
                                                placeholder="Ej: 809-555-1234"
                                            />
                                            <p className="text-xs text-vr-gray mt-1">Aparece en el recibo impreso</p>
                                        </div>
                                        <div className="md:col-span-2">
                                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Dirección Física</label>
                                            <input 
                                                type="text" 
                                                className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all" 
                                                value={formData.direccion} onChange={e => setFormData({...formData, direccion: e.target.value})} 
                                                placeholder="Ej: Av. 27 de Febrero #52, Ens. Piantini"
                                            />
                                        </div>
                                        <div className="md:col-span-2">
                                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Mensaje al pie del Ticket</label>
                                            <input 
                                                type="text" 
                                                className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all" 
                                                value={formData.mensaje_ticket} onChange={e => setFormData({...formData, mensaje_ticket: e.target.value})} 
                                                placeholder="Ej: ¡Gracias por su compra! Síguenos en @VentaRD"
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Catálogo público (mini-tienda por link) */}
                                <div className="pt-4">
                                    <h3 className="text-lg font-bold text-vr-green mb-1 border-b border-navy-3 pb-2">🛍️ Catálogo Público</h3>
                                    <p className="text-xs text-vr-gray mb-4">Comparte un link con tus productos y precios. Tus clientes arman su pedido y te llega por WhatsApp. No muestra costos ni existencias.</p>

                                    <div className="flex items-center justify-between bg-navy rounded-xl border border-navy-3 p-4 mb-3">
                                        <div className="pr-3">
                                            <p className="text-sm font-bold text-white">Activar catálogo público</p>
                                            <p className="text-xs text-vr-gray">Cualquiera con el link podrá ver tus productos.</p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => toggleCatalogo(!catalogoPublico)}
                                            disabled={guardandoCat || !isOnline}
                                            className={`relative w-12 h-7 rounded-full transition-colors shrink-0 disabled:opacity-50 ${catalogoPublico ? 'bg-vr-green' : 'bg-navy-4'}`}
                                            aria-pressed={catalogoPublico}
                                        >
                                            <span className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-white transition-transform ${catalogoPublico ? 'translate-x-5' : ''}`} />
                                        </button>
                                    </div>

                                    {catalogoPublico && (
                                        <div className="bg-navy rounded-xl border border-navy-3 p-4 space-y-3">
                                            <div className="flex items-center gap-2">
                                                <input readOnly value={catalogoUrl} className="flex-1 bg-navy-3 border border-navy-3 rounded-lg px-3 py-2 text-sm text-white font-mono truncate" />
                                                <button type="button" onClick={copiarLink} className="px-3 py-2 bg-navy-3 border border-navy-3 hover:border-gold/40 text-vr-gray hover:text-gold font-bold rounded-lg text-xs transition-all shrink-0">
                                                    {copiado ? '✓ Copiado' : 'Copiar'}
                                                </button>
                                            </div>
                                            <div className="flex flex-wrap gap-2">
                                                <a href={catalogoUrl} target="_blank" rel="noopener noreferrer" className="px-4 py-2 bg-navy-3 text-white font-bold rounded-lg text-xs hover:bg-navy-4 transition-all">👁️ Ver catálogo</a>
                                                <a href={`https://wa.me/?text=${encodeURIComponent(`¡Mira nuestro catálogo! 🛍️\n${catalogoUrl}`)}`} target="_blank" rel="noopener noreferrer" className="px-4 py-2 bg-vr-green/15 text-vr-green border border-vr-green/20 font-bold rounded-lg text-xs hover:bg-vr-green/25 transition-all">📱 Compartir por WhatsApp</a>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Datos de pago para el QR de transferencia */}
                                <div className="pt-4">
                                    <h3 className="text-lg font-bold text-gold-2 mb-1 border-b border-navy-3 pb-2">💳 Datos para Transferencias</h3>
                                    <p className="text-xs text-vr-gray mb-4">Al cobrar con &quot;Transferencia&quot;, el cliente verá un QR con estos datos y el monto exacto — se acabó dictar la cuenta.</p>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                        <div>
                                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Banco</label>
                                            <input type="text" placeholder="Ej: Banreservas"
                                                className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all"
                                                value={pago.banco} onChange={e => setPago(v => ({ ...v, banco: e.target.value }))} />
                                        </div>
                                        <div>
                                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Número de cuenta</label>
                                            <input type="text" placeholder="000-000000-0"
                                                className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono focus:border-gold outline-none transition-all"
                                                value={pago.cuenta} onChange={e => setPago(v => ({ ...v, cuenta: e.target.value }))} />
                                        </div>
                                        <div>
                                            <label className="block text-sm font-bold text-vr-gray mb-1.5">Titular</label>
                                            <input type="text" placeholder="Nombre del titular"
                                                className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all"
                                                value={pago.titular} onChange={e => setPago(v => ({ ...v, titular: e.target.value }))} />
                                        </div>
                                    </div>
                                </div>

                                {/* Programa de referidos */}
                                {ref?.codigo && (
                                    <div className="pt-4">
                                        <h3 className="text-lg font-bold text-gold mb-1 border-b border-navy-3 pb-2">🎁 Invita y Gana</h3>
                                        <p className="text-xs text-vr-gray mb-4">Invita a otro negocio con tu link. Cuando complete su registro, <span className="font-bold text-white">ambos ganan {ref.dias} días</span> de acceso. Sin límite.</p>

                                        <div className="bg-navy rounded-xl border border-navy-3 p-4 space-y-3">
                                            <div className="flex items-center justify-between gap-3">
                                                <div>
                                                    <p className="text-xs text-vr-gray">Tu código</p>
                                                    <p className="font-mono font-black text-gold text-lg">{ref.codigo}</p>
                                                </div>
                                                <div className="text-right">
                                                    <p className="text-xs text-vr-gray">Referidos</p>
                                                    <p className="font-mono font-black text-white text-lg">{ref.total}</p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <input readOnly value={refLink} className="flex-1 bg-navy-3 border border-navy-3 rounded-lg px-3 py-2 text-sm text-white font-mono truncate" />
                                                <button type="button" onClick={copiarRef} className="px-3 py-2 bg-navy-3 border border-navy-3 hover:border-gold/40 text-vr-gray hover:text-gold font-bold rounded-lg text-xs transition-all shrink-0">
                                                    {copiadoRef ? '✓ Copiado' : 'Copiar'}
                                                </button>
                                            </div>
                                            <a
                                                href={`https://wa.me/?text=${encodeURIComponent(`¡Te invito a usar VentaRD para tu negocio! 🚀\nRegístrate con mi link y ambos ganamos ${ref.dias} días gratis:\n${refLink}`)}`}
                                                target="_blank" rel="noopener noreferrer"
                                                className="block w-full text-center px-4 py-2.5 bg-vr-green/15 text-vr-green border border-vr-green/20 font-bold rounded-lg text-sm hover:bg-vr-green/25 transition-all"
                                            >
                                                📱 Invitar por WhatsApp
                                            </a>
                                        </div>
                                    </div>
                                )}

                                {/* Comprobantes Fiscales NCF */}
                                <div className="pt-4">
                                    <h3 className="text-lg font-bold text-blue-400 mb-1 border-b border-navy-3 pb-2">Comprobantes Fiscales (NCF)</h3>
                                    <p className="text-xs text-vr-gray mb-4">Configura la secuencia de NCF autorizada por la DGII. El sistema generará el número automáticamente en cada venta.</p>

                                    {/* Toggle habilitar */}
                                    <label className="flex items-center gap-3 cursor-pointer mb-5">
                                        <div
                                            onClick={() => setNcfConfig({ habilitado: !ncf.habilitado })}
                                            className={`relative w-11 h-6 rounded-full transition-colors ${ncf.habilitado ? 'bg-gold' : 'bg-navy-3'}`}
                                        >
                                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${ncf.habilitado ? 'translate-x-5' : ''}`} />
                                        </div>
                                        <span className="text-sm font-semibold text-white">
                                            {ncf.habilitado ? 'NCF habilitado' : 'NCF deshabilitado'}
                                        </span>
                                    </label>

                                    {ncf.habilitado && (
                                        <div className="space-y-4">
                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                                {/* Tipo */}
                                                <div>
                                                    <label className="block text-sm font-bold text-vr-gray mb-1.5">Tipo de Comprobante</label>
                                                    <select
                                                        className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all"
                                                        value={ncf.tipo}
                                                        onChange={e => setNcfConfig({ tipo: e.target.value as 'B02' | 'B01' })}
                                                    >
                                                        <option value="B02">B02 — Consumidor Final</option>
                                                        <option value="B01">B01 — Crédito Fiscal (B2B)</option>
                                                    </select>
                                                </div>
                                                {/* Desde */}
                                                <div>
                                                    <label className="block text-sm font-bold text-vr-gray mb-1.5">Secuencia Desde</label>
                                                    <input
                                                        type="number" min={1}
                                                        className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all"
                                                        value={ncf.desde}
                                                        onChange={e => setNcfConfig({ desde: parseInt(e.target.value) || 1 })}
                                                    />
                                                </div>
                                                {/* Hasta */}
                                                <div>
                                                    <label className="block text-sm font-bold text-vr-gray mb-1.5">Secuencia Hasta</label>
                                                    <input
                                                        type="number" min={1}
                                                        className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white focus:border-gold outline-none transition-all"
                                                        value={ncf.hasta}
                                                        onChange={e => setNcfConfig({ hasta: parseInt(e.target.value) || 0 })}
                                                    />
                                                </div>
                                            </div>

                                            {/* Estado actual */}
                                            {(() => {
                                                const reservadosCaja = ncf.bloques.reduce((s, b) => s + Math.max(0, b.hasta - b.proximo + 1), 0);
                                                const proximoCaja = ncf.bloques.find(b => b.proximo <= b.hasta)?.proximo ?? null;
                                                const disponiblesNube = ncf.proximoGlobal > 0 ? Math.max(0, ncf.hasta - ncf.proximoGlobal + 1) : Math.max(0, ncf.hasta - ncf.desde + 1);
                                                const disponiblesTotal = disponiblesNube + reservadosCaja;
                                                return (
                                                    <>
                                                        <div className="bg-navy-3/50 rounded-xl p-4 flex flex-wrap gap-6 text-sm">
                                                            <div>
                                                                <p className="text-vr-gray text-xs font-semibold uppercase tracking-wider mb-1">Próximo en esta caja</p>
                                                                <p className="text-white font-mono font-bold">
                                                                    {proximoCaja !== null
                                                                        ? `${ncf.tipo}${String(proximoCaja).padStart(8, '0')}`
                                                                        : ncf.sembrado ? 'Sin reservar' : '—'}
                                                                </p>
                                                            </div>
                                                            <div>
                                                                <p className="text-vr-gray text-xs font-semibold uppercase tracking-wider mb-1">Reservados en esta caja</p>
                                                                <p className="text-white font-bold font-mono">{reservadosCaja}</p>
                                                            </div>
                                                            <div>
                                                                <p className="text-vr-gray text-xs font-semibold uppercase tracking-wider mb-1">Disponibles (negocio)</p>
                                                                <p className={`font-bold font-mono ${disponiblesTotal <= 10 ? 'text-vr-red' : 'text-vr-green'}`}>
                                                                    {ncf.hasta > 0 ? disponiblesTotal : '—'}
                                                                </p>
                                                            </div>
                                                        </div>

                                                        {/* Alerta de stock bajo */}
                                                        {ncf.hasta > 0 && disponiblesTotal <= 10 && (
                                                            <div className="flex items-start gap-2 bg-vr-red/10 border border-vr-red/20 rounded-xl p-3 text-sm text-vr-red">
                                                                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                                                <span>Quedan pocos NCF disponibles. Solicita una nueva secuencia a la DGII antes de agotar el rango.</span>
                                                            </div>
                                                        )}
                                                    </>
                                                );
                                            })()}

                                            <p className="text-[11px] text-vr-gray/70">
                                                La secuencia es compartida por todas tus cajas: cada una reserva un bloque de números
                                                automáticamente para poder emitir incluso sin internet. Los cambios se guardan al pulsar "Guardar Cambios".
                                            </p>
                                        </div>
                                    )}
                                </div>

                                {/* Ajustes de impresión */}
                                <div className="pt-4">
                                    <h3 className="text-lg font-bold text-gold-2 mb-1 border-b border-navy-3 pb-2">🖨️ Impresión de Tickets</h3>
                                    <p className="text-xs text-vr-gray mb-4">
                                        Estos ajustes se guardan <span className="font-bold text-white">en este dispositivo</span> — cada caja puede tener su propia impresora. Se aplican al instante, no necesitas guardar.
                                    </p>

                                    <div className="space-y-4">
                                        {/* Ancho de papel */}
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-sm font-bold text-vr-gray mb-2">Ancho del papel</label>
                                                <div className="grid grid-cols-2 gap-2">
                                                    {(['80mm', '58mm'] as const).map(w => (
                                                        <button
                                                            key={w} type="button"
                                                            onClick={() => setImpresion({ anchoPapel: w })}
                                                            className={`py-2.5 rounded-xl border font-bold text-sm transition-all ${impresion.anchoPapel === w ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}
                                                        >
                                                            {w}
                                                        </button>
                                                    ))}
                                                </div>
                                                <p className="text-[10px] text-vr-gray mt-1">58mm = impresoras térmicas pequeñas</p>
                                            </div>

                                            {/* Tamaño de letra */}
                                            <div>
                                                <label className="block text-sm font-bold text-vr-gray mb-2">Tamaño de letra</label>
                                                <div className="grid grid-cols-2 gap-2">
                                                    {([
                                                        { val: 'normal', label: 'Normal' },
                                                        { val: 'grande', label: 'Grande' },
                                                    ] as const).map(o => (
                                                        <button
                                                            key={o.val} type="button"
                                                            onClick={() => setImpresion({ tamanoLetra: o.val })}
                                                            className={`py-2.5 rounded-xl border font-bold text-sm transition-all ${impresion.tamanoLetra === o.val ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}
                                                        >
                                                            {o.label}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>

                                            {/* Densidad */}
                                            <div>
                                                <label className="block text-sm font-bold text-vr-gray mb-2">Espaciado</label>
                                                <div className="grid grid-cols-2 gap-2">
                                                    {([
                                                        { val: 'normal', label: 'Normal' },
                                                        { val: 'compacta', label: 'Compacto' },
                                                    ] as const).map(o => (
                                                        <button
                                                            key={o.val} type="button"
                                                            onClick={() => setImpresion({ densidad: o.val })}
                                                            className={`py-2.5 rounded-xl border font-bold text-sm transition-all ${impresion.densidad === o.val ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}
                                                        >
                                                            {o.label}
                                                        </button>
                                                    ))}
                                                </div>
                                                <p className="text-[10px] text-vr-gray mt-1">Compacto ahorra papel</p>
                                            </div>

                                            {/* Copias */}
                                            <div>
                                                <label className="block text-sm font-bold text-vr-gray mb-2">Copias por venta</label>
                                                <div className="grid grid-cols-2 gap-2">
                                                    {([1, 2] as const).map(n => (
                                                        <button
                                                            key={n} type="button"
                                                            onClick={() => setImpresion({ copias: n })}
                                                            className={`py-2.5 rounded-xl border font-bold text-sm transition-all ${impresion.copias === n ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}
                                                        >
                                                            {n === 1 ? '1 copia' : '2 copias'}
                                                        </button>
                                                    ))}
                                                </div>
                                                <p className="text-[10px] text-vr-gray mt-1">2 = una para el cliente, una para ti</p>
                                            </div>
                                        </div>

                                        {/* Toggles */}
                                        <div className="space-y-2">
                                            <button
                                                type="button"
                                                onClick={() => setImpresion({ mostrarLogo: !impresion.mostrarLogo })}
                                                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${impresion.mostrarLogo ? 'border-gold/40 bg-gold/10 text-gold' : 'border-navy-3 text-vr-gray'}`}
                                            >
                                                <div className="text-left">
                                                    <p className="text-sm font-bold">Imprimir logo en el ticket</p>
                                                    <p className="text-xs font-normal opacity-70">Desactívalo si tu impresora lo saca borroso</p>
                                                </div>
                                                <div className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-3 ${impresion.mostrarLogo ? 'bg-gold' : 'bg-navy-3'}`}>
                                                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${impresion.mostrarLogo ? 'translate-x-5' : ''}`} />
                                                </div>
                                            </button>

                                            <button
                                                type="button"
                                                onClick={() => setImpresion({ autoImprimir: !impresion.autoImprimir })}
                                                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${impresion.autoImprimir ? 'border-gold/40 bg-gold/10 text-gold' : 'border-navy-3 text-vr-gray'}`}
                                            >
                                                <div className="text-left">
                                                    <p className="text-sm font-bold">Imprimir automático al cobrar</p>
                                                    <p className="text-xs font-normal opacity-70">Lanza la impresión apenas se confirma la venta</p>
                                                </div>
                                                <div className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-3 ${impresion.autoImprimir ? 'bg-gold' : 'bg-navy-3'}`}>
                                                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${impresion.autoImprimir ? 'translate-x-5' : ''}`} />
                                                </div>
                                            </button>
                                        </div>

                                        {/* ─── Modo de impresión ─── */}
                                        <div className="pt-2">
                                            <label className="block text-sm font-bold text-vr-gray mb-2">Modo de impresión</label>
                                            <div className="grid grid-cols-2 gap-2">
                                                {([
                                                    { val: 'navegador', label: 'Navegador', sub: 'Diálogo de imprimir estándar' },
                                                    { val: 'directa', label: 'Directa ⚡', sub: 'A la térmica, sin diálogo' },
                                                ] as const).map(o => (
                                                    <button
                                                        key={o.val} type="button"
                                                        onClick={() => setImpresion({ modoImpresion: o.val })}
                                                        className={`p-3 rounded-xl border text-left transition-all ${impresion.modoImpresion === o.val ? 'border-gold bg-gold/15' : 'border-navy-3 hover:border-navy-4'}`}
                                                    >
                                                        <p className={`text-sm font-bold ${impresion.modoImpresion === o.val ? 'text-gold' : 'text-white'}`}>{o.label}</p>
                                                        <p className="text-[10px] text-vr-gray mt-0.5 leading-tight">{o.sub}</p>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>

                                        {impresion.modoImpresion === 'directa' ? (
                                            <div className="space-y-3 bg-navy rounded-2xl border border-gold/15 p-4">
                                                {/* Tipo de conexión */}
                                                <div>
                                                    <label className="block text-sm font-bold text-vr-gray mb-2">Conexión con la impresora</label>
                                                    <div className="grid grid-cols-3 gap-2">
                                                        {([
                                                            { val: 'usb', label: '🔌 USB' },
                                                            { val: 'bluetooth', label: '📶 Bluetooth' },
                                                            { val: 'serial', label: '🖥️ Serial' },
                                                        ] as const).map(o => (
                                                            <button
                                                                key={o.val} type="button"
                                                                onClick={() => setImpresion({ tipoConexion: o.val })}
                                                                className={`py-2.5 rounded-xl border font-bold text-xs sm:text-sm transition-all ${impresion.tipoConexion === o.val ? 'border-gold bg-gold/15 text-gold' : 'border-navy-3 text-vr-gray hover:text-white'}`}
                                                            >
                                                                {o.label}
                                                            </button>
                                                        ))}
                                                    </div>
                                                    <p className="text-[10px] text-vr-gray mt-1.5">
                                                        {impresion.tipoConexion === 'usb' && 'Impresora conectada por cable USB a esta PC/tablet.'}
                                                        {impresion.tipoConexion === 'bluetooth' && 'Impresoras térmicas Bluetooth (ideal en celulares Android).'}
                                                        {impresion.tipoConexion === 'serial' && 'Puerto serie/COM (impresoras viejas o adaptadores).'}
                                                    </p>
                                                </div>

                                                {/* Conectar y probar */}
                                                <div className="flex flex-col sm:flex-row gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={async () => {
                                                            try {
                                                                const { soportaConexion, conectarImpresora } = await import('@/lib/print/transport');
                                                                if (!soportaConexion(impresion.tipoConexion)) {
                                                                    showToast('Este navegador no soporta esa conexión. Usa Chrome o Edge.', 'error');
                                                                    return;
                                                                }
                                                                await conectarImpresora(impresion.tipoConexion);
                                                                showToast('¡Impresora conectada!', 'success');
                                                            } catch (e: any) {
                                                                showToast(e?.message || 'No se pudo conectar la impresora.', 'error');
                                                            }
                                                        }}
                                                        className="flex-1 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all text-sm"
                                                    >
                                                        🔗 Conectar impresora
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={async () => {
                                                            try {
                                                                const { imprimirPrueba } = await import('@/lib/print/tickets');
                                                                const { logoParaImprimir } = await import('@/lib/logoCache');
                                                                await imprimirPrueba(impresion, negocioNombre || 'VentaRD', await logoParaImprimir(negocioLogo));
                                                                showToast('Página de prueba enviada.', 'success');
                                                            } catch (e: any) {
                                                                showToast(e?.message === 'sin_dispositivo' ? 'Primero conecta la impresora.' : (e?.message || 'Error al imprimir.'), 'error');
                                                            }
                                                        }}
                                                        className="flex-1 py-3 bg-navy-3 border border-navy-4 text-white font-bold rounded-xl hover:bg-navy-4 transition-all text-sm"
                                                    >
                                                        🧾 Imprimir prueba
                                                    </button>
                                                </div>

                                                {/* Toggles directa */}
                                                <button
                                                    type="button"
                                                    onClick={() => setImpresion({ cortarPapel: !impresion.cortarPapel })}
                                                    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${impresion.cortarPapel ? 'border-gold/40 bg-gold/10 text-gold' : 'border-navy-3 text-vr-gray'}`}
                                                >
                                                    <div className="text-left">
                                                        <p className="text-sm font-bold">Cortar papel automático</p>
                                                        <p className="text-xs font-normal opacity-70">Si tu impresora tiene cuchilla</p>
                                                    </div>
                                                    <div className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-3 ${impresion.cortarPapel ? 'bg-gold' : 'bg-navy-3'}`}>
                                                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${impresion.cortarPapel ? 'translate-x-5' : ''}`} />
                                                    </div>
                                                </button>

                                                <button
                                                    type="button"
                                                    onClick={() => setImpresion({ abrirGaveta: !impresion.abrirGaveta })}
                                                    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${impresion.abrirGaveta ? 'border-gold/40 bg-gold/10 text-gold' : 'border-navy-3 text-vr-gray'}`}
                                                >
                                                    <div className="text-left">
                                                        <p className="text-sm font-bold">Abrir gaveta de dinero</p>
                                                        <p className="text-xs font-normal opacity-70">Al cobrar en efectivo o mixto (gaveta conectada a la impresora)</p>
                                                    </div>
                                                    <div className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-3 ${impresion.abrirGaveta ? 'bg-gold' : 'bg-navy-3'}`}>
                                                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${impresion.abrirGaveta ? 'translate-x-5' : ''}`} />
                                                    </div>
                                                </button>

                                                <p className="text-[10px] text-vr-gray leading-relaxed">
                                                    Requiere Chrome o Edge. La primera vez el navegador te pedirá elegir la impresora;
                                                    después se reconecta solo. Si la impresión directa falla, el sistema usa
                                                    automáticamente la impresión del navegador como respaldo.
                                                </p>
                                            </div>
                                        ) : (
                                            <div className="bg-navy-3/40 border border-navy-3 rounded-xl p-3 text-[11px] text-vr-gray leading-relaxed">
                                                <span className="font-bold text-white">💡 Para imprimir sin que salga la ventana del navegador:</span> en la PC de la caja,
                                                crea un acceso directo de Chrome con <code className="bg-navy px-1 rounded text-gold">--kiosk-printing</code> al final del destino,
                                                o cambia al modo <span className="text-gold font-bold">Directa ⚡</span> arriba si tienes impresora térmica.
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Estado del sistema (diagnóstico para soporte) */}
                                <EstadoSistema />

                                {/* Reportes y Alertas */}
                                <div className="pt-4">
                                    <h3 className="text-lg font-bold text-vr-green mb-4 border-b border-navy-3 pb-2">Reportes (Privado)</h3>
                                    <div>
                                        <label className="block text-sm font-bold text-vr-gray mb-1.5">WhatsApp del Dueño/Gerente</label>
                                        <p className="text-xs text-vr-gray mb-2">Aquí recibirás los reportes automáticos cada vez que un cajero cierre su turno.</p>
                                        <input 
                                            type="tel" 
                                            className="w-full max-w-md bg-navy-3 border border-navy-3 rounded-xl p-3 text-white font-mono focus:border-vr-green outline-none transition-all" 
                                            value={formData.whatsapp_dueno} onChange={e => setFormData({...formData, whatsapp_dueno: e.target.value})} 
                                            placeholder="Ej: 18095551234"
                                        />
                                    </div>
                                </div>

                                <div className="pt-6 border-t border-navy-3 flex justify-end">
                                    <button
                                        type="submit" disabled={loading || !isOnline}
                                        title={!isOnline ? "Requiere conexión a internet para guardar" : ""}
                                        className="w-full sm:w-auto px-8 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                                    >
                                        {loading ? 'Guardando...' : 'Guardar Cambios'}
                                    </button>
                                </div>

                            </form>
                        </div>

                        {/* Acceso rápido a Mi Equipo */}
                        <div className="mt-6">
                            <a
                                href="/configuracion/equipo"
                                className="flex items-center justify-between w-full p-4 sm:p-5 bg-navy-2 rounded-2xl border border-navy-3 hover:border-gold/30 transition-all group"
                            >
                                <div>
                                    <p className="font-bold text-white text-sm group-hover:text-gold-2 transition-colors">👥 Mi Equipo</p>
                                    <p className="text-xs text-vr-gray mt-0.5">Invita cajeros y vendedores con acceso limitado</p>
                                </div>
                                <span className="text-vr-gray group-hover:text-gold transition-colors text-lg">→</span>
                            </a>
                        </div>
                    </div>
                </div>
            </div>
        </PinGuard>
    );
}
