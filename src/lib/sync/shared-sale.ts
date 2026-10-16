import type {CheckoutEntrada} from '@/lib/domain/ventas/checkoutLocal';
import {moneyCents} from '@/lib/domain/local/command';
import {canonicalNative,sharedContextKey,type SharedContext,type SharedWire} from './shared-journal';
import {sha256Hex} from './inventory/canonical-payload';
export interface NativeRatio{numerator:string;denominator:string}
export interface NativeProduct {id:string;name:string;revision:string;deleted:boolean;priceTiers:{retailCents:string;tier2Cents:string|null;tier3Cents:string|null};metadata:{costCents:string|null;taxRate:NativeRatio;serialRequired:boolean;recipe:{productId:string;perUnit:NativeRatio;revision:string}[];productType?:string}}
export interface NativeStockProof {productId:string;remoteBaseQty:string;remoteSequence:string;pending:{operationId:string;effectId:string;delta:string}[];effectiveQty:string}
export interface SharedSaleFacts {context:SharedContext;products:NativeProduct[];proofs:NativeStockProof[];serials:{productId:string;text:string;revision:string;state:string}[];customer?:{id:string;name:string;metadataRevision:string;priceTier:string};freeTax:NativeRatio;business?:unknown;ticketSequence:string}
const ZERO=BigInt(0),ONE=BigInt(1);
function guard():never{throw Error('SHARED_SALE_FACTS_CHANGED')}
function integer(s:string){if(!/^(0|[1-9][0-9]{0,15})$/.test(s)||BigInt(s)>BigInt(Number.MAX_SAFE_INTEGER))guard();return BigInt(s)}
function cents(n:number){return BigInt(moneyCents(n))}
function rational(r:NativeRatio){const n=integer(r.numerator),d=integer(r.denominator);if(d===ZERO)guard();return{n,d}}
function gcd(a:bigint,b:bigint):bigint{while(b){const r=a%b;a=b;b=r}return a}
function addRatio(a:{n:bigint;d:bigint},b:{n:bigint;d:bigint}){const n=a.n*b.d+b.n*a.d,d=a.d*b.d,g=gcd(n,d);return{n:n/g,d:d/g}}
function round(n:bigint,d:bigint){return (BigInt(2)*n+d)/(BigInt(2)*d)}
export {sharedEffectId} from './shared-effects';
/** Exact protocol constructor. Inputs are frozen checkout facts; no HTTP or DB.
 * A mismatching price, total, recipe, stock proof or serial never gets adjusted
 * to whatever the server happens to contain when connectivity returns. */
