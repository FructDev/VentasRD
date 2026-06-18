// src/components/TicketReparacion.tsx
// Recibo imprimible de una reparación (recepción o entrega).
import { forwardRef } from 'react';
import { ReparacionLocal } from '@/types/database';
import { useConfigStore } from '@/store/useConfigStore';

interface TicketReparacionProps {
    reparacion: ReparacionLocal;
    // 'recepcion' = comprobante al recibir el equipo; 'entrega' = al entregarlo
    modo: 'recepcion' | 'entrega';
    nombreNegocio?: string;
    rnc?: string;
    direccion?: string;
    telefono?: string;
}

const ESTADO_LABEL: Record<string, string> = {
    recibido: 'Recibido',
    diagnostico: 'En diagnóstico',
    cotizado: 'Cotizado',
    en_reparacion: 'En reparación',
    esperando_repuesto: 'Esperando repuesto',
    listo: 'Listo para entregar',
    entregado: 'Entregado',
    no_reparado: 'No reparado',
    abandonado: 'Abandonado',
    cancelado: 'Cancelado',
};

export const TicketReparacion = forwardRef<HTMLDivElement, TicketReparacionProps>(({
    reparacion: r, modo, nombreNegocio = 'Mi Negocio', rnc, direccion, telefono,
}, ref) => {
    const { impresion } = useConfigStore();
    const es58 = impresion.anchoPapel === '58mm';
    const claseTicket = [
        impresion.tamanoLetra === 'grande' ? 'ticket-grande' : '',
        impresion.densidad === 'compacta' ? 'ticket-compacto' : '',
    ].join(' ');

    const fmtDOP = (n: number) =>
        n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtFecha = (ts?: number) => ts ? new Date(ts).toLocaleString('es-DO') : '';

    const repuestosTotal = r.repuestos.reduce((s, x) => s + x.precio * x.cantidad, 0);
    const saldo = Math.max(0, r.total - r.abono);
    // En recepción, si aún no hay costo (sin repuestos ni mano de obra), está pendiente de cotizar
    const sinCotizar = modo === 'recepcion' && r.total <= 0 && r.repuestos.length === 0 && r.mano_obra <= 0;

    return (
        <div className={`hidden print:block font-mono text-sm text-black ${claseTicket}`} ref={ref} style={{ width: impresion.anchoPapel, padding: es58 ? '4px' : '10px' }}>
            {/* Cabecera */}
            <div className="text-center mb-3">
                <h1 className="text-lg font-bold uppercase">{nombreNegocio}</h1>
                {rnc && <p className="text-xs">RNC: {rnc}</p>}
                {direccion && <p className="text-xs">{direccion}</p>}
                {telefono && <p className="text-xs">Tel: {telefono}</p>}
            </div>

            <div className="border-b border-dashed border-black mb-2" />

            <div className="text-center mb-2">
                <p className="text-base font-bold uppercase tracking-widest">
                    {modo === 'entrega' ? 'Entrega de reparación' : 'Recibo de reparación'}
                </p>
                <p className="text-sm font-bold">{r.folio}</p>
                <p className="text-xs">{fmtFecha(modo === 'entrega' ? r.fecha_entrega : r.fecha_creacion)}</p>
            </div>

            <div className="border-b border-dashed border-black mb-2" />

            {/* Cliente */}
            <table className="w-full text-xs mb-2">
                <tbody>
                    <tr><td className="py-0.5 font-bold">Cliente</td><td className="py-0.5 text-right">{r.cliente_nombre}</td></tr>
                    {r.cliente_telefono && <tr><td className="py-0.5 font-bold">Teléfono</td><td className="py-0.5 text-right">{r.cliente_telefono}</td></tr>}
                </tbody>
            </table>

            {/* Equipo */}
            <p className="text-xs font-bold uppercase tracking-wider mb-1">Equipo</p>
            <table className="w-full text-xs mb-2">
                <tbody>
                    <tr><td className="py-0.5">Modelo</td><td className="py-0.5 text-right">{[r.equipo_marca, r.equipo_modelo].filter(Boolean).join(' ')}</td></tr>
                    {r.equipo_imei && <tr><td className="py-0.5">IMEI/Serie</td><td className="py-0.5 text-right">{r.equipo_imei}</td></tr>}
                    {r.equipo_color && <tr><td className="py-0.5">Color</td><td className="py-0.5 text-right">{r.equipo_color}</td></tr>}
                    {r.accesorios && <tr><td className="py-0.5">Accesorios</td><td className="py-0.5 text-right">{r.accesorios}</td></tr>}
                    <tr><td className="py-0.5">Estado</td><td className="py-0.5 text-right">{ESTADO_LABEL[r.estado] ?? r.estado}</td></tr>
                </tbody>
            </table>

            {/* Condición al recibir */}
            {((r.condicion_checklist && r.condicion_checklist.length > 0) || r.condicion_entrada) && (
                <>
                    <p className="text-xs font-bold uppercase tracking-wider mb-0.5">Condición al recibir</p>
                    {r.condicion_checklist && r.condicion_checklist.length > 0 && (
                        <p className="text-xs mb-1 break-words">{r.condicion_checklist.join(' · ')}</p>
                    )}
                    {r.condicion_entrada && <p className="text-xs mb-2 break-words">{r.condicion_entrada}</p>}
                </>
            )}

            {/* Problema / diagnóstico */}
            <p className="text-xs font-bold uppercase tracking-wider mb-0.5">Problema reportado</p>
            <p className="text-xs mb-2 break-words">{r.problema_reportado || '—'}</p>
            {r.diagnostico && (
                <>
                    <p className="text-xs font-bold uppercase tracking-wider mb-0.5">Diagnóstico</p>
                    <p className="text-xs mb-2 break-words">{r.diagnostico}</p>
                </>
            )}

            <div className="border-b border-dashed border-black mb-2" />

            {/* Costos */}
            {sinCotizar ? (
                <div className="text-center text-sm font-bold py-2 mb-2 border border-dashed border-black">
                    PENDIENTE DE COTIZACIÓN
                </div>
            ) : (
            <>
            {r.repuestos.length > 0 && (
                <>
                    <p className="text-xs font-bold uppercase tracking-wider mb-1">Repuestos</p>
                    <table className="w-full text-xs mb-2">
                        <tbody>
                            {r.repuestos.map((x, i) => (
                                <tr key={i}>
                                    <td className="py-0.5 pr-1 break-words">{x.nombre} ×{x.cantidad}</td>
                                    <td className="py-0.5 text-right">RD$ {fmtDOP(x.precio * x.cantidad)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            )}
            <table className="w-full text-xs mb-2">
                <tbody>
                    {repuestosTotal > 0 && <tr><td className="py-0.5">Repuestos</td><td className="py-0.5 text-right">RD$ {fmtDOP(repuestosTotal)}</td></tr>}
                    <tr><td className="py-0.5">Mano de obra</td><td className="py-0.5 text-right">RD$ {fmtDOP(r.mano_obra)}</td></tr>
                </tbody>
            </table>

            <div className="flex justify-between font-bold text-sm mb-0.5">
                <span>TOTAL</span>
                <span>RD$ {fmtDOP(r.total)}</span>
            </div>
            {r.abono > 0 && (
                <div className="flex justify-between text-xs mb-0.5">
                    <span>Abono</span>
                    <span>- RD$ {fmtDOP(r.abono)}</span>
                </div>
            )}
            <div className="flex justify-between font-bold text-sm mb-2">
                <span>{modo === 'entrega' ? 'PAGADO' : 'SALDO PENDIENTE'}</span>
                <span>RD$ {fmtDOP(modo === 'entrega' ? r.total : saldo)}</span>
            </div>
            </>
            )}

            {/* Garantía (en entrega) */}
            {modo === 'entrega' && r.garantia_hasta && (
                <>
                    <div className="border-b border-dashed border-black mb-2" />
                    <div className="text-center text-xs py-1 border border-dashed border-black">
                        <p className="font-bold uppercase">Garantía de reparación</p>
                        <p>{r.garantia_dias} días · hasta {new Date(r.garantia_hasta).toLocaleDateString('es-DO')}</p>
                    </div>
                </>
            )}

            {/* Firma del cliente */}
            <div className="mt-8 mb-1">
                <div className="border-t border-black mx-4" />
                <p className="text-center text-xs mt-1">
                    {modo === 'entrega' ? 'Firma de quien retira' : 'Firma del cliente'}
                </p>
                {modo === 'recepcion' && (
                    <p className="text-center text-[10px] text-gray-600 mt-0.5 px-2">
                        Confirmo que entrego el equipo en la condición aquí descrita.
                    </p>
                )}
            </div>

            <div className="text-center mt-4 text-xs text-gray-500">
                <p>Conserve este comprobante para retirar su equipo.</p>
                <p className="mt-1">VentaRD POS</p>
            </div>
        </div>
    );
});

TicketReparacion.displayName = 'TicketReparacion';
