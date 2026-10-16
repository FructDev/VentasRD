import {describe,it,expect} from 'vitest';import {mkdir,writeFile} from 'node:fs/promises';
import type {CheckoutEntrada} from '@/lib/domain/ventas/checkoutLocal';
import {buildSharedSale,type SharedSaleFacts} from './shared-sale';
const id=(n:number)=>`96200000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tenant='96000000-0000-4000-8000-000000000001';
function fixture(){
 const input:CheckoutEntrada={cartId:id(8180),scope:{negocioId:tenant,sucursalId:id(4)},comando:{version:1,operacionId:id(8104),negocioId:tenant,sucursalId:id(4),cajaCodigo:'WEB',fecha:1791712800000,total:118,metodoPago:'tarjeta',garantiaDias:0,items:[{productoId:id(20),nombre:'Producto sintético',cantidad:1,precioUnitario:100}]},comprobante:{items:[],subtotal:100,itbis:18,descuento:0,total:118,montoRecibido:0,negocio:{nombre:'QA SINTETICO'}}};
 const facts:SharedSaleFacts={context:{tenantId:tenant,actorId:id(1),installationId:id(8100),deviceId:id(8101),writerEpoch:'1',scopeType:'BRANCH',branchId:id(4),permissionGrantId:id(8102)},products:[{id:id(20),name:'Producto sintético',revision:'1',deleted:false,priceTiers:{retailCents:'10000',tier2Cents:'9000',tier3Cents:'8000'},metadata:{costCents:'6000',taxRate:{numerator:'9',denominator:'50'},serialRequired:false,recipe:[]}}],proofs:[{productId:id(20),remoteBaseQty:'99',remoteSequence:'1',pending:[],effectiveQty:'99'}],serials:[],freeTax:{numerator:'9',denominator:'50'},ticketSequence:'8104'};
 input.comando.cajaCodigo='N'+facts.context.installationId.replaceAll('-','');
 return{input,facts};
}
describe('browser checkout uses the existing native sale protocol',()=>{
 it('freezes exact cents, tax, native ticket namespace and evidence for PostgreSQL roundtrip',async()=>{
  const f=fixture(),w=buildSharedSale(f.input,f.facts),v=JSON.parse(w.intent),s=JSON.parse(w.snapshot!);
  expect(v.payload.sale.totals).toEqual({subtotalCents:'10000',itbisCents:'1800',discountCents:'0',totalCents:'11800'});expect(s.ticket).toBe('N'+id(8100).replaceAll('-','')+'-008104');expect(v.payload.sale.inventory[0].delta).toBe('-1');
  await mkdir('scratch',{recursive:true});await writeFile('scratch/shared-web-sale-wire.json',JSON.stringify({context:f.facts.context,wire:w}));
 });
 it('all five payment methods retain exact cash/change/credit without allocating NCF',()=>{
  for(const method of ['efectivo','tarjeta','transferencia','fiado','mixto'] as const){const f=fixture();f.input.comando.metodoPago=method;
   if(method==='efectivo'||method==='mixto'){f.input.comando.cajaId=id(90);f.input.comprobante.montoRecibido=200}
   if(method==='mixto'){f.input.comando.montoEfectivo=68;f.input.comando.montoTransferencia=50}
   if(method==='fiado'){f.facts.customer={id:id(30),name:'Cliente sintético',metadataRevision:'1',priceTier:'1'};f.input.comando.clienteId=id(30)}
   const v=JSON.parse(buildSharedSale(f.input,f.facts).intent),p=v.payload.sale.payment;
   expect(p.method).toBe({efectivo:'EFECTIVO',tarjeta:'TARJETA',transferencia:'TRANSFERENCIA',fiado:'FIADO',mixto:'MIXTO'}[method]);expect(v.payload.sale.fiscal).toBeNull();
   if(method==='efectivo')expect(p.changeCents).toBe('8200');if(method==='mixto'){expect(p.cashNetCents).toBe('6800');expect(p.changeCents).toBe('13200')}if(method==='fiado'){expect(p.creditChargeCents).toBe('11800');expect(p.paidCents).toBe('0')}
  }
 });
 it('refuses stale price/total, missing evidence and unsupported fractional stock rather than adjusting money',()=>{
  const changes:((f:ReturnType<typeof fixture>)=>void)[]=[f=>{f.input.comando.total=119},f=>{f.input.comando.items[0].precioUnitario=101},f=>{f.facts.proofs=[]},f=>{f.input.comando.items[0].cantidad=0.5}];
  for(const change of changes){const f=fixture();change(f);expect(()=>buildSharedSale(f.input,f.facts)).toThrow()}
 });
});
