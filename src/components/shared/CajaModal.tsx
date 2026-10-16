// src/components/shared/CajaModal.tsx
'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { useCandado } from '@/lib/useCandado';
import { db } from '@/lib/db/dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { formatDOP } from '@/lib/utils';
import { v4 as uuidv4 } from 'uuid';
import { useReactToPrint } from 'react-to-print';
import { TicketCorte, ProductoCorte } from '@/components/TicketCorte';
import { CorteCajaLocal } from '@/types/database';
import { calcularResumenCaja } from '@/lib/domain/caja/resumenTurno';
import { abrirCajaLocal, commitCorteLocal, leerResumenCorte } from '@/lib/domain/caja/commitCorteLocal';
import { localCommandError } from '@/lib/domain/local/errors';

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
    const { negocioId, sucursalId, showToast, negocioNombre, negocioWhatsapp, negocioRnc, negocioDireccion, negocioTelefono } = useConfigStore();
    const { conCandado } = useCandado();
    const [denominaciones, setDenominaciones] = useState<Record<string, number>>({});
    const [notas, setNotas] = useState('');
    const [loading, setLoading] = useState(false);

    // Impresión de cortes
    const ticketCorteRef = useRef<HTMLDivElement>(null);
    const [corteActual, setCorteActual] = useState<CorteCajaLocal | null>(null);
    const [productosCorte, setProductosCorte] = useState<ProductoCorte[]>([]);
    const handleImprimirCorte = useReactToPrint({ contentRef: ticketCorteRef });

    const cajaAbierta = useLiveQuery(async () => {
        if (!negocioId) return undefined;
        const cajas = await db.cajas.where('negocio_id').equals(negocioId)
            .filter(c => c.estado === 'abierta' && (c.sucursal_id ?? null) === (sucursalId || null)).toArray();
        return cajas.length === 1 ? cajas[0] : undefined;
    }, [negocioId, sucursalId]);

    // Una sola lectura coherente para preview y commit. El commit vuelve a leer
    // todas las fuentes bajo lock; estos valores nunca se envían como autoridad.
    const resultadoContexto = useLiveQuery(async () => {
        if (!cajaAbierta) return undefined;
        try {
            return { snapshot: await db.transaction('r', [db.ventas, db.venta_detalles, db.devoluciones, db.gastos,
                db.reparaciones, db.apartados, db.transacciones_fiado, db.shared_entities, db.shared_mutations], () => leerResumenCorte(db, cajaAbierta, Date.now())) };
        } catch (error) { return { error: localCommandError(error) }; }
    }, [cajaAbierta]);
    const contexto = resultadoContexto?.snapshot;
    const resumenVentas = contexto?.resumen ?? calcularResumenCaja([], []);
    const ventasEfectivoDesdeApertura = resumenVentas.efectivo;
    const gastosEfectivoTurno = contexto?.gastos ?? 0;
    const efectivoReparacionesTurno = contexto?.reparaciones.efectivo ?? 0;
    const efectivoApartadosTurno = contexto?.apartados.efectivo ?? 0;
    const abonosFiadoTurno = contexto?.abonos;
    const ingresosFiado = abonosFiadoTurno ?? { efectivo: 0, tarjeta: 0, transferencia: 0, total: 0, noClasificados: 0 };
    const detalleEfectivo = contexto?.detalleEfectivo ?? [];

    const [verDetalle, setVerDetalle] = useState(false);

    const totalContado = useMemo(() => {
        return DENOMINACIONES.reduce((sum, d) => {
            return sum + (d.valor * (denominaciones[String(d.valor)] || 0));
        }, 0);
    }, [denominaciones]);

    const montoEsperado = contexto?.esperado ?? 0;
    const diferencia = totalContado - montoEsperado;

    useEffect(() => {
        if (isOpen) {
            setDenominaciones({});
            setNotas('');
        }
    }, [isOpen]);

    const handleDenominacion = (valor: number, cantidad: string) => {
        if (cantidad && !/^\d+$/.test(cantidad)) { showToast('Las denominaciones requieren cantidades enteras no negativas.', 'error'); return; }
        setDenominaciones(prev => ({
            ...prev,
            [String(valor)]: parseInt(cantidad) || 0
        }));
    };

    // Renderizado/impresión siempre después del commit, nunca dentro de Dexie.
    const presentarCorte = (corte: CorteCajaLocal, productos: ProductoCorte[]) => {
        setProductosCorte(productos);
        setCorteActual(corte);
        setTimeout(() => handleImprimirCorte(), 120);
    };
    const generarCorte = async () => {
        if (!negocioId || !cajaAbierta) return;
        setLoading(true);
        try {
            const result = await commitCorteLocal(db, { operationId: uuidv4(), negocioId,
                sucursalId: sucursalId || undefined, cajaId: cajaAbierta.id, tipo: 'X' });
            presentarCorte(result.corte, result.snapshot.productos);
            showToast('Corte X guardado. Preparando impresión…', 'info');
        } catch (error) { showToast(localCommandError(error), 'error'); }
        finally { setLoading(false); }
    };

    const abrirCaja = async () => {
        if (!negocioId) return;
        setLoading(true);

        try {
            const ahora = Date.now();
            await abrirCajaLocal(db, {
                id: uuidv4(),
                negocio_id: negocioId,
                sucursal_id: sucursalId || undefined,
                estado: 'abierta',
                monto_apertura: totalContado,
                denominaciones_apertura: { ...denominaciones },
                fecha_apertura: ahora,
                estado_sincronizacion: 0,
                fecha_actualizacion: ahora,
            });
            showToast(
                totalContado > 0
                    ? `Caja abierta con ${formatDOP(totalContado)}`
                    : 'Caja abierta en cero',
                'success'
            );
            onClose();
        } catch (error) {
            showToast(localCommandError(error), 'error');
        }
        setLoading(false);
    };

    const cerrarCaja = async () => {
        if (!negocioId || !cajaAbierta) return;
        if (!abonosFiadoTurno) { showToast('Espera a que termine de cargar el resumen de abonos.', 'info'); return; }
        setLoading(true);

        try {
            // Serializa el cierre con registrarAbonoLocal: un abono confirmado
            // antes del cierre entra; después del cierre se rechaza.
            const { corte, snapshot } = await commitCorteLocal(db, {
                operationId: uuidv4(), cajaId: cajaAbierta.id, negocioId, sucursalId: sucursalId || undefined,
                tipo: 'Z', contado: totalContado, denominaciones: { ...denominaciones }, notas: notas || undefined,
            });
            const montoEsperado = corte.monto_esperado!;
            const diferencia = corte.diferencia!;
            const abonos = snapshot.abonos;
            const ventasEfectivoDesdeApertura = snapshot.resumen.efectivo;
            const resumenVentas = snapshot.resumen;
            const efectivoReparacionesTurno = snapshot.reparaciones.efectivo;
            const efectivoApartadosTurno = snapshot.apartados.efectivo;
            const gastosEfectivoTurno = snapshot.gastos;
            presentarCorte(corte, snapshot.productos);

            showToast(
                diferencia === 0
                    ? '¡Cuadre perfecto! Caja cerrada.'
                    : `Caja cerrada. Diferencia: ${formatDOP(diferencia)}`,
                diferencia === 0 ? 'success' : 'info'
            );

            // Generar reporte de WhatsApp
            if (negocioWhatsapp) {
                const fecha = new Date(corte.fecha_creacion).toLocaleDateString('es-DO');
                const horaApertura = new Date(cajaAbierta.fecha_apertura).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
                const horaCierre = new Date(corte.fecha_creacion).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });

                const reporte = `*Cierre de Caja - ${negocioNombre || 'Mi Negocio'}*\n` +
                    `📅 Fecha: ${fecha}\n` +
                    `⏰ Turno: ${horaApertura} a ${horaCierre}\n\n` +
                    `*Resumen Efectivo:*\n` +
                    `💵 Apertura: ${formatDOP(cajaAbierta.monto_apertura)}\n` +
                    `📈 Ventas Efectivo (neto): ${formatDOP(ventasEfectivoDesdeApertura)}\n` +
                    (resumenVentas.efectivoDevuelto > 0 ? `↩️ Devoluciones Efectivo: -${formatDOP(resumenVentas.efectivoDevuelto)}\n` : '') +
                    (efectivoReparacionesTurno > 0 ? `🔧 Reparaciones Efectivo: ${formatDOP(efectivoReparacionesTurno)}\n` : '') +
                    (efectivoApartadosTurno > 0 ? `🔖 Apartados Efectivo: ${formatDOP(efectivoApartadosTurno)}\n` : '') +
                    (abonos.efectivo > 0 ? `💵 Abonos Fiado Efectivo: ${formatDOP(abonos.efectivo)}\n` : '') +
                    (abonos.noClasificados > 0 ? `⚠️ ${abonos.noClasificados} abono(s) sin contexto verificable: no incluidos en cuadre.\n` : '') +
                    (gastosEfectivoTurno > 0 ? `🧾 Gastos Efectivo: -${formatDOP(gastosEfectivoTurno)}\n` : '') +
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
        } catch (error) {
            showToast(localCommandError(error), 'error');
        }
        setLoading(false);
    };

    // Ticket oculto para impresión de cortes (fuera del modal para evitar clipping).
    // Se mantiene montado aunque el modal se cierre, para que la impresión diferida
    // del Corte Z (dispara ~120ms tras cerrar) encuentre el contenido del ticket.
    const ticketOculto = corteActual ? (
        <div style={{ display: 'none' }}>
            <TicketCorte
                ref={ticketCorteRef}
                corte={corteActual}
                productos={productosCorte}
                nombreNegocio={negocioNombre || 'VentaRD'}
                rnc={negocioRnc || undefined}
                direccion={negocioDireccion || undefined}
                telefono={negocioTelefono || undefined}
            />
        </div>
    ) : null;

    // Con el modal cerrado igual renderizamos el ticket pendiente de imprimir.
    if (!isOpen) return <>{ticketOculto}</>;

    const esCierre = !!cajaAbierta;

    return (
        <>
        {ticketOculto}
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-center justify-center p-2 sm:p-4 animate-fade-in">
            <div className={`bg-navy-2 w-full ${esCierre
                ? 'max-w-5xl md:grid md:grid-cols-[minmax(15rem,0.85fr)_minmax(24rem,1.15fr)] md:grid-rows-[auto_minmax(0,1fr)_auto]'
                : 'max-w-3xl flex flex-col'
            } rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)]`}>
                {/* Header */}
                <div className="p-4 sm:px-6 sm:py-4 border-b border-navy-3 flex justify-between items-start shrink-0 gap-3 md:col-span-2 md:col-start-1 md:row-start-1">
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
                    <div className="flex items-center gap-2 shrink-0">
                        {esCierre && (
                            <button
                                onClick={() => void conCandado(generarCorte)()}
                                disabled={loading || !abonosFiadoTurno}
                                className="px-3 py-1.5 text-xs font-bold bg-navy-3 border border-navy-3 hover:border-gold/40 hover:text-gold text-vr-gray rounded-lg transition-all"
                            >
                                📊 Corte Parcial
                            </button>
                        )}
                        <button onClick={onClose} className="text-vr-gray hover:text-white font-bold text-xl transition-colors px-1">✕</button>
                    </div>
                </div>

                {/* Info panel for closing */}
                {esCierre && (
                    <div className="px-4 py-4 sm:px-5 min-h-0 space-y-3 md:col-start-1 md:row-start-2 md:overflow-y-auto md:border-r md:border-navy-3">
                        {/* Desglose de ventas del turno */}
                        {resultadoContexto?.error && (
                            <p role="alert" className="text-sm text-vr-red bg-vr-red/5 p-3 rounded-xl">{resultadoContexto.error}</p>
                        )}
                        <div className="bg-navy rounded-xl border border-navy-3 overflow-hidden">
                            <div className="px-3 py-2 border-b border-navy-3 flex justify-between items-center">
                                <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Ventas del turno</p>
                                <p className="text-xs font-bold text-vr-gray">{resumenVentas.cantidad} transacciones</p>
                            </div>
                            <div className="p-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                                {[
                                    { label: 'Efectivo',      val: resumenVentas.efectivo,      color: 'text-vr-green' },
                                    { label: 'Tarjeta',       val: resumenVentas.tarjeta,       color: 'text-blue-400' },
                                    { label: 'Transfer.',     val: resumenVentas.transferencia, color: 'text-purple-400' },
                                    { label: 'Fiado',         val: resumenVentas.fiado,         color: 'text-vr-orange' },
                                    { label: 'Mixto',         val: resumenVentas.mixto,         color: 'text-gold' },
                                ].filter(l => l.val !== 0).map(l => (
                                    <div key={l.label} className="flex justify-between gap-2">
                                        <span className="text-vr-gray">{l.label}</span>
                                        <span className={`font-mono font-bold ${l.color}`}>{formatDOP(l.val)}</span>
                                    </div>
                                ))}
                                {resumenVentas.cantidad === 0 && (
                                    <p className="col-span-2 text-vr-gray text-center py-1">Sin ventas en este turno</p>
                                )}
                            </div>
                            <div className="px-3 py-2 border-t border-navy-3 flex justify-between">
                                <span className="text-xs font-bold text-white">Total ventas</span>
                                <span className="font-mono font-black text-white text-sm">{formatDOP(resumenVentas.total)}</span>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                            <div className="bg-navy p-3 rounded-xl border border-navy-3">
                                <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Apertura</p>
                                <p className="text-lg font-black font-mono text-white">{formatDOP(cajaAbierta!.monto_apertura)}</p>
                            </div>
                            <div className="bg-navy p-3 rounded-xl border border-navy-3">
                                <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Ventas Efectivo Neto</p>
                                <p className="text-lg font-black font-mono text-vr-green">{formatDOP(ventasEfectivoDesdeApertura)}</p>
                            </div>
                            {resumenVentas.efectivoDevuelto > 0 && (
                                <div className="bg-navy p-3 rounded-xl border border-vr-red/20">
                                    <p className="text-[10px] font-bold text-vr-red uppercase tracking-wider">Devoluciones Efectivo</p>
                                    <p className="text-lg font-black font-mono text-vr-red">- {formatDOP(resumenVentas.efectivoDevuelto)}</p>
                                </div>
                            )}
                            {efectivoReparacionesTurno > 0 && (
                                <div className="bg-navy p-3 rounded-xl border border-navy-3">
                                    <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Reparac. Efectivo</p>
                                    <p className="text-lg font-black font-mono text-vr-green">{formatDOP(efectivoReparacionesTurno)}</p>
                                </div>
                            )}
                            {efectivoApartadosTurno > 0 && (
                                <div className="bg-navy p-3 rounded-xl border border-navy-3">
                                    <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Apartados Efectivo</p>
                                    <p className="text-lg font-black font-mono text-vr-green">{formatDOP(efectivoApartadosTurno)}</p>
                                </div>
                            )}
                            {(contexto?.depositosDevueltos ?? 0) > 0 && (
                                <div className="bg-navy p-3 rounded-xl border border-vr-red/20"><p className="text-[10px] font-bold text-vr-red uppercase tracking-wider">Depósitos devueltos · efectivo</p><p className="text-lg font-black font-mono text-vr-red">- {formatDOP(contexto!.depositosDevueltos)}</p></div>
                            )}
                            {gastosEfectivoTurno > 0 && (
                                <div className="bg-navy p-3 rounded-xl border border-vr-red/20">
                                    <p className="text-[10px] font-bold text-vr-red uppercase tracking-wider">Gastos Efectivo</p>
                                    <p className="text-lg font-black font-mono text-vr-red">- {formatDOP(gastosEfectivoTurno)}</p>
                                </div>
                            )}
                        </div>
                        {ingresosFiado.total > 0 && (
                            <div className="bg-navy p-3 rounded-xl border border-vr-green/20">
                                <p className="text-xs font-bold text-vr-gray">Abonos fiado · efectivo</p>
                                <p className="text-lg font-black font-mono text-vr-green">{formatDOP(ingresosFiado.efectivo)}</p>
                                <p className="text-xs text-vr-gray">Tarjeta: {formatDOP(ingresosFiado.tarjeta)} · Transferencia: {formatDOP(ingresosFiado.transferencia)}</p>
                            </div>
                        )}
                        {ingresosFiado.noClasificados > 0 && (
                            <p role="status" className="text-xs text-gold bg-gold/5 p-3 rounded-xl">Hay {ingresosFiado.noClasificados} abono(s) sin caja, sucursal o método verificable en esta ventana. No se incluyeron en el cuadre; revisa el histórico antes de cerrar.</p>
                        )}
                        {!!contexto?.limites.length && (
                            <p role="status" className="text-xs text-gold bg-gold/5 p-3 rounded-xl">
                                El resumen incluye limitaciones históricas. Los registros legacy se atribuyen por ventana cuando falta vínculo de turno; los métodos desconocidos no se inventan. Devolver stock no prueba un reintegro bancario.
                            </p>
                        )}
                        <div className="bg-gold/5 border border-gold/15 p-3 rounded-xl flex justify-between items-center">
                            <span className="text-sm font-bold text-gold">Deberías tener:</span>
                            <span className="text-xl font-black font-mono text-gold">{formatDOP(montoEsperado)}</span>
                        </div>

                        {/* Hilo de dinero: detalle de cada movimiento de efectivo del turno */}
                        <button
                            type="button"
                            onClick={() => setVerDetalle(v => !v)}
                            className="w-full text-xs font-bold text-vr-gray hover:text-gold transition-colors text-center py-1"
                        >
                            {verDetalle ? '▲ Ocultar detalle del efectivo' : `▼ Ver detalle del efectivo (${detalleEfectivo.length})`}
                        </button>
                        {verDetalle && (
                            <div className="bg-navy rounded-xl border border-navy-3 max-h-48 overflow-y-auto divide-y divide-navy-3/50">
                                {detalleEfectivo.length === 0 ? (
                                    <p className="text-xs text-vr-gray text-center py-4">Sin movimientos de efectivo en el turno.</p>
                                ) : detalleEfectivo.map(m => (
                                    <div key={m.key} className="flex items-center gap-2 px-3 py-2">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-bold text-white truncate">{m.titulo}</p>
                                            <p className="text-[10px] text-vr-gray">{m.tipo} · {new Date(m.fecha).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}</p>
                                        </div>
                                        <span className={`font-mono font-bold text-xs shrink-0 ${m.signo === 'out' ? 'text-vr-red' : 'text-vr-green'}`}>
                                            {m.signo === 'out' ? '−' : '+'}{formatDOP(m.monto)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Denominaciones */}
                <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 md:col-start-2 md:row-start-2">
                    <div className="flex items-center justify-between gap-3 mb-3">
                        <p className="text-sm font-bold text-white uppercase tracking-wider">Conteo de denominaciones</p>
                        <span className="text-xs text-vr-gray">Billetes y monedas</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {DENOMINACIONES.map(d => (
                            <label
                                key={d.valor}
                                className="grid grid-cols-[minmax(4.5rem,1fr)_auto_minmax(6rem,1.15fr)] items-center gap-2 rounded-xl border border-navy-3 bg-navy px-3 py-2.5 focus-within:border-gold/60 focus-within:bg-gold/5 transition-colors"
                            >
                                <span className="text-base font-black text-white whitespace-nowrap">{d.label}</span>
                                <span className="text-vr-gray font-bold" aria-hidden="true">×</span>
                                <input
                                    type="number"
                                    min="0"
                                    inputMode="numeric"
                                    aria-label={`Cantidad de ${d.label}`}
                                    className="w-full min-w-0 h-12 bg-navy-3 border border-navy-3 rounded-lg px-3 text-white font-mono font-bold text-center focus:border-gold outline-none transition-all text-lg"
                                    value={denominaciones[String(d.valor)] || ''}
                                    onChange={e => handleDenominacion(d.valor, e.target.value)}
                                    placeholder="0"
                                />
                                <span className="col-span-3 text-vr-gray text-xs font-mono text-right min-h-4">
                                    {(denominaciones[String(d.valor)] || 0) > 0
                                        ? formatDOP(d.valor * (denominaciones[String(d.valor)] || 0))
                                        : '-'}
                                </span>
                            </label>
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
                <div className="p-4 sm:px-6 border-t border-navy-3 shrink-0 md:col-span-2 md:col-start-1 md:row-start-3">
                    <div className="md:flex md:items-stretch md:gap-5">
                        <div className="flex-1">
                            <div className="flex justify-between items-center mb-3 md:mb-0">
                                <span className="text-lg font-bold text-white">Total Contado</span>
                                <span className="text-3xl font-black font-mono text-gold">{formatDOP(totalContado)}</span>
                            </div>

                            {esCierre && totalContado > 0 && (
                                <div className={`mb-3 md:mt-2 md:mb-0 px-3 py-2 rounded-xl text-center font-bold text-sm ${diferencia === 0 ? 'bg-vr-green/10 border border-vr-green/20 text-vr-green' :
                                        diferencia > 0 ? 'bg-gold/10 border border-gold/20 text-gold' :
                                            'bg-vr-red/10 border border-vr-red/20 text-vr-red'
                                    }`}>
                                    {diferencia === 0 ? '✓ Cuadre perfecto' :
                                        diferencia > 0 ? `↑ Sobrante: ${formatDOP(diferencia)}` :
                                            `↓ Faltante: ${formatDOP(Math.abs(diferencia))}`}
                                </div>
                            )}
                        </div>

                        <button
                            onClick={() => void conCandado(esCierre ? cerrarCaja : abrirCaja)()}
                            disabled={loading || (esCierre && !abonosFiadoTurno)}
                            className="w-full md:w-72 md:self-stretch py-3 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-30 text-lg"
                        >
                            {loading ? 'Procesando...' : esCierre ? '🔒 Cerrar Caja' : '🔓 Abrir Caja'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
        </>
    );
}
