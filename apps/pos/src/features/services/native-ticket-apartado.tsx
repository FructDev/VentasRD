import {BusinessLogo} from './business-logo';
// Markup from the definitive VentaRD TicketApartado; data is the frozen native operation.
import type {LayawayTicket} from '../../platform/management';
export function NativeTicketApartado({ticket}:{ticket:LayawayTicket}){
 const p=ticket.document.layaway,b=ticket.document.business;
 const modo=p.state==='completado'?'entrega':p.payments.at(-1)?.operationId===ticket.operationId&&p.revision!=='1'?'abono':'contrato';
 const a={folio:p.folio,cliente_nombre:p.definition.customerName,cliente_telefono:p.definition.phone,items:p.definition.items.map(i=>({nombre:i.name,cantidad:i.quantity,precio_unitario:i.priceCents,serial_numero:i.serial})),total:p.totalCents,abonado:p.paidCents,abonos:p.payments.map(p=>({monto:p.amountCents,metodo:p.method.toLowerCase(),fecha:Number(p.dateMs)})),fecha_completado:p.completedAtMs?Number(p.completedAtMs):null};
 const nombreNegocio=b?.name??'Datos del negocio no guardados',rnc=b?.rnc,direccion=b?.address,telefono=b?.phone;
 const TITULO={contrato:'Comprobante de apartado',abono:'Recibo de abono',entrega:'Entrega de apartado'};
 const layout=ticket.printLayout;const impresion={anchoPapel:layout?.paperWidth??'80mm'},es58=impresion.anchoPapel==='58mm',claseTicket=[layout?.fontSize==='grande'?'ticket-grande':'',layout?.density==='compacta'?'ticket-compacto':''].join(' ');
 const fmtDOP=(v:string)=>{const n=BigInt(v);return `${(n/100n).toLocaleString('es-DO')}.${String(n%100n).padStart(2,'0')}`;};
 const fmtFecha=(v?:number|null)=>v?new Date(v).toLocaleString('es-DO'):'—';
 const saldo=String(BigInt(p.totalCents)-BigInt(p.paidCents));
    return (
        <div className={`font-mono text-sm text-black ${claseTicket}`} style={{ width: impresion.anchoPapel, padding: es58 ? '4px' : '10px' }}>
            <div className="text-center mb-3">
                <BusinessLogo business={b} layout={ticket.printLayout}/><h1 className="text-lg font-bold uppercase">{nombreNegocio}</h1>
                {rnc && <p className="text-xs">RNC: {rnc}</p>}
                {direccion && <p className="text-xs">{direccion}</p>}
                {telefono && <p className="text-xs">Tel: {telefono}</p>}
            </div>

            <div className="border-b border-dashed border-black mb-2" />
            <div className="text-center mb-2">
                <p className="text-base font-bold uppercase tracking-widest">{TITULO[modo]}</p>
                <p className="text-sm font-bold">{a.folio}</p>
                <p className="text-xs">{fmtFecha(modo === 'entrega' ? a.fecha_completado : Number(ticket.originAtUtcMs))}</p>
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
                            <td className="py-0.5 text-right align-top">RD$ {fmtDOP(String(BigInt(it.precio_unitario)*BigInt(it.cantidad)))}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <div className="border-b border-dashed border-black mb-2" />

            {/* Totales */}
            <div className="flex justify-between font-bold text-sm mb-0.5"><span>TOTAL</span><span>RD$ {fmtDOP(a.total)}</span></div>
            <div className="flex justify-between text-xs mb-0.5"><span>Abonado</span><span>RD$ {fmtDOP(a.abonado)}</span></div>
            <div className="flex justify-between font-bold text-sm mb-2">
                <span>{BigInt(saldo) <= 0n ? 'PAGADO' : 'SALDO'}</span>
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

 );}
