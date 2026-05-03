// src/components/shared/CajaModal.tsx
'use client';

import { useState, useEffect, useMemo } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { db, getCajaAbierta } from '@/lib/db/dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { CajaLocal } from '@/types/database';
import { formatDOP } from '@/lib/utils';
import { v4 as uuidv4 } from 'uuid';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

const DENOMINACIONES = [
    { valor: 2000, label: 'RD$2,000' },
    { valor: 1000, label: 'RD$1,000' },
    { valor: 500, label: 'RD$500' },
    { valor: 200, label: 'RD$200' },
    { valor: 100, label: 'RD$100' },
    { valor: 50, label: 'RD$50' },
    { valor: 25, label: 'RD$25' },
    { valor: 10, label: 'RD$10' },
    { valor: 5, label: 'RD$5' },
    { valor: 1, label: 'RD$1' },
];

export default function CajaModal({ isOpen, onClose }: Props) {
    const { negocioId, sucursalId, showToast, negocioNombre, negocioWhatsapp } = useConfigStore();
    const [denominaciones, setDenominaciones] = useState<Record<string, number>>({});
    const [notas, setNotas] = useState('');
    const [loading, setLoading] = useState(false);

    const cajaAbierta = useLiveQuery(async () => {
        if (!negocioId) return undefined;
        return getCajaAbierta(negocioId, sucursalId || undefined);
    }, [negocioId, sucursalId]);

    // Ventas de hoy en efectivo desde que se abrió la caja
    const ventasEfectivoDesdeApertura = useLiveQuery(async () => {
        if (!cajaAbierta) return 0;
        const ventas = await db.ventas
            .where('fecha_creacion')
            .above(cajaAbierta.fecha_apertura)
            .toArray();
        return ventas
            .filter(v => v.metodo_pago === 'efectivo')
            .reduce((acc, v) => acc + v.total, 0);
    }, [cajaAbierta]) || 0;

    const totalContado = useMemo(() => {
        return DENOMINACIONES.reduce((sum, d) => {
            return sum + (d.valor * (denominaciones[String(d.valor)] || 0));
        }, 0);
    }, [denominaciones]);

    const montoEsperado = cajaAbierta
        ? cajaAbierta.monto_apertura + ventasEfectivoDesdeApertura
        : 0;
    const diferencia = totalContado - montoEsperado;

    useEffect(() => {
        if (isOpen) {
            setDenominaciones({});
            setNotas('');
        }
    }, [isOpen]);

    const handleDenominacion = (valor: number, cantidad: string) => {
        setDenominaciones(prev => ({
            ...prev,
            [String(valor)]: parseInt(cantidad) || 0
        }));
    };

    const abrirCaja = async () => {
        if (!negocioId) return;
        setLoading(true);

        try {
            await db.cajas.add({
                id: uuidv4(),
                negocio_id: negocioId,
                sucursal_id: sucursalId || undefined,
                estado: 'abierta',
                monto_apertura: totalContado,
                denominaciones_apertura: { ...denominaciones },
                fecha_apertura: Date.now(),
            });
            showToast(`Caja abierta con ${formatDOP(totalContado)}`, 'success');
            onClose();
        } catch (e) {
            showToast('Error al abrir la caja', 'error');
        }
        setLoading(false);
    };

    const cerrarCaja = async () => {
        if (!negocioId || !cajaAbierta) return;
        setLoading(true);

        try {
            await db.cajas.update(cajaAbierta.id, {
                estado: 'cerrada',
                monto_cierre: totalContado,
                monto_esperado: montoEsperado,
                diferencia: diferencia,
                denominaciones_cierre: { ...denominaciones },
                fecha_cierre: Date.now(),
                notas: notas || undefined,
            });
            showToast(
                diferencia === 0
                    ? '¡Cuadre perfecto! Caja cerrada.'
                    : `Caja cerrada. Diferencia: ${formatDOP(diferencia)}`,
                diferencia === 0 ? 'success' : 'info'
            );

            // Generar reporte de WhatsApp
            if (negocioWhatsapp) {
                const fecha = new Date().toLocaleDateString('es-DO');
                const horaApertura = new Date(cajaAbierta.fecha_apertura).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
                const horaCierre = new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
                
                const reporte = `*Cierre de Caja - ${negocioNombre || 'Mi Negocio'}*\n` +
                                `📅 Fecha: ${fecha}\n` +
                                `⏰ Turno: ${horaApertura} a ${horaCierre}\n\n` +
                                `*Resumen Efectivo:*\n` +
                                `💵 Apertura: ${formatDOP(cajaAbierta.monto_apertura)}\n` +
                                `📈 Ventas Efectivo: ${formatDOP(ventasEfectivoDesdeApertura)}\n` +
                                `💰 Efectivo Esperado: ${formatDOP(montoEsperado)}\n` +
                                `🏦 Efectivo Físico Contado: ${formatDOP(totalContado)}\n\n` +
                                `*Cuadre:*\n` +
                                (diferencia === 0 ? `✅ Cuadre Perfecto` : diferencia > 0 ? `🟢 Sobrante: ${formatDOP(diferencia)}` : `🔴 Faltante: ${formatDOP(Math.abs(diferencia))}`) +
                                (notas ? `\n\n*Notas del Cajero:*\n_${notas}_` : '') +
                                `\n\nEnviado automáticamente desde VentaRD.`;
                                
                const url = `https://wa.me/${negocioWhatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(reporte)}`;
                window.open(url, '_blank');
            }

            onClose();
        } catch (e) {
            showToast('Error al cerrar la caja', 'error');
        }
        setLoading(false);
    };

    if (!isOpen) return null;

    const esCierre = !!cajaAbierta;

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fade-in">
            <div className="bg-navy-2 w-full max-w-lg rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="p-6 border-b border-navy-3 flex justify-between items-center shrink-0">
                    <div>
                        <h2 className="text-xl font-display font-bold text-white">
                            {esCierre ? '🔒 Cerrar Caja' : '🔓 Abrir Caja'}
                        </h2>
                        <p className="text-sm text-vr-gray mt-0.5">
                            {esCierre
                                ? `Abierta desde ${new Date(cajaAbierta!.fecha_apertura).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}`
                                : 'Cuenta el dinero para iniciar tu turno'
                            }
                        </p>
                    </div>
                    <button onClick={onClose} className="text-vr-gray hover:text-white font-bold text-xl transition-colors">✕</button>
                </div>

                {/* Info panel for closing */}
                {esCierre && (
                    <div className="px-6 pt-4 shrink-0">
                        <div className="grid grid-cols-2 gap-3">
                            <div className="bg-navy p-3 rounded-xl border border-navy-3">
                                <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Apertura</p>
                                <p className="text-lg font-black font-mono text-white">{formatDOP(cajaAbierta!.monto_apertura)}</p>
                            </div>
                            <div className="bg-navy p-3 rounded-xl border border-navy-3">
                                <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Ventas Efectivo</p>
                                <p className="text-lg font-black font-mono text-vr-green">{formatDOP(ventasEfectivoDesdeApertura)}</p>
                            </div>
                        </div>
                        <div className="mt-3 bg-gold/5 border border-gold/15 p-3 rounded-xl flex justify-between items-center">
                            <span className="text-sm font-bold text-gold">Deberías tener:</span>
                            <span className="text-xl font-black font-mono text-gold">{formatDOP(montoEsperado)}</span>
                        </div>
                    </div>
                )}

                {/* Denominaciones */}
                <div className="flex-1 overflow-y-auto p-6">
                    <p className="text-xs font-bold text-vr-gray uppercase tracking-wider mb-3">Conteo de Denominaciones</p>
                    <div className="space-y-2">
                        {DENOMINACIONES.map(d => (
                            <div key={d.valor} className="flex items-center gap-3">
                                <span className="w-24 text-sm font-bold text-white">{d.label}</span>
                                <span className="text-vr-gray">×</span>
                                <input
                                    type="number" min="0"
                                    className="w-20 bg-navy-3 border border-navy-3 rounded-lg px-3 py-2 text-white font-mono text-center focus:border-gold outline-none transition-all text-sm"
                                    value={denominaciones[String(d.valor)] || ''}
                                    onChange={e => handleDenominacion(d.valor, e.target.value)}
                                    placeholder="0"
                                />
                                <span className="text-vr-gray text-sm font-mono flex-1 text-right">
                                    {(denominaciones[String(d.valor)] || 0) > 0
                                        ? formatDOP(d.valor * (denominaciones[String(d.valor)] || 0))
                                        : '-'}
                                </span>
                            </div>
                        ))}
                    </div>

                    {esCierre && (
                        <div className="mt-4">
                            <label className="block text-xs font-bold text-vr-gray uppercase tracking-wider mb-1.5">Notas (opcional)</label>
                            <textarea
                                className="w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white text-sm focus:border-gold outline-none transition-all resize-none h-16"
                                placeholder="Ej: Se sacaron RD$500 para compra de suministros"
                                value={notas} onChange={e => setNotas(e.target.value)}
                            />
                        </div>
                    )}
                </div>

                {/* Footer con total y botón */}
                <div className="p-6 border-t border-navy-3 shrink-0">
                    <div className="flex justify-between items-center mb-4">
                        <span className="text-lg font-bold text-white">Total Contado</span>
                        <span className="text-3xl font-black font-mono text-gold">{formatDOP(totalContado)}</span>
                    </div>

                    {esCierre && totalContado > 0 && (
                        <div className={`mb-4 p-3 rounded-xl text-center font-bold text-sm ${
                            diferencia === 0 ? 'bg-vr-green/10 border border-vr-green/20 text-vr-green' :
                            diferencia > 0 ? 'bg-gold/10 border border-gold/20 text-gold' :
                            'bg-vr-red/10 border border-vr-red/20 text-vr-red'
                        }`}>
                            {diferencia === 0 ? '✓ Cuadre perfecto' :
                             diferencia > 0 ? `↑ Sobrante: ${formatDOP(diferencia)}` :
                             `↓ Faltante: ${formatDOP(Math.abs(diferencia))}`}
                        </div>
                    )}

                    <button
                        onClick={esCierre ? cerrarCaja : abrirCaja}
                        disabled={loading || totalContado <= 0}
                        className="w-full py-4 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-30 text-lg"
                    >
                        {loading ? 'Procesando...' : esCierre ? '🔒 Cerrar Caja' : '🔓 Abrir Caja'}
                    </button>
                </div>
            </div>
        </div>
    );
}