export function buildSharedSale(input:CheckoutEntrada,f:SharedSaleFacts):SharedWire{
 const c=f.context,e=input.comando;sharedContextKey(c);
 if(e.negocioId!==c.tenantId||(e.sucursalId??null)!==c.branchId||e.cajaCodigo!=='N'+c.installationId.replaceAll('-','')||e.ncf||input.solicitudFiscal||!e.items.length||e.items.length>100||integer(f.ticketSequence)===ZERO)guard();
 if(f.business){const business=f.business as Record<string,unknown>,printed=input.comprobante.negocio;for(const [old,current]of [[printed.nombre,business.name],[printed.rnc,business.rnc],[printed.direccion,business.address],[printed.telefono,business.phone],[printed.mensajePie,business.footer]])if(String(old??'')!==String(current??''))guard()}
 if(f.customer&&e.clienteNombre!==undefined&&e.clienteNombre!==f.customer.name)guard();
 const products=new Map(f.products.map(p=>[p.id,p])),proofs=new Map(f.proofs.map(p=>[p.productId,p])),consumed=new Map<string,bigint>(),serials:Record<string,unknown>[]=[],lines:Record<string,unknown>[]=[];
 let subtotal=ZERO,tax={n:ZERO,d:ONE};
 for(const item of e.items){
  if(!Number.isSafeInteger(item.cantidad)||item.cantidad<=0)guard();const qty=BigInt(item.cantidad),p=item.sinStock?undefined:products.get(item.productoId);
  if(!item.sinStock&&(!p||p.deleted||p.metadata.productType==='insumo'))guard();
  const rate=p?.metadata.taxRate??f.freeTax,price=cents(item.precioUnitario),r=rational(rate),recipe=p?.metadata.recipe??[];
  if(p){const tier=f.customer?.priceTier??'1',expected=tier==='2'?p.priceTiers.tier2Cents??p.priceTiers.retailCents:tier==='3'?p.priceTiers.tier3Cents??p.priceTiers.retailCents:p.priceTiers.retailCents;if(price!==integer(expected)||item.nombre!==p.name)guard()}
  const line:Record<string,unknown>={productId:p?.id??null,productRevision:p?.revision??null,name:p?.name??item.nombre,unitPriceCents:price.toString(),quantity:{numerator:qty.toString(),denominator:'1'},taxRate:rate,costCents:p?.metadata.costCents??null,serial:item.serial?.numero??null,recipe};
  if(p&&f.customer)line.pricePolicy={source:'CUSTOMER',customerId:f.customer.id,tier:f.customer.priceTier};
  if(p?.metadata.serialRequired){const serial=f.serials.find(s=>s.productId===p.id&&s.text===item.serial?.numero);if(!serial||serial.state!=='AVAILABLE'||qty!==ONE||serials.some(s=>s.text===serial.text))guard();serials.push({text:serial.text,productId:p.id,expectedRevision:serial.revision,warrantyDays:String(e.garantiaDias)})}else if(item.serial)guard();
  if(p){const targets=recipe.length?recipe.map(part=>{const q=rational(part.perUnit),n=qty*q.n;if(n%q.d!==ZERO)guard();return{id:part.productId,qty:n/q.d}}):[{id:p.id,qty}];for(const target of targets)consumed.set(target.id,(consumed.get(target.id)??ZERO)+target.qty)}
  const lineAmount=price*qty;subtotal+=lineAmount;tax=addRatio(tax,{n:lineAmount*r.n,d:r.d});lines.push(line);
 }
 const itbis=round(tax.n,tax.d),total=cents(e.total),discount=subtotal+itbis-total;
 if(discount<ZERO||cents(input.comprobante.subtotal)!==subtotal||cents(input.comprobante.itbis)!==itbis||cents(input.comprobante.descuento)!==discount||cents(input.comprobante.total)!==total)guard();
 const method={efectivo:'EFECTIVO',tarjeta:'TARJETA',transferencia:'TRANSFERENCIA',fiado:'FIADO',mixto:'MIXTO'}[e.metodoPago];if(!method)guard();
 const cash=method==='EFECTIVO'?total:method==='MIXTO'?cents(e.montoEfectivo??-1):ZERO;
 const transfer=method==='TRANSFERENCIA'?total:method==='MIXTO'?cents(e.montoTransferencia??-1):ZERO;
 if(method==='MIXTO'&&cash+transfer!==total)guard();
 const tender=method==='EFECTIVO'||method==='MIXTO'?cents(input.comprobante.montoRecibido):ZERO;if(tender<cash||cash>ZERO&&!e.cajaId||method==='FIADO'&&(!f.customer||f.customer.id!==e.clienteId))guard();
 const inventory=[...consumed.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([pid,qty])=>{const proof=proofs.get(pid);if(!proof||integer(proof.effectiveQty)<qty)guard();return{productId:pid,delta:(-qty).toString(),expectedRevision:sha256Hex(canonicalNative({quantity:proof.effectiveQty,remoteSequence:proof.remoteSequence,pending:proof.pending}))}});
 const sale:Record<string,unknown>={calculationVersion:'ventard.sale.calculation.1',currency:'DOP',lines,discount:{type:'AMOUNT',amountCents:discount.toString()},totals:{subtotalCents:subtotal.toString(),itbisCents:itbis.toString(),discountCents:discount.toString(),totalCents:total.toString()},payment:{method,customerId:method==='FIADO'?f.customer!.id:null,paidCents:method==='FIADO'?'0':total.toString(),creditChargeCents:method==='FIADO'?total.toString():'0',cashNetCents:cash.toString(),cardCents:method==='TARJETA'?total.toString():'0',transferCents:transfer.toString(),tenderCents:tender.toString(),changeCents:(tender-cash).toString(),turnId:e.cajaId??null,bankSettlementVerified:false},inventory,serials,stockEvidence:inventory.map(x=>proofs.get(x.productId)),fiscal:null};
 const customer=f.customer?{id:f.customer.id,name:f.customer.name,revision:f.customer.metadataRevision}:e.clienteNombre?{id:null,name:e.clienteNombre,revision:null}:null;if(customer)sale.customer=customer;
 const intent={protocol:'ventard.native.v1',kind:'SALE_CONFIRM',contractVersion:1,canonicalizationVersion:'C-N1',operationId:e.operacionId,negocioId:c.tenantId,scope:{type:c.scopeType,sucursalId:c.branchId},originDeviceId:c.deviceId,installationId:c.installationId,writerEpoch:c.writerEpoch,actorId:c.actorId,permissionGrantId:c.permissionGrantId,originalTurnId:e.cajaId??null,originAtUtcMs:String(e.fecha),expectedVersions:{cart:'1'},dependencies:[],payload:{cartId:input.cartId,cartRevision:'1',quoteHash:sha256Hex(canonicalNative(sale)),sale,request:{}}};
 const ticket='N'+c.installationId.replaceAll('-','')+'-'+f.ticketSequence.padStart(6,'0');
 const snapshot={version:'ventard.ticket.snapshot.1',operationId:e.operacionId,tenantId:c.tenantId,scope:{type:c.scopeType,branchId:c.branchId},ticket,ncf:null,actorId:c.actorId,originAtUtcMs:String(e.fecha),customerName:customer?.name??null,sale,...(f.business?{business:f.business}:{})};
 const intentText=canonicalNative(intent),snapshotText=canonicalNative(snapshot);return{intent:intentText,intentHash:sha256Hex(intentText),snapshot:snapshotText,snapshotHash:sha256Hex(snapshotText)};
}
