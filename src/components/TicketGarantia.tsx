// src/components/TicketGarantia.tsx
// Certificado de garantía imprimible para un producto serializado (por IMEI).
import { forwardRef } from 'react';
import { SerialLocal } from '@/types/database';
import { useConfigStore } from '@/store/useConfigStore';

interface TicketGarantiaProps {
    serial: SerialLocal;
    productoNombre: string;
    nombreNegocio?: string;
    rnc?: string;
    direccion?: string;
    telefono?: string;
}

export const TicketGarantia = forwardRef<HTMLDivElement, TicketGarantiaProps>(({
    serial: s, productoNombre, nombreNegocio = 'Mi Negocio', rnc, direccion, telefono,
}, ref) => {
    const { impresion } = useConfigStore();
    const es58 = impresion.anchoPapel === '58mm';
    const claseTicket = [
        impresion.tamanoLetra === 'grande' ? 'ticket-grande' : '',
        impresion.densidad === 'compacta' ? 'ticket-compacto' : '',
    ].join(' ');

    const fmtDOP = (n: number) =>
        n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtFecha = (ts?: number | null) => ts ? new Date(ts).toLocaleDateString('es-DO') : '—';

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
                <p className="text-base font-bold uppercase tracking-widest">Certificado de garantía</p>
            </div>

            <div className="border-b border-dashed border-black mb-2" />

            <table className="w-full text-xs mb-2">
                <tbody>
                    <tr><td className="py-0.5 font-bold">Producto</td><td className="py-0.5 text-right">{productoNombre}</td></tr>
                    <tr><td className="py-0.5 font-bold">IMEI / Serie</td><td className="py-0.5 text-right">{s.numero_serial}</td></tr>
                    {s.cliente_nombre && <tr><td className="py-0.5 font-bold">Cliente</td><td className="py-0.5 text-right">{s.cliente_nombre}</td></tr>}
                    <tr><td className="py-0.5 font-bold">Fecha de compra</td><td className="py-0.5 text-right">{fmtFecha(s.fecha_venta)}</td></tr>
                    {typeof s.precio_venta === 'number' && s.precio_venta > 0 && (
                        <tr><td className="py-0.5 font-bold">Precio</td><td className="py-0.5 text-right">RD$ {fmtDOP(s.precio_venta)}</td></tr>
                    )}
                </tbody>
            </table>

            <div className="border-b border-dashed border-black mb-2" />

            <div className="text-center py-2 mb-2 border border-dashed border-black">
                {s.garantia_hasta ? (
                    <>
                        <p className="text-sm font-bold uppercase">Garantía: {s.garantia_dias} días</p>
                        <p className="text-xs">Válida hasta {fmtFecha(s.garantia_hasta)}</p>
                    </>
                ) : (
                    <p className="text-sm font-bold uppercase">Sin garantía</p>
                )}
            </div>

            <p className="text-[10px] text-gray-600 leading-snug mb-2">
                La garantía cubre defectos de fábrica. No cubre daños por golpes, humedad,
                mal uso ni manipulación por terceros. Presente este certificado para cualquier reclamo.
            </p>

            <div className="text-center mt-4 text-xs text-gray-500">
                <p>VentaRD POS</p>
            </div>
        </div>
    );
});

TicketGarantia.displayName = 'TicketGarantia';
