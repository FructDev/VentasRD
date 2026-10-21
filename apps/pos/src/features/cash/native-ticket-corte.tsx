// Markup adapted directly from src/components/TicketCorte.tsx; frozen cut only.
import type {CutTicket} from '../../platform/management';
const fmtDOP=(c:string)=>{const n=BigInt(c);return `${n<0n?'-':''}${(n<0n?-n:n)/100n}.${String((n<0n?-n:n)%100n).padStart(2,'0')}`;};
function quantity(n:string,d:string){return d==='1'?n:`${n}/${d}`;}
export function NativeTicketCorte({ticket}:{ticket:CutTicket}){
 const drawer=ticket.document.drawer,summary=drawer.summary,business=ticket.document.business;
 const nombreNegocio=business?.name??'Datos del negocio no guardados',rnc=business?.rnc,direccion=business?.address,telefono=business?.phone;
 const fecha=new Date(Number(ticket.originAtUtcMs)).toLocaleString('es-DO'),esZ=ticket.kind==='TURN_CLOSE',es58=ticket.printLayout?.paperWidth==='58mm',claseTicket=[ticket.printLayout?.fontSize==='grande'?'ticket-grande':'',ticket.printLayout?.density==='compacta'?'ticket-compacto':''].join(' '),impresion={anchoPapel:ticket.printLayout?.paperWidth??'80mm'};
 const corte={efectivo:summary?.cashSalesCents??'0',tarjeta:summary?.cardCents??'0',transferencia:summary?.transferCents??'0',fiado:summary?.creditCents??'0',mixto:summary?.mixedCents??'0',total_ventas:summary?.totalCents??'0',ingreso_reparaciones:summary?.repairIncomeCents??'0',ingreso_apartados:summary?.layawayIncomeCents??'0',ingreso_abonos_fiado:String(BigInt(summary?.cashCreditPaymentsCents??'0')+BigInt(summary?.cardCreditPaymentsCents??'0')+BigInt(summary?.transferCreditPaymentsCents??'0')),cantidad_transacciones:summary?.salesCount??'',monto_apertura:drawer.openingCents,monto_esperado:drawer.expectedCents,monto_contado:ticket.document.countedCents,diferencia:ticket.document.differenceCents};
 const productos=(drawer.products??[]).map(p=>({nombre:p.name,cantidad:quantity(p.quantity.numerator,p.quantity.denominator),subtotal:p.subtotalCents}));
 const metodos=[{label:'Efectivo',valor:corte.efectivo},{label:'Tarjeta',valor:corte.tarjeta},{label:'Transferencia',valor:corte.transferencia},{label:'Fiado',valor:corte.fiado},{label:'Mixto',valor:corte.mixto}].filter(l=>BigInt(l.valor)>0n);
 return(
        <div className={`font-mono text-sm text-black ${claseTicket}`} style={{ width: impresion.anchoPapel, padding: es58 ? '4px' : '10px' }}>

            {/* Cabecera */}
            <div className="text-center mb-3">
                <h1 className="text-lg font-bold uppercase">{nombreNegocio}</h1>
                {rnc && <p className="text-xs">RNC: {rnc}</p>}
                {direccion && <p className="text-xs">{direccion}</p>}
                {telefono && <p className="text-xs">Tel: {telefono}</p>}
                <p className="text-xs mt-1">{fecha}</p>
            </div>

            <div className="border-b border-dashed border-black mb-2" />

            {/* Tipo */}
            <div className="text-center mb-3">
                <p className="text-base font-bold uppercase tracking-widest">
                    {esZ ? 'CIERRE DE CAJA' : 'CORTE PARCIAL'}
                </p>
            </div>

            <div className="border-b border-dashed border-black mb-2" />

            {/* Productos vendidos */}
            <p className="text-xs font-bold uppercase tracking-wider mb-1">Productos vendidos</p>
            {productos.length === 0 ? (
                <p className="text-xs text-gray-500 mb-2 text-center">{drawer.products===undefined?'Detalle de productos no guardado':'Sin ventas nativas registradas en este turno'}</p>
            ) : (
                <table className="w-full text-xs mb-2">
                    <thead>
                        <tr className="border-b border-dashed border-black">
                            <th className="py-0.5 text-left font-bold">Producto</th>
                            <th className="py-0.5 text-center font-bold">Cant</th>
                            <th className="py-0.5 text-right font-bold">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {productos.map((p, i) => (
                            <tr key={i}>
                                <td className="py-0.5 pr-1 break-words">{p.nombre}</td>
                                <td className="py-0.5 text-center">{p.cantidad}</td>
                                <td className="py-0.5 text-right">{fmtDOP(p.subtotal)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            <div className="border-b border-dashed border-black mb-2" />

            {/* Desglose por método */}
            <p className="text-xs font-bold uppercase tracking-wider mb-1">Por método de pago</p>
            <table className="w-full text-xs mb-2">
                <tbody>
                    {metodos.map(m => (
                        <tr key={m.label}>
                            <td className="py-0.5">{m.label}</td>
                            <td className="py-0.5 text-right font-bold">RD$ {fmtDOP(m.valor)}</td>
                        </tr>
                    ))}
                    {metodos.length === 0 && (
                        <tr><td colSpan={2} className="text-center py-1 text-gray-500">—</td></tr>
                    )}
                </tbody>
            </table>

            <div className="border-b border-dashed border-black mb-2" />

            {/* Subtotales por fuente de ingreso */}
            {BigInt(summary?.refundCents??'0')>0n&&<div className="flex justify-between text-xs mb-0.5"><span>Devoluciones (incluidas en ventas netas)</span><span>RD$ {fmtDOP(summary?.refundCents??'0')}</span></div>}
            <div className="flex justify-between text-xs mb-0.5">
                <span>Ventas</span>
                <span>RD$ {fmtDOP(corte.total_ventas)}</span>
            </div>
            {BigInt(corte.ingreso_reparaciones) > 0n && (
                <div className="flex justify-between text-xs mb-0.5">
                    <span>Reparaciones</span>
                    <span>RD$ {fmtDOP(corte.ingreso_reparaciones)}</span>
                </div>
            )}
            {BigInt(corte.ingreso_apartados) > 0n && (
                <div className="flex justify-between text-xs mb-0.5">
                    <span>Apartados</span>
                    <span>RD$ {fmtDOP(corte.ingreso_apartados)}</span>
                </div>
            )}
            {BigInt(corte.ingreso_abonos_fiado) > 0n && (
                <div className="flex justify-between text-xs mb-0.5">
                    <span>Abonos fiado (no son ventas nuevas)</span>
                    <span>RD$ {fmtDOP(corte.ingreso_abonos_fiado)}</span>
                </div>
            )}
            <div className="flex justify-between font-bold text-sm mb-0.5 border-t border-dashed border-black pt-1">
                <span>TOTAL INGRESOS</span>
                <span>RD$ {fmtDOP(ticket.totalIncomeCents)}</span>
            </div>
            <div className="flex justify-between text-xs text-gray-600 mb-3">
                <span>Transacciones (ventas)</span>
                <span>{corte.cantidad_transacciones}</span>
            </div>

            {/* Cuadre — solo en cierre */}
            {esZ && corte.monto_apertura != null && (
                <>
                    <div className="border-b border-dashed border-black mb-2" />
                    <p className="text-xs font-bold uppercase tracking-wider mb-1">Cuadre de caja</p>
                    <table className="w-full text-xs mb-2">
                        <tbody>
                            <tr>
                                <td className="py-0.5">Apertura</td>
                                <td className="py-0.5 text-right">RD$ {fmtDOP(corte.monto_apertura!)}</td>
                            </tr>
                            <tr>
                                <td className="py-0.5">Efectivo esperado</td>
                                <td className="py-0.5 text-right">RD$ {fmtDOP(corte.monto_esperado)}</td>
                            </tr>
                            <tr>
                                <td className="py-0.5">Efectivo contado</td>
                                <td className="py-0.5 text-right font-bold">RD$ {fmtDOP(corte.monto_contado)}</td>
                            </tr>
                        </tbody>
                    </table>
                    <div className="text-center font-bold text-sm py-1 border border-dashed border-black">
                        {BigInt(corte.diferencia) === 0n
                            ? '✓ CUADRE PERFECTO'
                            : BigInt(corte.diferencia) > 0n
                                ? `↑ SOBRANTE: RD$ ${fmtDOP(String(BigInt(corte.diferencia)<0n?-BigInt(corte.diferencia):BigInt(corte.diferencia)))}`
                                : `↓ FALTANTE: RD$ ${fmtDOP(String(BigInt(corte.diferencia)<0n?-BigInt(corte.diferencia):BigInt(corte.diferencia)))}`}
                    </div>
                </>
            )}

            <div className="text-center mt-4 text-xs text-gray-500">
                <p>VentaRD POS</p>{drawer.productsCoverage==='LOCAL_NATIVE_SALES_BEFORE_RETURNS'&&<p>Productos: ventas originales antes de devoluciones. Importes netos en el resumen.</p>}<p className="mt-1">Copia local · registros nativos del ámbito</p>{drawer.productsCoverage==='FIRST_500_LOCAL_NATIVE_PRODUCTS'&&<p>Detalle limitado a 500 productos</p>}{drawer.productsCoverage==='MISSING_SNAPSHOT'&&<p>Detalle de productos incompleto</p>}
            </div>
        </div>
 );
}
