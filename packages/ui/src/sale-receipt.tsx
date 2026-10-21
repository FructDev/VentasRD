/** Original VentaRD print layout. All amounts/identities arrive already formatted;
 * this component never recalculates a sale or reads a store. */
export interface SaleReceiptProps {
  name:string; rnc?:string|null; address?:string|null; phone?:string|null;
  logo?:string|null; showLogo:boolean; narrow:boolean; date:string; ticket:string;
  actor?:string|null; customer?:string|null; ncf?:string|null; footer:string;
  subtotal:string; tax:string; discount?:string|null; total:string;
  method:string; received:string; change?:string|null;
  items:{id:string;name:string;quantity:string;unitPrice?:string|null;amount:string;serial?:string|null;location?:string|null}[];
}
export function SaleReceipt(p:SaleReceiptProps){return <>
  <div className="text-center mb-4">
    {p.logo&&p.showLogo&&<img src={p.logo} alt={p.name} className="mx-auto mb-2" style={{maxWidth:p.narrow?'32mm':'45mm',maxHeight:p.narrow?'16mm':'22mm',objectFit:'contain'}}/>}
    <h1 className={`${p.narrow?'text-base':'text-xl'} font-bold uppercase`}>{p.name}</h1>
    {p.rnc&&<p className="text-xs">RNC: {p.rnc}</p>}
    {p.address&&<p className="text-xs">{p.address}</p>}{p.phone&&<p className="text-xs">Tel: {p.phone}</p>}
    <p className="text-xs mt-2">Fecha: {p.date}</p><p className="text-xs font-bold mt-1">Ticket #: {p.ticket}</p>
    {p.actor&&<p className="text-xs">Le atendió: {p.actor}</p>}{p.customer&&<p className="text-sm font-bold mt-1">Cliente: {p.customer}</p>}
  </div>
  {p.ncf&&<><div className="border-b border-dashed border-black mb-2"/><div className="text-center mb-2"><p className="text-[10px] font-bold uppercase tracking-widest">Comprobante Fiscal</p><p className="text-base font-bold tracking-wider">{p.ncf}</p><p className="text-[10px]">{p.ncf.startsWith('B01')?'Crédito Fiscal':'Consumidor Final'}</p></div></>}
  <div className="border-b border-dashed border-black mb-2"/>
  <table className="w-full text-left text-xs mb-2"><thead><tr className="border-b border-dashed border-black"><th className="py-1">CANT</th><th className="py-1">DESCRIPCIÓN</th><th className="py-1 text-right">IMPORTE</th></tr></thead><tbody>{p.items.map(i=><tr key={i.id}><td className="py-1 align-top">{i.quantity}</td><td className="py-1 pr-2 align-top break-words">{i.name}{i.serial&&<div className="text-[10px] text-gray-600">S/N: {i.serial}</div>}{i.location&&<div className="text-[10px] font-bold">Ubic: {i.location}</div>}{i.unitPrice&&<div className="text-[10px] text-gray-500">@ {i.unitPrice}</div>}</td><td className="py-1 text-right align-top">{i.amount}</td></tr>)}</tbody></table>
  <div className="border-b border-dashed border-black mb-2"/>
  <div className="flex flex-col items-end text-xs mb-4"><div className="flex justify-between w-full"><span>Subtotal:</span><span>{p.subtotal}</span></div><div className="flex justify-between w-full"><span>ITBIS:</span><span>{p.tax}</span></div>{p.discount&&<div className="flex justify-between w-full"><span>Descuento:</span><span>{p.discount}</span></div>}<div className="flex justify-between w-full font-bold text-sm mt-1 border-t border-dashed border-black pt-1"><span>TOTAL:</span><span>{p.total}</span></div></div>
  <div className="border-b border-dashed border-black mb-2"/>
  <div className="text-xs mb-4"><div className="flex justify-between"><span>Pago ({p.method}):</span><span>{p.received}</span></div>{p.change!=null&&<div className="flex justify-between font-bold mt-1"><span>DEVUELTA:</span><span>{p.change}</span></div>}</div>
  <div className="text-center mt-6 text-xs"><p>{p.footer}</p><p className="mt-1 text-[10px] text-gray-500">VentaRD POS</p></div>
</>}
