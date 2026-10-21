import {SaleReceipt} from '@ventard/ui/sale-receipt';
// src/components/TicketVenta.tsx
import { forwardRef, Fragment } from 'react';
import type { ComprobanteItem } from '@/lib/domain/ventas/checkoutLocal';
import { useConfigStore } from '@/store/useConfigStore';
import { formatTicket } from '@/lib/utils';

interface TicketProps {
    items: ComprobanteItem[];
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
    clienteNombre?: string; // Cliente de la venta (clave para pedidos por delivery)
    fechaVenta?: number; // Reimpresión: fecha del hecho persistido, no la del reloj actual.
}

export const TicketVenta = forwardRef<HTMLDivElement, TicketProps>(({
    items, subtotal, itbis, descuento = 0, total, metodoPago, montoRecibido, devuelta,
    nombreNegocio = 'Mi Negocio', rnc, direccion = 'Ciudad, RD', telefono = '809-000-0000',
    numeroTicket, mensajePie, ncf, logoUrl, vendedor, cajaCodigo, clienteNombre, fechaVenta
}, ref) => {
    const { impresion } = useConfigStore();

    const fechaActual = (fechaVenta === undefined ? new Date() : new Date(fechaVenta)).toLocaleString('es-DO');
    const ticketNum = formatTicket(numeroTicket, cajaCodigo);

    const es58 = impresion.anchoPapel === '58mm';
    const claseTicket = [
        impresion.tamanoLetra === 'grande' ? 'ticket-grande' : '',
        impresion.densidad === 'compacta' ? 'ticket-compacto' : '',
    ].join(' ');

    const Contenido = () => <SaleReceipt name={nombreNegocio} rnc={rnc} address={direccion} phone={telefono} logo={logoUrl} showLogo={impresion.mostrarLogo} narrow={es58} date={fechaActual} ticket={ticketNum} actor={vendedor} customer={clienteNombre} ncf={ncf} footer={mensajePie || '¡Gracias por su compra!'} subtotal={'RD$ '+subtotal.toFixed(2)} tax={'RD$ '+itbis.toFixed(2)} discount={descuento>0?'- RD$ '+descuento.toFixed(2):null} total={'RD$ '+total.toFixed(2)} method={metodoPago} received={'RD$ '+parseFloat(montoRecibido || '0').toFixed(2)} change={metodoPago==='efectivo'?'RD$ '+devuelta.toFixed(2):null} items={items.map(i=>({id:i.id,name:i.nombre,quantity:String(i.cantidad),unitPrice:i.cantidad>1?i.precio_venta.toFixed(2):null,amount:(i.precio_venta*i.cantidad).toFixed(2),serial:i.serial_numero,location:i.ubicacion}))}/>;

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
