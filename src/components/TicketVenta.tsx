// src/components/TicketVenta.tsx
import { forwardRef, Fragment } from 'react';
import { CartItem } from '@/store/useCartStore';
import { useConfigStore } from '@/store/useConfigStore';
import { formatTicket } from '@/lib/utils';

interface TicketProps {
    items: CartItem[];
    subtotal: number;
    itbis: number;
    descuento?: number;
    total: number;
    metodoPago: string;
    montoRecibido: string;
    devuelta: number;
    nombreNegocio?: string;
    rnc?: string;
    direccion?: string;
    telefono?: string;
    numeroTicket?: number;
    mensajePie?: string;
    ncf?: string; // Número de Comprobante Fiscal (ej: B0200000001)
    logoUrl?: string;  // Data URL del logo del negocio
    vendedor?: string; // Nombre de quien atendió la venta
    cajaCodigo?: string; // Prefijo de la caja emisora (ej: "C7K")
}

export const TicketVenta = forwardRef<HTMLDivElement, TicketProps>(({
    items, subtotal, itbis, descuento = 0, total, metodoPago, montoRecibido, devuelta,
    nombreNegocio = 'Mi Negocio', rnc, direccion = 'Ciudad, RD', telefono = '809-000-0000',
    numeroTicket, mensajePie, ncf, logoUrl, vendedor, cajaCodigo
}, ref) => {
    const { impresion } = useConfigStore();

    const fechaActual = new Date().toLocaleString('es-DO');
    const ticketNum = formatTicket(numeroTicket, cajaCodigo);

    const es58 = impresion.anchoPapel === '58mm';
    const claseTicket = [
        impresion.tamanoLetra === 'grande' ? 'ticket-grande' : '',
        impresion.densidad === 'compacta' ? 'ticket-compacto' : '',
    ].join(' ');

    const Contenido = () => (
        <>
            {/* Cabecera del Negocio */}
            <div className="text-center mb-4">
                {logoUrl && impresion.mostrarLogo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={logoUrl}
                        alt={nombreNegocio}
                        className="mx-auto mb-2"
                        style={{ maxWidth: es58 ? '32mm' : '45mm', maxHeight: es58 ? '16mm' : '22mm', objectFit: 'contain' }}
                    />
                )}
                <h1 className={`${es58 ? 'text-base' : 'text-xl'} font-bold uppercase`}>{nombreNegocio}</h1>
                {rnc && <p className="text-xs">RNC: {rnc}</p>}
                <p className="text-xs">{direccion}</p>
                <p className="text-xs">Tel: {telefono}</p>
                <p className="text-xs mt-2">Fecha: {fechaActual}</p>
                <p className="text-xs font-bold mt-1">Ticket #: {ticketNum}</p>
                {vendedor && <p className="text-xs">Le atendió: {vendedor}</p>}
            </div>

            {/* NCF */}
            {ncf && (
                <>
                    <div className="border-b border-dashed border-black mb-2"></div>
                    <div className="text-center mb-2">
                        <p className="text-[10px] font-bold uppercase tracking-widest">Comprobante Fiscal</p>
                        <p className="text-base font-bold tracking-wider">{ncf}</p>
                        <p className="text-[10px]">
                            {ncf.startsWith('B01') ? 'Crédito Fiscal' : 'Consumidor Final'}
                        </p>
                    </div>
                </>
            )}

            <div className="border-b border-dashed border-black mb-2"></div>

            {/* Lista de Productos */}
            <table className="w-full text-left text-xs mb-2">
                <thead>
                    <tr className="border-b border-dashed border-black">
                        <th className="py-1">CANT</th>
                        <th className="py-1">DESCRIPCIÓN</th>
                        <th className="py-1 text-right">IMPORTE</th>
                    </tr>
                </thead>
                <tbody>
                    {items.map((item) => (
                        <tr key={item.id}>
                            <td className="py-1 align-top">{item.cantidad}</td>
                            <td className="py-1 pr-2 align-top break-words">
                                {item.nombre}
                                {item.serial_numero && <div className="text-[10px] text-gray-600">S/N: {item.serial_numero}</div>}
                                {item.cantidad > 1 && <div className="text-[10px] text-gray-500">@ {item.precio_venta.toFixed(2)}</div>}
                            </td>
                            <td className="py-1 text-right align-top">{(item.precio_venta * item.cantidad).toFixed(2)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <div className="border-b border-dashed border-black mb-2"></div>

            {/* Totales */}
            <div className="flex flex-col items-end text-xs mb-4">
                <div className="flex justify-between w-full"><span>Subtotal:</span> <span>RD$ {subtotal.toFixed(2)}</span></div>
                <div className="flex justify-between w-full"><span>ITBIS:</span> <span>RD$ {itbis.toFixed(2)}</span></div>
                {descuento > 0 && (
                    <div className="flex justify-between w-full"><span>Descuento:</span> <span>- RD$ {descuento.toFixed(2)}</span></div>
                )}
                <div className="flex justify-between w-full font-bold text-sm mt-1 border-t border-dashed border-black pt-1"><span>TOTAL:</span> <span>RD$ {total.toFixed(2)}</span></div>
            </div>

            <div className="border-b border-dashed border-black mb-2"></div>

            {/* Info de Pago */}
            <div className="text-xs mb-4">
                <div className="flex justify-between"><span>Pago ({metodoPago}):</span> <span>RD$ {parseFloat(montoRecibido || '0').toFixed(2)}</span></div>
                {metodoPago === 'efectivo' && (
                    <div className="flex justify-between font-bold mt-1"><span>DEVUELTA:</span> <span>RD$ {devuelta.toFixed(2)}</span></div>
                )}
            </div>

            {/* Pie de página */}
            <div className="text-center mt-6 text-xs">
                <p>{mensajePie || '¡Gracias por su compra!'}</p>
                <p className="mt-1 text-[10px] text-gray-500">VentaRD POS</p>
            </div>
        </>
    );

    return (
        <div
            className={`hidden print:block font-mono text-sm text-black ${claseTicket}`}
            ref={ref}
            style={{ width: impresion.anchoPapel, padding: es58 ? '4px' : '10px' }}
        >
            {Array.from({ length: impresion.copias }).map((_, i) => (
                <Fragment key={i}>
                    {i > 0 && <div style={{ pageBreakBefore: 'always' }} />}
                    <Contenido />
                </Fragment>
            ))}
        </div>
    );
});

TicketVenta.displayName = 'TicketVenta';
