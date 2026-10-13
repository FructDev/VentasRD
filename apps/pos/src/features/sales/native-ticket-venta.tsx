// Markup from VentaRD's TicketVenta; immutable native snapshot as its only source.
import type {PosTicket} from '../../platform/pos-adapter';
const fmt=(cents:string)=>{const n=BigInt(cents);return `${n<0n?'-':''}${(n<0n?-n:n)/100n}.${((n<0n?-n:n)%100n).toString().padStart(2,'0')}`;};
function quantity(n:bigint,d:bigint){let remaining=d,twos=0,fives=0;while(remaining%2n===0n){remaining/=2n;twos++;}while(remaining%5n===0n){remaining/=5n;fives++;}if(remaining!==1n)return`${n}/${d}`;const places=Math.max(twos,fives);if(!places)return n.toString();const power=10n**BigInt(places),scaled=n*power/d;const tail=(scaled%power).toString().padStart(places,'0').replace(/0+$/,'');return tail?`${scaled/power}.${tail}`:(scaled/power).toString();}
export function NativeTicketVenta({ticket}:{ticket:PosTicket}){
 const business=ticket.business,nombreNegocio=business?.name??'Datos del negocio no guardados',rnc=business?.rnc,direccion=business?.address,telefono=business?.phone,mensajePie=business?.footer;
 const logoUrl=business?.logo?.startsWith("data:image/png;base64,")?business.logo:undefined,impresion={mostrarLogo:ticket.printLayout?.showLogo!==false},es58=ticket.printLayout?.paperWidth==="58mm",vendedor=ticket.actorName??undefined;
 const fechaActual=new Date(Number(ticket.originAtUtcMs)).toLocaleString('es-DO'),ticketNum=ticket.ticket,ncf=ticket.ncf,clienteNombre=ticket.customerName;
 const {subtotalCents:subtotal,itbisCents:itbis,discountCents:descuento,totalCents:total}=ticket.sale.totals;
 const metodoPago=ticket.sale.payment.method.toLowerCase(),devuelta=ticket.sale.payment.changeCents;
 const montoRecibido=ticket.sale.payment.tenderCents??ticket.sale.payment.paidCents;
 const items=ticket.sale.lines.map((l,i)=>{const num=BigInt(l.quantity.numerator),den=BigInt(l.quantity.denominator),raw=BigInt(l.unitPriceCents)*num;const rounded=(raw*2n+den)/(2n*den);return{id:String(i),nombre:l.name,cantidad:quantity(num,den),multiple:num>den,precio_venta:fmt(l.unitPriceCents),importe:fmt(rounded.toString()),serial_numero:l.serial,ubicacion:null};});
    return (
        <>
            {/* Cabecera del Negocio */}
            <div className="text-center mb-4">
                {logoUrl && impresion.mostrarLogo && (
                    <img
                        src={logoUrl}
                        alt={nombreNegocio}
                        className="mx-auto mb-2"
                        style={{ maxWidth: es58 ? '32mm' : '45mm', maxHeight: es58 ? '16mm' : '22mm', objectFit: 'contain' }}
                    />
                )}
                <h1 className={`${es58 ? 'text-base' : 'text-xl'} font-bold uppercase`}>{nombreNegocio}</h1>
                {rnc && <p className="text-xs">RNC: {rnc}</p>}
                {direccion && <p className="text-xs">{direccion}</p>}
                {telefono && <p className="text-xs">Tel: {telefono}</p>}
                <p className="text-xs mt-2">Fecha: {fechaActual}</p>
                <p className="text-xs font-bold mt-1">Ticket #: {ticketNum}</p>
                {vendedor && <p className="text-xs">Le atendió: {vendedor}</p>}
                {clienteNombre && <p className="text-sm font-bold mt-1">Cliente: {clienteNombre}</p>}
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
                                {item.ubicacion && <div className="text-[10px] font-bold">Ubic: {item.ubicacion}</div>}
                                {item.multiple && <div className="text-[10px] text-gray-500">@ {item.precio_venta}</div>}
                            </td>
                            <td className="py-1 text-right align-top">{item.importe}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <div className="border-b border-dashed border-black mb-2"></div>

            {/* Totales */}
            <div className="flex flex-col items-end text-xs mb-4">
                <div className="flex justify-between w-full"><span>Subtotal:</span> <span>RD$ {fmt(subtotal)}</span></div>
                <div className="flex justify-between w-full"><span>ITBIS:</span> <span>RD$ {fmt(itbis)}</span></div>
                {BigInt(descuento) > 0n && (
                    <div className="flex justify-between w-full"><span>Descuento:</span> <span>- RD$ {fmt(descuento)}</span></div>
                )}
                <div className="flex justify-between w-full font-bold text-sm mt-1 border-t border-dashed border-black pt-1"><span>TOTAL:</span> <span>RD$ {fmt(total)}</span></div>
            </div>

            <div className="border-b border-dashed border-black mb-2"></div>

            {/* Info de Pago */}
            <div className="text-xs mb-4">
                <div className="flex justify-between"><span>Pago ({metodoPago}):</span> <span>RD$ {fmt(montoRecibido)}</span></div>
                {(metodoPago === 'efectivo' || metodoPago === 'mixto') && (
                    <div className="flex justify-between font-bold mt-1"><span>DEVUELTA:</span> <span>RD$ {fmt(devuelta)}</span></div>
                )}
            </div>

            {/* Pie de página */}
            <div className="text-center mt-6 text-xs">
                <p>{mensajePie || '¡Gracias por su compra!'}</p>
                <p className="mt-1 text-[10px] text-gray-500">VentaRD POS</p>
            </div>
        </>
    );

}
