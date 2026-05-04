'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase/client';
import { useConfigStore } from '@/store/useConfigStore';
import TopBar from '@/components/shared/TopBar';
import PinGuard from '@/components/ui/PinGuard';

export default function ConfiguracionPage() {
    const { negocioId, showToast, negocioNombre, negocioWhatsapp, negocioRnc, negocioDireccion, negocioMensajeTicket, setAuth, user, pinAdmin, isOnline } = useConfigStore();
    
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
                <div className="flex-1 p-8">
                    <div className="max-w-3xl mx-auto">
                        <div className="mb-8">
                            <h1 className="text-3xl font-display font-black text-white">Configuración del Negocio</h1>
                            <p className="text-vr-gray mt-2">Personaliza la información que aparece en los tickets y reportes.</p>
                        </div>

                        <div className="bg-navy-2 rounded-2xl border border-navy-3 overflow-hidden shadow-2xl">
                            <form onSubmit={handleSave} className="p-8 space-y-6">
                                
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
                                        className="px-8 py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
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
