'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useConfigStore } from '@/store/useConfigStore';
import TopBar from '@/components/shared/TopBar';
import PinGuard from '@/components/ui/PinGuard';
import { AlertTriangle } from 'lucide-react';

export default function ConfiguracionPage() {
    const { negocioId, showToast, negocioNombre, negocioWhatsapp, negocioRnc, negocioDireccion, negocioMensajeTicket, setAuth, user, pinAdmin, isOnline, ncf, setNcfConfig } = useConfigStore();
    
    const [loading, setLoading] = useState(false);
    const [formData, setFormData] = useState({
        nombre: '',
        whatsapp_dueno: '',
        rnc: '',
        direccion: '',
        mensaje_ticket: ''
    });

    useEffect(() => {
        setFormData({
            nombre: negocioNombre || '',
            whatsapp_dueno: negocioWhatsapp || '',
            rnc: negocioRnc || '',
            direccion: negocioDireccion || '',
            mensaje_ticket: negocioMensajeTicket || ''
        });
    }, [negocioNombre, negocioWhatsapp, negocioRnc, negocioDireccion, negocioMensajeTicket]);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!negocioId || !user) return;
        setLoading(true);

        try {
            const { error } = await supabase
                .from('negocios')
                .update({
                    nombre: formData.nombre,
                    whatsapp_dueno: formData.whatsapp_dueno,
                    rnc: formData.rnc,
                    direccion: formData.direccion,
                    mensaje_ticket: formData.mensaje_ticket
                })
                .eq('id', negocioId);

            if (error) throw error;

            // Actualizar estado global
            setAuth(
                user,
                negocioId,
                formData.nombre,
                pinAdmin,
                formData.whatsapp_dueno,
                formData.rnc,
                formData.direccion,
                formData.mensaje_ticket
            );

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
                                            <div className="bg-navy-3/50 rounded-xl p-4 flex flex-wrap gap-6 text-sm">
                                                <div>
                                                    <p className="text-vr-gray text-xs font-semibold uppercase tracking-wider mb-1">Último emitido</p>
                                                    <p className="text-white font-mono font-bold">
                                                        {ncf.actual === 0 ? '—' : `${ncf.tipo}${String(ncf.actual).padStart(8, '0')}`}
                                                    </p>
                                                </div>
                                                <div>
                                                    <p className="text-vr-gray text-xs font-semibold uppercase tracking-wider mb-1">Próximo a emitir</p>
                                                    <p className="text-white font-mono font-bold">
                                                        {ncf.hasta > 0
                                                            ? `${ncf.tipo}${String(ncf.actual === 0 ? ncf.desde : ncf.actual + 1).padStart(8, '0')}`
                                                            : '—'}
                                                    </p>
                                                </div>
                                                <div>
                                                    <p className="text-vr-gray text-xs font-semibold uppercase tracking-wider mb-1">Disponibles</p>
                                                    <p className={`font-bold font-mono ${ncf.hasta - (ncf.actual || ncf.desde - 1) <= 10 ? 'text-vr-red' : 'text-vr-green'}`}>
                                                        {ncf.hasta > 0 ? Math.max(0, ncf.hasta - (ncf.actual === 0 ? ncf.desde - 1 : ncf.actual)) : '—'}
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Alerta de stock bajo */}
                                            {ncf.hasta > 0 && ncf.hasta - (ncf.actual === 0 ? ncf.desde - 1 : ncf.actual) <= 10 && (
                                                <div className="flex items-start gap-2 bg-vr-red/10 border border-vr-red/20 rounded-xl p-3 text-sm text-vr-red">
                                                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                                    <span>Quedan pocos NCF disponibles. Solicita una nueva secuencia a la DGII antes de agotar el rango.</span>
                                                </div>
                                            )}

                                            <p className="text-[11px] text-vr-gray/70">
                                                Los cambios al rango se guardan localmente. El contador se incrementa automáticamente en cada venta. Para reiniciar la secuencia ajusta el campo "Desde".
                                            </p>
                                        </div>
                                    )}
                                </div>

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
                    </div>
                </div>
            </div>
        </PinGuard>
    );
}
