import {BusinessLogo} from './business-logo';
// Existing VentaRD guarantee certificate, frozen native issuance.
import type {WarrantyTicket} from '../../platform/management';
export function NativeTicketGarantia({ticket}:{ticket:WarrantyTicket}){
 const a=ticket.document.warranty,b=ticket.document.business;
 const s={numero_serial:a.serial,cliente_nombre:a.customerName,fecha_venta:a.soldAtMs?Number(a.soldAtMs):null,precio_venta:a.priceCents,garantia_dias:a.days,garantia_hasta:a.untilMs?Number(a.untilMs):null};
 const productoNombre=a.name,nombreNegocio=b?.name??'Datos del negocio no guardados',rnc=b?.rnc,direccion=b?.address,telefono=b?.phone;
 const layout=ticket.printLayout;const impresion={anchoPapel:layout?.paperWidth??'80mm'},es58=impresion.anchoPapel==='58mm',claseTicket=[layout?.fontSize==='grande'?'ticket-grande':'',layout?.density==='compacta'?'ticket-compacto':''].join(' ');
 const fmtDOP=(v:string)=>{const n=BigInt(v);return `${(n/100n).toLocaleString('es-DO')}.${String(n%100n).padStart(2,'0')}`;};
 const fmtFecha=(v?:number|null)=>v?new Date(v).toLocaleDateString('es-DO'):'—';
    return (
        <div className={`font-mono text-sm text-black ${claseTicket}`} style={{ width: impresion.anchoPapel, padding: es58 ? '4px' : '10px' }}>
            {/* Cabecera */}
            <div className="text-center mb-3">
                <BusinessLogo business={b} layout={ticket.printLayout}/><h1 className="text-lg font-bold uppercase">{nombreNegocio}</h1>
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
                    {s.precio_venta !== null && BigInt(s.precio_venta)>0n && (
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
}