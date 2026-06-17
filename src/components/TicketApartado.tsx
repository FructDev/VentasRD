// src/components/TicketApartado.tsx
// Comprobante de apartado (contrato inicial, abono o entrega final).
import { forwardRef } from 'react';
import { ApartadoLocal } from '@/types/database';
import { useConfigStore } from '@/store/useConfigStore';

interface TicketApartadoProps {
    apartado: ApartadoLocal;
    modo: 'contrato' | 'abono' | 'entrega';
    nombreNegocio?: string;
    rnc?: string;
    direccion?: string;
    telefono?: string;
}

const TITULO: Record<string, string> = {
    contrato: 'Comprobante de apartado',
    abono: 'Recibo de abono',
    entrega: 'Entrega de apartado',
};

export const TicketApartado = forwardRef<HTMLDivElement, TicketApartadoProps>(({
    apartado: a, modo, nombreNegocio = 'Mi Negocio', rnc, direccion, telefono,
}, ref) => {
    const { impresion } = useConfigStore();
    const es58 = impresion.anchoPapel === '58mm';
    const claseTicket = [
        impresion.tamanoLetra === 'grande' ? 'ticket-grande' : '',
        impresion.densidad === 'compacta' ? 'ticket-compacto' : '',
    ].join(' ');

    const fmtDOP = (n: number) =>
        n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtFecha = (ts?: number | null) => ts ? new Date(ts).toLocaleString('es-DO') : '—';
    const saldo = Math.max(0, a.total - a.abonado);

    return (
        <div className={`hidden print:block font-mono text-sm text-black ${claseTicket}`} ref={ref} style={{ width: impresion.anchoPapel, padding: es58 ? '4px' : '10px' }}>
            <div className="text-center mb-3">
                <h1 className="text-lg font-bold uppercase">{nombreNegocio}</h1>
                {rnc && <p className="text-xs">RNC: {rnc}</p>}
                {direccion && <p className="text-xs">{direccion}</p>}
                {telefono && <p className="text-xs">Tel: {telefono}</p>}
            </div>

            <div className="border-b border-dashed border-black mb-2" />
            <div className="text-center mb-2">
                <p className="text-base font-bold uppercase tracking-widest">{TITULO[modo]}</p>
                <p className="text-sm font-bold">{a.folio}</p>
                <p className="text-xs">{fmtFecha(modo === 'entrega' ? a.fecha_completado : Date.now())}</p>
            </div>
            <div className="border-b border-dashed border-black mb-2" />

            {/* Cliente */}
            <table className="w-full text-xs mb-2">
                <tbody>
                    <tr><td className="py-0.5 font-bold">Cliente</td><td className="py-0.5 text-right">{a.cliente_nombre}</td></tr>
                    {a.cliente_telefono && <tr><td className="py-0.5 font-bold">Teléfono</td><td className="py-0.5 text-right">{a.cliente_telefono}</td></tr>}
                </tbody>
            </table>

            {/* Items */}
            <p className="text-xs font-bold uppercase tracking-wider mb-1">Artículos apartados</p>
            <table className="w-full text-xs mb-2">
                <tbody>
                    {a.items.map((it, i) => (
                        <tr key={i}>
                            <td className="py-0.5 pr-1 break-words">
                                {it.cantidad}× {it.nombre}
                                {it.serial_numero && <div className="text-[10px] text-gray-600">S/N: {it.serial_numero}</div>}
                            </td>
                            <td className="py-0.5 text-right align-top">RD$ {fmtDOP(it.precio_unitario * it.cantidad)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <div className="border-b border-dashed border-black mb-2" />

            {/* Totales */}
            <div className="flex justify-between font-bold text-sm mb-0.5"><span>TOTAL</span><span>RD$ {fmtDOP(a.total)}</span></div>
            <div className="flex justify-between text-xs mb-0.5"><span>Abonado</span><span>RD$ {fmtDOP(a.abonado)}</span></div>
            <div className="flex justify-between font-bold text-sm mb-2">
                <span>{saldo <= 0 ? 'PAGADO' : 'SALDO'}</span>
                <span>RD$ {fmtDOP(saldo)}</span>
            </div>

            {/* Historial de abonos */}
            {a.abonos.length > 0 && (
                <>
                    <div className="border-b border-dashed border-black mb-2" />
                    <p className="text-xs font-bold uppercase tracking-wider mb-1">Abonos</p>
                    <table className="w-full text-xs mb-2">
                        <tbody>
                            {a.abonos.map((ab, i) => (
                                <tr key={i}>
                                    <td className="py-0.5">{new Date(ab.fecha).toLocaleDateString('es-DO')} ({ab.metodo})</td>
                                    <td className="py-0.5 text-right">RD$ {fmtDOP(ab.monto)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            )}

            {/* Firma */}
            <div className="mt-8 mb-1">
                <div className="border-t border-black mx-4" />
                <p className="text-center text-xs mt-1">Firma del cliente</p>
            </div>

            <div className="text-center mt-4 text-xs text-gray-500">
                <p>{modo === 'entrega' ? '¡Gracias por su compra!' : 'Conserve este comprobante para sus abonos.'}</p>
                <p className="mt-1">VentaRD POS</p>
            </div>
        </div>
    );
});

TicketApartado.displayName = 'TicketApartado';
