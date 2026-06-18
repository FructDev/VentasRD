// src/components/shared/CajaModal.tsx
'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useConfigStore } from '@/store/useConfigStore';
import { db, getCajaAbierta } from '@/lib/db/dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { CajaLocal } from '@/types/database';
import { formatDOP, formatTicket } from '@/lib/utils';
import { v4 as uuidv4 } from 'uuid';
import { useReactToPrint } from 'react-to-print';
import { TicketCorte, ProductoCorte } from '@/components/TicketCorte';
import { CorteCajaLocal } from '@/types/database';

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
        return getCajaAbierta(negocioId, sucursalId || undefined);
    }, [negocioId, sucursalId]);

    // Todas las ventas desde que se abrió la caja (desglose por método)
    const ventasDesdeAperturaRaw = useLiveQuery(async () => {
        if (!cajaAbierta) return [];
        return db.ventas
            .where('fecha_creacion')
            .above(cajaAbierta.fecha_apertura)
            .toArray();
    }, [cajaAbierta]);
    const ventasDesdeApertura = useMemo(() => ventasDesdeAperturaRaw ?? [], [ventasDesdeAperturaRaw]);

    const resumenVentas = useMemo(() => {
        const r = { efectivo: 0, tarjeta: 0, transferencia: 0, fiado: 0, mixto: 0, total: 0, cantidad: 0 };
        ventasDesdeApertura.forEach(v => {
            r[v.metodo_pago as keyof typeof r] = (r[v.metodo_pago as keyof typeof r] as number) + v.total;
            r.total += v.total;
            r.cantidad++;
        });
        return r;
    }, [ventasDesdeApertura]);

    // Efectivo de ventas en el turno: ventas en efectivo + la porción en efectivo
    // de los pagos mixtos (lo demás no entra a la gaveta).
    const ventasEfectivoDesdeApertura = useMemo(() =>
        ventasDesdeApertura.reduce((s, v) =>
            s + (v.metodo_pago === 'efectivo' ? v.total : v.metodo_pago === 'mixto' ? (v.monto_efectivo ?? 0) : 0)
        , 0),
        [ventasDesdeApertura]);

    // Gastos en EFECTIVO desde la apertura — salen de la gaveta, afectan el cuadre
    const gastosEfectivoTurno = useLiveQuery(async () => {
        if (!cajaAbierta || !negocioId) return 0;
        const gastos = await db.gastos
            .where('[negocio_id+fecha_creacion]')
            .between([negocioId, cajaAbierta.fecha_apertura], [negocioId, Infinity])
            .toArray();
        return gastos
            .filter(g => !g.eliminado && g.metodo === 'efectivo')
            .reduce((s, g) => s + g.monto, 0);
    }, [cajaAbierta, negocioId]) ?? 0;

    const SIN_INGRESO = { efectivo: 0, tarjeta: 0, transferencia: 0, total: 0 };
    // Ingresos de REPARACIONES en el turno, desglosados por método (abonos + saldo)
    const ingresosReparacionesTurno = useLiveQuery(async () => {
        if (!cajaAbierta || !negocioId) return { ...SIN_INGRESO };
        const reps = await db.reparaciones.where('negocio_id').equals(negocioId).toArray();
        const ap = cajaAbierta.fecha_apertura;
        const acc = { efectivo: 0, tarjeta: 0, transferencia: 0, total: 0 };
        const sumar = (metodo: string, monto: number) => {
            if (metodo === 'efectivo') acc.efectivo += monto;
            else if (metodo === 'tarjeta') acc.tarjeta += monto;
            else if (metodo === 'transferencia') acc.transferencia += monto;
            acc.total += monto;
        };
        for (const r of reps) {
            if (r.pagos && r.pagos.length) {
                for (const p of r.pagos) if (p.fecha > ap) sumar(p.metodo, p.monto);
            } else {
                // Legado: abono inicial + saldo a la entrega
                if (r.abono > 0 && r.fecha_creacion > ap) sumar(r.metodo_abono ?? 'efectivo', r.abono);
                if (r.estado === 'entregado' && r.fecha_entrega && r.fecha_entrega > ap) sumar(r.metodo_pago_final ?? 'efectivo', Math.max(0, r.total - r.abono));
            }
        }
        return acc;
    }, [cajaAbierta, negocioId]) ?? { ...SIN_INGRESO };

    // Ingresos de APARTADOS en el turno, desglosados por método (cada abono por su fecha)
    const ingresosApartadosTurno = useLiveQuery(async () => {
        if (!cajaAbierta || !negocioId) return { ...SIN_INGRESO };
        const aps = await db.apartados.where('negocio_id').equals(negocioId).toArray();
        const ap = cajaAbierta.fecha_apertura;
        const acc = { efectivo: 0, tarjeta: 0, transferencia: 0, total: 0 };
        for (const a of aps) {
            for (const ab of a.abonos) {
                if (ab.fecha <= ap) continue;
                if (ab.metodo === 'efectivo') acc.efectivo += ab.monto;
                else if (ab.metodo === 'tarjeta') acc.tarjeta += ab.monto;
                else if (ab.metodo === 'transferencia') acc.transferencia += ab.monto;
                acc.total += ab.monto;
            }
        }
        return acc;
    }, [cajaAbierta, negocioId]) ?? { ...SIN_INGRESO };

    // Atajos de efectivo (para el cuadre de la gaveta)
    const efectivoReparacionesTurno = ingresosReparacionesTurno.efectivo;
    const efectivoApartadosTurno = ingresosApartadosTurno.efectivo;

    // Detalle del efectivo del turno (hilo de dinero): cada movimiento que entra
    // o sale de la gaveta, para auditar de dónde sale el "efectivo esperado".
    const detalleEfectivo = useLiveQuery(async () => {
        if (!cajaAbierta || !negocioId) return [];
        const ap = cajaAbierta.fecha_apertura;
        const items: { key: string; fecha: number; tipo: string; titulo: string; monto: number; signo: 'in' | 'out' }[] = [];

        const ventas = await db.ventas.where('negocio_id').equals(negocioId).filter(v => v.fecha_creacion > ap).toArray();
        ventas.forEach(v => {
            const cash = v.metodo_pago === 'efectivo' ? v.total : v.metodo_pago === 'mixto' ? (v.monto_efectivo ?? 0) : 0;
            if (cash > 0) items.push({ key: `v-${v.id}`, fecha: v.fecha_creacion, tipo: 'Venta', titulo: `Venta #${formatTicket(v.numero_ticket, v.caja_codigo)}`, monto: cash, signo: 'in' });
        });

        const reps = await db.reparaciones.where('negocio_id').equals(negocioId).toArray();
        reps.forEach(r => {
            if (r.pagos && r.pagos.length) {
                r.pagos.forEach((p, i) => {
                    if (p.metodo === 'efectivo' && p.fecha > ap) items.push({ key: `rp-${r.id}-${i}`, fecha: p.fecha, tipo: 'Reparación', titulo: `${r.folio} · ${p.tipo === 'final' ? 'saldo' : 'abono'}`, monto: p.monto, signo: 'in' });
                });
            } else {
                if (r.metodo_abono === 'efectivo' && r.abono > 0 && r.fecha_creacion > ap) items.push({ key: `ra-${r.id}`, fecha: r.fecha_creacion, tipo: 'Reparación', titulo: `${r.folio} · abono`, monto: r.abono, signo: 'in' });
                if (r.estado === 'entregado' && r.metodo_pago_final === 'efectivo' && r.fecha_entrega && r.fecha_entrega > ap) items.push({ key: `rf-${r.id}`, fecha: r.fecha_entrega, tipo: 'Reparación', titulo: `${r.folio} · saldo`, monto: Math.max(0, r.total - r.abono), signo: 'in' });
            }
        });

        const aps = await db.apartados.where('negocio_id').equals(negocioId).toArray();
        aps.forEach(a => a.abonos.forEach((ab, i) => { if (ab.metodo === 'efectivo' && ab.fecha > ap) items.push({ key: `ap-${a.id}-${i}`, fecha: ab.fecha, tipo: 'Apartado', titulo: `${a.folio} · abono`, monto: ab.monto, signo: 'in' }); }));

        const gastos = await db.gastos.where('[negocio_id+fecha_creacion]').between([negocioId, ap], [negocioId, Infinity]).toArray();
        gastos.forEach(g => { if (!g.eliminado && g.metodo === 'efectivo') items.push({ key: `g-${g.id}`, fecha: g.fecha_creacion, tipo: 'Gasto', titulo: g.descripcion || 'Gasto', monto: g.monto, signo: 'out' }); });

        items.sort((a, b) => b.fecha - a.fecha);
        return items;
    }, [cajaAbierta, negocioId]) ?? [];

    const [verDetalle, setVerDetalle] = useState(false);

    const totalContado = useMemo(() => {
        return DENOMINACIONES.reduce((sum, d) => {
            return sum + (d.valor * (denominaciones[String(d.valor)] || 0));
        }, 0);
    }, [denominaciones]);

    const montoEsperado = cajaAbierta
        ? cajaAbierta.monto_apertura + ventasEfectivoDesdeApertura + efectivoReparacionesTurno + efectivoApartadosTurno - gastosEfectivoTurno
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

    // Genera y guarda un registro de corte, luego imprime
    const generarCorte = async (tipo: 'X' | 'Z', extras?: { monto_contado: number; monto_esperado: number; diferencia: number }) => {
        if (!negocioId || !cajaAbierta) return;

        // Cargar detalles de todas las ventas del turno y agrupar por producto
        const ventaIds = ventasDesdeApertura.map(v => v.id);
        const detalles = ventaIds.length > 0
            ? await db.venta_detalles.where('venta_id').anyOf(ventaIds).toArray()
            : [];

        // Agregar por producto_id
        const mapaProductos = new Map<string, { cantidad: number; subtotal: number }>();
        detalles.forEach(d => {
            const prev = mapaProductos.get(d.producto_id) ?? { cantidad: 0, subtotal: 0 };
            mapaProductos.set(d.producto_id, {
                cantidad: prev.cantidad + d.cantidad,
                subtotal: prev.subtotal + d.subtotal,
            });
        });

        // Resolver nombres desde Dexie
        const productosAgrupados: ProductoCorte[] = [];
        for (const [productoId, agg] of mapaProductos.entries()) {
            const prod = await db.productos.get(productoId);
            productosAgrupados.push({
                nombre: prod?.nombre ?? 'Producto eliminado',
                cantidad: agg.cantidad,
                subtotal: agg.subtotal,
            });
        }
        // Ordenar por subtotal descendente
        productosAgrupados.sort((a, b) => b.subtotal - a.subtotal);

        const corte: CorteCajaLocal = {
            id: uuidv4(),
            negocio_id: negocioId,
            caja_id: cajaAbierta.id,
            sucursal_id: sucursalId || undefined,
            tipo,
            fecha_creacion: Date.now(),
            // Método combinado: ventas + reparaciones + apartados (todo el dinero del turno)
            efectivo: resumenVentas.efectivo + ingresosReparacionesTurno.efectivo + ingresosApartadosTurno.efectivo,
            tarjeta: resumenVentas.tarjeta + ingresosReparacionesTurno.tarjeta + ingresosApartadosTurno.tarjeta,
            transferencia: resumenVentas.transferencia + ingresosReparacionesTurno.transferencia + ingresosApartadosTurno.transferencia,
            fiado: resumenVentas.fiado,
            mixto: resumenVentas.mixto,
            total_ventas: resumenVentas.total,
            ingreso_reparaciones: ingresosReparacionesTurno.total,
            ingreso_apartados: ingresosApartadosTurno.total,
            cantidad_transacciones: resumenVentas.cantidad,
            ...(tipo === 'Z' && extras && {
                monto_apertura: cajaAbierta.monto_apertura,
                monto_esperado: extras.monto_esperado,
                monto_contado: extras.monto_contado,
                diferencia: extras.diferencia,
            }),
            estado_sincronizacion: 0,
        };

        await db.cortes_caja.add(corte);
        setProductosCorte(productosAgrupados);
        setCorteActual(corte);
        // Pequeño delay para que React renderice el ticket oculto antes de imprimir
        setTimeout(() => handleImprimirCorte(), 120);
    };

    const abrirCaja = async () => {
        if (!negocioId) return;
        setLoading(true);

        try {
            const ahora = Date.now();
            await db.cajas.add({
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
                // Marcar para que el worker suba el cierre a la nube y no vuelva
                // a traerse como "abierta" en otro dispositivo o tras limpiar caché.
                estado_sincronizacion: 0,
                fecha_actualizacion: Date.now(),
            });

            // Generar Corte Z (guarda + imprime automáticamente)
            await generarCorte('Z', {
                monto_contado: totalContado,
                monto_esperado: montoEsperado,
                diferencia,
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
                    (efectivoReparacionesTurno > 0 ? `🔧 Reparaciones Efectivo: ${formatDOP(efectivoReparacionesTurno)}\n` : '') +
                    (efectivoApartadosTurno > 0 ? `🔖 Apartados Efectivo: ${formatDOP(efectivoApartadosTurno)}\n` : '') +
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
        } catch (e) {
            showToast('Error al cerrar la caja', 'error');
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
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fade-in">
            <div className="bg-navy-2 w-full max-w-lg rounded-2xl border border-navy-3 shadow-2xl overflow-hidden animate-scale-in max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="p-4 sm:p-6 border-b border-navy-3 flex justify-between items-start shrink-0 gap-3">
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
                                onClick={async () => {
                                    await generarCorte('X');
                                    showToast('Corte X imprimiendo…', 'info');
                                }}
                                disabled={loading}
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
                    <div className="px-4 sm:px-6 pt-4 shrink-0 space-y-3">
                        {/* Desglose de ventas del turno */}
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
                                ].filter(l => l.val > 0).map(l => (
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

                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                            <div className="bg-navy p-3 rounded-xl border border-navy-3">
                                <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Apertura</p>
                                <p className="text-lg font-black font-mono text-white">{formatDOP(cajaAbierta!.monto_apertura)}</p>
                            </div>
                            <div className="bg-navy p-3 rounded-xl border border-navy-3">
                                <p className="text-[10px] font-bold text-vr-gray uppercase tracking-wider">Ventas Efectivo</p>
                                <p className="text-lg font-black font-mono text-vr-green">{formatDOP(ventasEfectivoDesdeApertura)}</p>
                            </div>
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
                            {gastosEfectivoTurno > 0 && (
                                <div className="bg-navy p-3 rounded-xl border border-vr-red/20">
                                    <p className="text-[10px] font-bold text-vr-red uppercase tracking-wider">Gastos Efectivo</p>
                                    <p className="text-lg font-black font-mono text-vr-red">- {formatDOP(gastosEfectivoTurno)}</p>
                                </div>
                            )}
                        </div>
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
                        <div className={`mb-4 p-3 rounded-xl text-center font-bold text-sm ${diferencia === 0 ? 'bg-vr-green/10 border border-vr-green/20 text-vr-green' :
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
                        disabled={loading}
                        className="w-full py-4 bg-gold-gradient text-navy font-extrabold rounded-xl hover:brightness-110 transition-all disabled:opacity-30 text-lg"
                    >
                        {loading ? 'Procesando...' : esCierre ? '🔒 Cerrar Caja' : '🔓 Abrir Caja'}
                    </button>
                </div>
            </div>
        </div>
        </>
    );
}
