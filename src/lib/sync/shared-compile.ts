import type {VentaRDDatabase} from '@/lib/db/dexie';
import type {CheckoutEntrada} from '@/lib/domain/ventas/checkoutLocal';
import {commandHash,moneyCents} from '@/lib/domain/local/command';
import type {SharedMutation} from './shared-capture';
import {buildSharedSale,sharedEffectId,type NativeProduct,type NativeStockProof,type SharedSaleFacts} from './shared-sale';
import {canonicalNative,freezeSharedOperation,SharedRemoteError,type SharedOutbox,type SharedWire} from './shared-journal';
import {sharedServiceTask,type SharedServicePlanner} from './shared-services';
import {sha256Hex} from './inventory/canonical-payload';
import {decimalRatio} from '@/lib/domain/local/decimal';
import {emptySharedDrawer,applySharedDrawer,drawerDocument,type SharedDrawer} from './shared-drawer';
import {sharedReturnTask} from './shared-returns';
import {warrantyFromSale,warrantyRevision} from './shared-warranty';
import {sharedDepositBasis} from './shared-deposits';
type Obj=Record<string,unknown>;
const ZERO=BigInt(0),ONE=BigInt(1);
function guard(code='SHARED_OPERATION_REVIEW_REQUIRED'):never{throw Error(code)}
const obj=(v:unknown):Obj=>{if(!v||typeof v!=='object'||Array.isArray(v))guard();return v as Obj};
const cents=(v:unknown)=>String(moneyCents(Number(v)));
const next=(v:unknown)=>(BigInt(String(v))+ONE).toString();
function deltas(v:Obj):{productId:string;delta:string}[]{const p=obj(v.payload),d=p.document?obj(p.document):{};if(p.sale)return(obj(p.sale).inventory as {productId:string;delta:string}[])??[];if(Array.isArray(d.stock))return d.stock as {productId:string;delta:string}[];if(typeof d.productId==='string'&&typeof d.delta==='string')return[{productId:d.productId,delta:d.delta}];if(v.kind==='PRODUCT_CREATE'&&d.product)return[{productId:String(obj(d.product).id),delta:'0'}];return[]}
export function sharedEnvelope(raw:SharedMutation,kind:string,op:string,at:unknown,payload:unknown,turnId:string|null=null):SharedWire{
 const c=raw.context,intent={protocol:'ventard.native.v1',kind,contractVersion:1,canonicalizationVersion:'C-N1',operationId:op,negocioId:c.tenantId,scope:{type:c.scopeType,sucursalId:c.branchId},originDeviceId:c.deviceId,installationId:c.installationId,writerEpoch:c.writerEpoch,actorId:c.actorId,permissionGrantId:c.permissionGrantId,originalTurnId:turnId,originAtUtcMs:String(at),expectedVersions:kind==='TURN_OPEN'?{drawer:'0'}:{},dependencies:[],payload};
 const text=canonicalNative(intent);return{intent:text,intentHash:sha256Hex(text),snapshot:null,snapshotHash:null};
}
const envelope=sharedEnvelope;
/** Derive only from facts captured in the ORIGINAL transaction plus earlier
 * frozen operations of this writer. Never reprice against a later server read. */
export function sharedFactsFor(raw:SharedMutation,previous:SharedOutbox[]){
 const facts=structuredClone(raw.facts),base=new Map<string,{value:Obj;sequence:string;business?:unknown}>();
 for(const [key,value] of Object.entries(facts)){if(key==='MANIFEST'||key==='ACTIVE_TURN_ID'||!value)continue;const e=obj(value);base.set(key,{value:obj(e.value),sequence:String(e.sequence),business:e.business})}
 const rows=previous.map(row=>({row,v:obj(JSON.parse(row.wire.intent))}));
 const entity=(kind:string,id:string):Obj|null=>{
  const key=kind+'/'+id,old=base.get(key);let current=old?structuredClone(old.value):null;
  for(const {row,v} of rows){if(row.receipt&&old&&BigInt(String(row.receipt.remoteSequence))<=BigInt(old.sequence))continue;
   const p=obj(v.payload),d=p.document?obj(p.document):{},field={PRODUCT:'product',CUSTOMER:'customer',REPAIR:'repair',LAYAWAY:'layaway'}[kind];
   if(kind==='RETURN_BASIS'){if(v.kind==='SALE_CONFIRM'&&v.operationId===id&&row.wire.snapshot)current={snapshot:obj(JSON.parse(row.wire.snapshot)),snapshotHash:row.wire.snapshotHash,returns:[]};if(v.kind==='SALE_RETURN'&&d.saleId===id&&current)current.returns=[...(current.returns as Obj[]),{operationId:v.operationId,document:d}].sort((a,b)=>String(a.operationId).localeCompare(String(b.operationId)))}
   if(kind==='SERIAL'&&current){if(v.kind==='SALE_CONFIRM'){const serial=(obj(p.sale).serials as Obj[]).find(s=>s.productId+'/'+s.text===id);if(serial)current={...current,state:'SOLD',saleOperationId:v.operationId,warranty:warrantyFromSale(v,serial)}}for(const s of (d.serialChanges as Obj[]??d.serials as Obj[]??[])){if(s&&typeof s==='object'&&s.productId+'/'+s.text===id)current={...current,state:s.after,saleOperationId:s.after==='SOLD'?v.operationId:null}}if(v.kind==='SALE_RETURN'&&(d.serialProof as Obj[]).some(s=>s.productId+'/'+s.text===id))current={...current,state:'AVAILABLE',saleOperationId:null};if(d.warranty&&obj(d.warranty).productId+'/'+obj(d.warranty).serial===id)current.warranty=warrantyRevision(obj(d.warranty))}
   if(field&&d[field]&&obj(d[field]).id===id){const patch=obj(d[field]);current={...current,...patch};if(kind==='CUSTOMER'){current.metadataRevision=patch.revision;current.balanceCents=current.balanceCents??'0';current.revision=old?.value.revision??'1'}}
   if(kind==='PRODUCT')for(const created of d.products as Obj[]??[]){const product=obj(obj(created.document).product);if(product.id===id)current={...current,...product}}
   if(kind==='SERVICE_REFUNDS'&&d.service&&obj(d.service).family+'/'+obj(d.service).id===id)current={revision:obj(d.refund).revision,refundedCents:d.refundedAfterCents};
   if(kind==='CUSTOMER'&&current){if(v.kind==='SALE_CONFIRM'){const pay=obj(obj(p.sale).payment);if(pay.method==='FIADO'&&pay.customerId===id){current.balanceCents=(BigInt(String(current.balanceCents))+BigInt(String(pay.creditChargeCents))).toString();current.revision=next(current.revision)}}else if(d.customerId===id&&d.balanceAfterCents!==undefined){current.balanceCents=d.balanceAfterCents;current.revision=d.balanceRevision}else if(d.credit&&obj(d.credit).customerId===id){const credit=obj(d.credit);current.balanceCents=credit.afterCents;current.revision=next(credit.expectedRevision)}}
  }return current;
 };
 const proof=(pid:string):NativeStockProof=>{
  const original=base.get('PRODUCT/'+pid),resolved=entity('PRODUCT',pid);if(!resolved)guard('SHARED_BASE_REQUIRED');
  const stock=original?obj(original.value.stock):{quantity:'0',version:'0',authority:'VERIFIED'};if(stock.authority!=='VERIFIED')guard('SHARED_BASE_REQUIRED');
  const pending:NativeStockProof['pending']=[];let quantity=BigInt(String(stock.quantity));
  for(const {row,v} of rows){if(row.receipt&&BigInt(String(row.receipt.remoteSequence))<=BigInt(String(stock.version)))continue;
   for(const delta of deltas(v).filter(x=>x.productId===pid)){pending.push({operationId:row.operationId,effectId:sharedEffectId(row.operationId,'stock/'+pid),delta:delta.delta});quantity+=BigInt(delta.delta)}
  }
  return{productId:pid,remoteBaseQty:String(stock.quantity),remoteSequence:String(stock.version),pending,effectiveQty:quantity.toString()};
 };
 const serviceBusiness=(kind:string,id:string)=>{const old=base.get(kind+'/'+id);let value=old?.business??null;for(const {row,v} of rows){if(row.receipt&&old&&BigInt(String(row.receipt.remoteSequence))<=BigInt(old.sequence))continue;const payload=obj(v.payload),document=payload.document?obj(payload.document):{},service=document[kind==='REPAIR'?'repair':'layaway'];if(service&&obj(service).id===id)value=document.business??null}return value};
 return{entity,proof,manifest:obj(facts.MANIFEST),base,serviceBusiness};
}
const factsFor=sharedFactsFor;
function inventoryCommands(raw:SharedMutation,previous:SharedOutbox[]):SharedWire[]|undefined{
 if(raw.changes.some(change=>!['productos','composiciones','movimientos_stock','seriales','operaciones_locales'].includes(change.table)))return;
 const productChanges=raw.changes.filter(c=>c.table==='productos'),movements=raw.changes.filter(c=>c.table==='movimientos_stock'&&c.after);
 if(!productChanges.length&&!movements.length)return;
 const result:SharedWire[]=[],virtual=[...previous];
 const append=(wire:SharedWire)=>{const v=obj(JSON.parse(wire.intent));result.push(wire);virtual.push({id:'candidate/'+v.operationId,scopeKey:raw.scopeKey,operationId:String(v.operationId),order:0,context:raw.context,wire,state:'PENDING',sourceOrder:raw.order})};
 const gcd=(a:bigint,b:bigint):bigint=>{while(b){const r=a%b;a=b;b=r}return a};
 for(const change of productChanges){
  const r=change.after??change.before!;const pid=String(r.id),f=factsFor(raw,virtual),old=f.entity('PRODUCT',pid),op=productChanges.length===1?raw.id:sharedEffectId(raw.id,'product/'+pid),deleted=!change.after||r.eliminado===true;
  const revision=String(old?.revision??'0');if(change.before&&!old)guard('SHARED_BASE_REQUIRED');
  const fields=(p:Obj)=>({name:p.nombre,code:p.codigo_barras,price:cents(p.precio_venta),cost:cents(p.costo),minimum:String(p.stock_minimo??0),type:p.tipo,tax:String(p.tasa_itbis),location:p.ubicacion??'',tier2:p.precio_2??null,tier3:p.precio_3??null,photo:p.imagen_url??null,serial:p.serializable??false});
  const stockOnly=change.before&&canonicalCommandForComparison(fields(change.before))===canonicalCommandForComparison(fields(r))&&!raw.changes.some(c=>c.table==='composiciones');
  if(stockOnly&&!deleted)continue;
  if(deleted){if(!old)guard();const request={kind:'PRODUCT_DELETE',operationId:op,productId:pid,expectedRevision:revision},document={product:{...old,revision:next(revision),deleted:true}};delete (document.product as Obj).stock;append(envelope(raw,'PRODUCT_DELETE',op,r.fecha_actualizacion,{request,document}));continue}
  const ingredients=new Map<string,{numerator:string;denominator:string}>();
  for(const part of (obj(old?.metadata??{}).recipe??[]) as Obj[]){const ratio=obj(part.perUnit);ingredients.set(String(part.productId),{numerator:String(ratio.numerator),denominator:String(ratio.denominator)})}
  for(const c of raw.changes.filter(c=>c.table==='composiciones')){if(c.before?.producto_padre_id===pid)ingredients.delete(String(c.before.insumo_id));if(c.after?.producto_padre_id===pid){const ratio=decimalRatio(Number(c.after.cantidad_necesaria)),g=gcd(ratio.n,ratio.d);ingredients.set(String(c.after.insumo_id),{numerator:(ratio.n/g).toString(),denominator:(ratio.d/g).toString()})}}
  const recipe=[...ingredients.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([productId,ratio])=>({productId,...ratio}));
  const percent=BigInt(moneyCents(Number(r.tasa_itbis??0))),g=gcd(percent,BigInt(100));let cost=BigInt(cents(r.costo??0));
  const recipeHistory:Obj[]=[];if(r.tipo==='combo'){let n=ZERO,d=ONE;for(const part of recipe){const ingredient=f.entity('PRODUCT',part.productId);if(!ingredient)guard('SHARED_BASE_REQUIRED');const pn=BigInt(String(obj(ingredient.metadata).costCents))*BigInt(part.numerator),pd=BigInt(part.denominator);n=n*pd+pn*d;d*=pd;recipeHistory.push({productId:part.productId,perUnit:{numerator:part.numerator,denominator:part.denominator},revision:ingredient.revision})}if(n%d!==ZERO)guard('SHARED_RECIPE_COST_REQUIRES_REVIEW');cost=n/d}
  const definition:Obj={name:r.nombre,code:r.codigo_barras??'',priceCents:cents(r.precio_venta),tier2Cents:r.precio_2==null?null:cents(r.precio_2),tier3Cents:r.precio_3==null?null:cents(r.precio_3),costCents:cost.toString(),taxPercent:percent.toString(),productType:r.tipo,location:r.ubicacion??'',minimum:String(r.stock_minimo??0),serialRequired:r.serializable??false,recipe};
  const metadata:Obj={costCents:cost.toString(),taxRate:{numerator:(percent/g).toString(),denominator:(BigInt(100)/g).toString()},serialRequired:definition.serialRequired,recipe:recipeHistory,productType:r.tipo,recipeCostPolicy:r.tipo==='combo'?'NATIVE_EXACT':'DECLARED',location:definition.location,minimum:definition.minimum};
  const oldPhoto=old?obj(old.metadata).photo:undefined;
  if((r.imagen_url??null)!==(change.before?.imagen_url??null)){if(r.imagen_url&&!(String(r.imagen_url).startsWith('data:image/png;base64,')))guard('SHARED_PHOTO_REQUIRES_PNG');definition.photo={data:r.imagen_url??null};metadata.photo=definition.photo}else if(oldPhoto!==undefined)metadata.photo=oldPhoto;
  const product={id:pid,name:definition.name,code:definition.code,revision:next(revision),deleted:false,priceTiers:{retailCents:definition.priceCents,tier2Cents:definition.tier2Cents,tier3Cents:definition.tier3Cents},metadata};
  append(envelope(raw,old?'PRODUCT_PATCH':'PRODUCT_CREATE',op,r.fecha_actualizacion,{request:{kind:'PRODUCT_SAVE',operationId:op,productId:pid,expectedRevision:revision,definition},document:{product}}));
 }
 for(const change of movements){const r=change.after!,pid=String(r.producto_id),f=factsFor(raw,virtual),product=f.entity('PRODUCT',pid);if(!product)guard('SHARED_BASE_REQUIRED');
  const proof=f.proof(pid),before=BigInt(proof.effectiveQty),mode=r.valor_absoluto!==undefined?'COUNT':Number(r.delta)<0?'LOSS':'IN',quantity=mode==='COUNT'?BigInt(String(r.valor_absoluto)):BigInt(Math.abs(Number(r.delta))),delta=mode==='COUNT'?quantity-before:mode==='LOSS'?-quantity:quantity;
  const after=before+delta;if(after<ZERO)guard();const expected=sha256Hex(canonicalNative({quantity:proof.effectiveQty,remoteSequence:proof.remoteSequence,pending:proof.pending})),op=String(r.id);
  const serials=raw.changes.filter(c=>c.table==='seriales'&&(c.after??c.before)?.producto_id===pid).filter(c=>mode==='IN'?!c.before&&c.after?.estado==='disponible':mode==='LOSS'?c.before?.estado==='disponible'&&c.after?.estado==='merma':c.after?.estado==='disponible').map(c=>String((c.after??c.before)!.numero_serial)).sort();
  const reason=r.razon??(r.tipo==='merma'?'Merma de inventario':r.tipo==='conteo'?'Conteo físico':'Entrada de inventario');
  const request={kind:'INVENTORY_CHANGE',operationId:op,productId:pid,expectedStockRevision:expected,mode,quantity:quantity.toString(),reason,serials},document={productId:pid,productRevision:product.revision,delta:delta.toString(),before:before.toString(),after:after.toString(),mode,reason,serials,stockEvidence:proof,...(obj(product.metadata).serialRequired===true&&mode!=='IN'?{serialChanges:raw.changes.filter(c=>c.table==='seriales'&&(c.after??c.before)?.producto_id===pid).flatMap(c=>{const before=c.before?.estado==='disponible'?'AVAILABLE':c.before?.estado==='merma'?'LOST':null,after=c.after?.estado==='disponible'?'AVAILABLE':c.after?.estado==='merma'?'LOST':null;if(before===after)return[];if(!after||before===null&&c.before)guard('SHARED_SERIAL_REVIEW_REQUIRED');return[{productId:pid,text:String((c.after??c.before)!.numero_serial),expectedRevision:c.before?'1':null,before,after}]}).sort((a,b)=>a.text<b.text?-1:a.text>b.text?1:0)}:{})};
  append(envelope(raw,mode==='COUNT'?'INVENTORY_COUNT':'INVENTORY_DELTA',op,r.fecha_creacion,{request,document}));
 }
 return result;
}
const canonicalCommandForComparison=commandHash;
export function compileSharedMutation(raw:SharedMutation,previous:SharedOutbox[]):SharedWire|SharedWire[]|null{
 if(commandHash({changes:raw.changes,facts:raw.facts})!==raw.sourceHash)guard('SHARED_CAPTURE_CHANGED');
 const f=factsFor(raw,previous),journal=raw.changes.filter(c=>c.table==='operaciones_locales'&&c.after).map(c=>obj(c.after));
 const config=raw.changes.find(c=>c.table==='shared_configuration')?.after;
 if(config){const op=raw.id,at=config.at,request:Obj={kind:config.kind,operationId:op};let document:Obj;
  if(config.kind==='SERVICE_REFUND'){const family=config.family==='repair'?'repair':'layaway',serviceId=String(config.serviceId),type=family==='repair'?'REPAIR':'LAYAWAY',service=f.entity(type,serviceId);if(!service)guard('SHARED_BASE_REQUIRED');const summary=f.entity('SERVICE_REFUNDS',family+'/'+serviceId)??{revision:'0',refundedCents:'0'},basis=sharedDepositBasis(service,family),refunded=BigInt(String(summary.refundedCents)),amount=BigInt(String(config.amountCents)),pending=basis-refunded,method=String(config.method),turnId=method==='EFECTIVO'?String(raw.facts.ACTIVE_TURN_ID??''):null;if(amount<=ZERO||amount>pending||method==='EFECTIVO'&&!turnId)guard('SHARED_DEPOSIT_REVIEW_REQUIRED');const document:Obj={service:{family,id:serviceId,revision:service.revision,folio:service.folio,basisCents:basis.toString()},refund:{operationId:op,revision:next(summary.revision),amountCents:amount.toString(),method,turnId,dateMs:String(at),reason:config.reason},refundedBeforeCents:refunded.toString(),refundedAfterCents:(refunded+amount).toString(),pendingBeforeCents:pending.toString(),pendingAfterCents:(pending-amount).toString(),amountCents:amount.toString(),method,concept:'Devolución de depósito '+service.folio,business:f.serviceBusiness(type,serviceId)};if(turnId)document.cashDeltaCents=(-amount).toString();return envelope(raw,'SERVICE_REFUND',op,at,{request:{kind:'SERVICE_REFUND',operationId:op,family,serviceId,expectedServiceRevision:service.revision,expectedRefundRevision:summary.revision,amountCents:amount.toString(),method,turnId,reason:config.reason},document},turnId)}
  if(config.kind==='BUSINESS_SAVE'){const definition=obj(config.definition),latest=previous.map(row=>obj(obj(JSON.parse(row.wire.intent)).payload)).map(p=>p.document?obj(p.document):{}).filter(d=>d.businessSettings).at(-1),base=latest?obj(latest.business):obj(f.manifest.business??{}),revision=next(base.settingsRevision??'0'),profile={name:definition.name,rnc:definition.rnc||null,address:definition.address||null,phone:definition.phone||null,footer:definition.footer||null,whatsapp:definition.whatsapp||null,logo:definition.logo,color:definition.color,font:definition.font,bank:definition.bank,settingsRevision:revision,settingsOperationId:op};request.expectedRevision=base.settingsRevision??'0';request.definition=definition;document={operationId:op,businessSettings:{revision,definition},business:profile,amountCents:'0',method:null,concept:'Configuración del negocio'};
  }else if(config.kind==='CATALOGUE_PUBLISH'){request.expectedRevision=config.expectedRevision;request.expectedEnabled=config.expectedEnabled;request.enabled=config.enabled;document={cataloguePublication:{enabled:config.enabled,revision:next(config.expectedRevision),publicPath:'/catalogo/'+raw.context.tenantId},amountCents:'0',method:null,concept:config.enabled?'Catálogo público activado':'Catálogo público desactivado'};
  }else if(config.kind==='WARRANTY_DEFAULT'){const prior=previous.map(row=>obj(obj(JSON.parse(row.wire.intent)).payload)).map(p=>p.document?obj(p.document):{}).filter(d=>d.warrantyDefault).at(-1),base=prior?obj(prior.warrantyDefault):obj(f.manifest.warrantyDefault??{revision:'0',days:'30'});request.expectedRevision=base.revision;request.days=config.days;document={operationId:op,warrantyDefault:{days:config.days,revision:next(base.revision)},amountCents:'0',method:null,concept:'Garantía por defecto'};
  }else guard();return envelope(raw,'CONFIG_PATCH',op,at,{request,document});
 }
 const checkout=journal.find(c=>c.tipo==='CHECKOUT'&&obj(c.resultado).estado==='COMMITTED');
 if(checkout){const input=obj(checkout.resultado) as unknown as CheckoutEntrada,c=input.comando;
  const products=new Map<string,NativeProduct>();for(const [key] of f.base){if(key.startsWith('PRODUCT/')){const id=key.slice(8),value=f.entity('PRODUCT',id);if(value)products.set(id,value as unknown as NativeProduct)}}
  for(const item of c.items){if(item.sinStock)continue;const value=f.entity('PRODUCT',item.productoId);if(!value)guard('SHARED_BASE_REQUIRED');products.set(item.productoId,value as unknown as NativeProduct)}
  const stockIds=new Set<string>();for(const product of products.values()){if(product.metadata.recipe.length)for(const part of product.metadata.recipe)stockIds.add(part.productId);else stockIds.add(product.id)}
  const proofs=[...stockIds].map(f.proof),serials=[...f.base.entries()].filter(([key])=>key.startsWith('SERIAL/')).map(([,e])=>e.value as unknown as SharedSaleFacts['serials'][number]);
  const customer=c.clienteId?f.entity('CUSTOMER',c.clienteId):null;
  const facts:SharedSaleFacts={context:raw.context,products:[...products.values()],proofs,serials,freeTax:f.manifest.freeTax as SharedSaleFacts['freeTax'],business:f.manifest.business,ticketSequence:String(obj(obj(obj(checkout.resultado).efectos).secuencia).numeroTicket)};
  if(customer)facts.customer={id:String(customer.id),name:String(customer.name),metadataRevision:String(customer.metadataRevision??'1'),priceTier:String(customer.priceTier??'1')};
  return buildSharedSale(input,facts);
 }
 const primary=raw.changes.filter(c=>c.table!=='operaciones_locales'&&c.table!=='movimientos_stock');
 const opened=primary.find(c=>c.table==='cajas'&&c.after&&c.before===null&&c.after.estado==='abierta');
 if(opened){const r=opened.after!;return envelope(raw,'TURN_OPEN',String(r.id),r.fecha_apertura,{openingCents:cents(r.monto_apertura)})}
 const cut=primary.find(c=>c.table==='cortes_caja'&&c.after);
 if(cut){const r=cut.after!,turnId=String(r.caja_id),kind=r.tipo==='Z'?'TURN_CLOSE':'CUT_X',captured=f.base.get('DRAWER/'+turnId),origin=primary.find(c=>c.table==='cajas'&&(c.after??c.before)?.id===turnId),turn=f.entity('TURN',turnId);
  let d:SharedDrawer;if(captured)d=structuredClone(captured.value) as SharedDrawer;else if(turn)d=emptySharedDrawer(turnId,String(turn.openingCents),String(turn.openedAtMs));else{const opening=previous.find(row=>{const v=obj(JSON.parse(row.wire.intent));return v.kind==='TURN_OPEN'&&v.operationId===turnId});if(!opening)guard('SHARED_TURN_LINK_REQUIRED');const v=obj(JSON.parse(opening.wire.intent));d=emptySharedDrawer(turnId,String(obj(v.payload).openingCents),String(v.originAtUtcMs))}
  for(const row of previous){if(row.receipt&&captured&&BigInt(String(row.receipt.remoteSequence))<=BigInt(captured.sequence))continue;applySharedDrawer(d,obj(JSON.parse(row.wire.intent)))}
  if(d.status!=='OPEN'||kind==='TURN_CLOSE'&&cents(r.monto_esperado)!==d.expectedCents)guard('SHARED_CASH_FACTS_REVIEW_REQUIRED');
  const counted=kind==='TURN_CLOSE'?cents(r.monto_contado):'0',denominations=Object.entries(obj(origin?.after?.denominaciones_cierre??{})).map(([value,count])=>({valueCents:cents(value),count:String(count)})).sort((a,b)=>Number(a.valueCents)-Number(b.valueCents)),notes=origin?.after?.notas??null,op=String(r.id),request={kind,operationId:op,turnId,countedCents:counted,denominations,...(notes===null?{}:{notes})},document:Obj={drawer:drawerDocument(d),countedCents:counted,differenceCents:(BigInt(counted)-BigInt(d.expectedCents)).toString(),denominations,notes};if(f.manifest.business)document.business=f.manifest.business;
  return envelope(raw,kind,op,r.fecha_creacion,{request,document},turnId);
 }
 const customer=primary.find(c=>c.table==='clientes');
 const warranty=primary.find(c=>c.table==='seriales'&&c.after&&c.before);
 if(warranty&&primary.length===1&&!raw.changes.some(c=>c.table==='movimientos_stock')){const r=warranty.after!,s=f.entity('SERIAL',r.producto_id+'/'+r.numero_serial),old=obj(s?.warranty),days=String(r.garantia_dias??0);if(old.state!=='SOLD'||!old.soldAtMs||!Number.isSafeInteger(Number(days))||Number(days)<0||Number(days)>3650)guard('SHARED_WARRANTY_BASIS_REQUIRED');const until=BigInt(days)>ZERO?(BigInt(String(old.soldAtMs))+BigInt(days)*BigInt(86400000)).toString():null;if((r.garantia_hasta==null?null:String(r.garantia_hasta))!==until)guard('SHARED_WARRANTY_FACTS_CHANGED');const {revision,...body}=old,op=raw.id,request={kind:'WARRANTY_SAVE',operationId:op,productId:r.producto_id,serial:r.numero_serial,expectedRevision:revision,action:'ADJUST',days},document={operationId:op,warranty:{...body,days,untilMs:until,version:next(old.version)},business:f.manifest.business??null,amountCents:'0',method:null,concept:'Garantía '+r.numero_serial};return envelope(raw,'WARRANTY_PATCH',op,r.fecha_actualizacion,{request,document})}
 if(customer&&primary.length===1){const r=customer.after??customer.before!,id=String(r.id),old=f.entity('CUSTOMER',id),revision=String(old?.metadataRevision??(old?'1':'0')),deleted=!customer.after||r.eliminado===true,op=raw.id;
  const cu:Obj=deleted?{id,name:old?.name,phone:old?.phone??null,limitCents:old?.limitCents,priceTier:Number(old?.priceTier??1),wholesale:old?.wholesale??false,active:false,revision:next(revision)}:{id,name:r.nombre,phone:r.telefono??null,limitCents:cents(r.limite_credito),priceTier:Number(r.tipo_precio??1),wholesale:r.al_por_mayor??false,active:true,revision:next(revision)};
  const kind=deleted?'CUSTOMER_DELETE':old?'CUSTOMER_PATCH':'CUSTOMER_CREATE',req=deleted?{kind:'CUSTOMER_DELETE',operationId:op,customerId:id,expectedRevision:revision}:{kind:'CUSTOMER_SAVE',operationId:op,customerId:id,expectedRevision:revision,name:cu.name,phone:cu.phone,limitCents:cu.limitCents,priceTier:cu.priceTier,wholesale:cu.wholesale};
  return envelope(raw,kind,op,r.fecha_actualizacion,{request:req,document:{customer:cu}});
 }
 const payment=primary.find(c=>c.table==='transacciones_fiado'&&c.after?.tipo==='abono'&&!c.after.venta_id);
 if(payment&&primary.length===1){const r=payment.after!,account=f.entity('CUSTOMER',String(r.cliente_id));if(!account)guard('SHARED_BASE_REQUIRED');const amount=cents(r.monto),before=BigInt(String(account.balanceCents)),after=before-BigInt(amount);if(after<ZERO)guard();const method={efectivo:'EFECTIVO',tarjeta:'TARJETA',transferencia:'TRANSFERENCIA'}[String(r.metodo_pago)]??guard(),op=String(r.id),turn=String(r.caja_id),concept=String(r.concepto);
  const request={kind:'CREDIT_PAYMENT',operationId:op,customerId:r.cliente_id,expectedRevision:account.revision,amountCents:amount,method,concept,turnId:turn},document={customerId:r.cliente_id,balanceBeforeCents:before.toString(),balanceAfterCents:after.toString(),balanceRevision:next(account.revision),amountCents:amount,method,concept,cashDeltaCents:method==='EFECTIVO'?amount:'0'};
  return envelope(raw,'CREDIT_PAYMENT',op,r.fecha_creacion,{request,document},turn);
 }
 const expense=primary.find(c=>c.table==='gastos'&&c.after&&!c.after.eliminado);
 if(expense&&primary.length===1){if(expense.before)guard();const r=expense.after!,amount=cents(r.monto),method={efectivo:'EFECTIVO',tarjeta:'TARJETA',transferencia:'TRANSFERENCIA'}[String(r.metodo)]??guard(),op=String(r.id),turn=String(r.caja_id??raw.facts.ACTIVE_TURN_ID??'');if(!turn)guard('SHARED_TURN_LINK_REQUIRED');const concept=String(r.descripcion),request={kind:'EXPENSE_RECORD',operationId:op,amountCents:amount,method,concept,category:r.categoria,turnId:turn},document={amountCents:amount,method,concept,category:r.categoria,cashDeltaCents:method==='EFECTIVO'?(-BigInt(amount)).toString():'0'};return envelope(raw,'EXPENSE_RECORD',op,r.fecha_creacion,{request,document},turn)}
 const inventory=inventoryCommands(raw,previous);if(inventory)return inventory;
 if(!primary.length&&journal.every(row=>['CHECKOUT','CHECKOUT_DRAFT_RELEASE'].includes(String(row.tipo))))return null;
 guard();
}
export async function prepareSharedMutation(db:VentaRDDatabase,id:string,planner?:SharedServicePlanner):Promise<void>{
 let planned:{hash:string;wire:SharedWire}|undefined;
 try{if(planner){
  const raw=await db.shared_mutations.get(id);if(!raw||raw.state!=='CAPTURED')return;
  const previous=(await db.shared_outbox.where('scopeKey').equals(raw.scopeKey).toArray()).filter(r=>(r.sourceOrder??0)<raw.order).sort((a,b)=>(a.sourceOrder??0)-(b.sourceOrder??0)||(a.sourcePart??0)-(b.sourcePart??0));
  const facts=factsFor(raw,previous),task=sharedServiceTask(raw,facts)??sharedReturnTask(raw,facts);if(task){
   if(commandHash({changes:raw.changes,facts:raw.facts})!==raw.sourceHash)guard('SHARED_CAPTURE_CHANGED');
   const candidate=await planner(raw.context,task.family,task.request,task.previous,task.at,task.folio,task.folioNumber);
   planned={hash:raw.sourceHash,wire:envelope(raw,task.kind,task.operationId,task.at,{request:task.request,document:task.finish(candidate)},task.turnId)};
  }
 }}catch(error){
  if(error instanceof SharedRemoteError){await db.shared_mutations.update(id,{code:error.code});return}
  const code=error instanceof Error&&/^SHARED_[A-Z_]+$/.test(error.message)?error.message:'SHARED_SERVICE_REVIEW_REQUIRED';await db.shared_mutations.update(id,{state:'BLOCKED',code});return;
 }
 try{await db.transaction('rw',db.shared_mutations,db.shared_outbox,db.shared_state,async()=>{
  const raw=await db.shared_mutations.get(id);if(!raw||raw.state!=='CAPTURED')return;
  const previous=(await db.shared_outbox.where('scopeKey').equals(raw.scopeKey).toArray()).filter(r=>(r.sourceOrder??0)<raw.order).sort((a,b)=>(a.sourceOrder??0)-(b.sourceOrder??0)||(a.sourcePart??0)-(b.sourcePart??0));
  if(planned&&planned.hash!==raw.sourceHash)guard('SHARED_CAPTURE_CHANGED');
  const compiled=planned?.wire??compileSharedMutation(raw,previous);if(!compiled){await db.shared_mutations.update(id,{state:'APPLIED'});return}const wires=Array.isArray(compiled)?compiled:[compiled],operations:string[]=[];for(let part=0;part<wires.length;part++){const frozen=await freezeSharedOperation(db,raw.context,wires[part]);operations.push(frozen.operationId);await db.shared_outbox.update(frozen.id,{sourceMutationId:raw.id,sourceOrder:raw.order,sourcePart:part})}
  const repair=raw.changes.find(c=>c.table==='reparaciones'&&c.after&&(c.after.patron_clave??'')!==(c.before?.patron_clave??''))?.after;
  let privateChange:SharedMutation['private'];if(repair){const c=raw.context,v=wires.map(w=>obj(JSON.parse(w.intent))).find(v=>['REPAIR_CREATE','REPAIR_EDIT'].includes(String(v.kind)));if(!v)guard('SHARED_PRIVATE_REVIEW_REQUIRED');const document=obj(obj(v.payload).document),service=obj(document.repair),value=String(repair.patron_clave??'');if(value.length>256||/[\x00-\x1f\x7f]/.test(value))guard('SHARED_PRIVATE_REVIEW_REQUIRED');const intent=canonicalNative({protocol:'ventard.repair.private.1',operationId:v.operationId,tenantId:c.tenantId,scope:{type:c.scopeType,branchId:c.branchId},actorId:c.actorId,installationId:c.installationId,deviceId:c.deviceId,writerEpoch:c.writerEpoch,repairId:service.id,repairRevision:service.revision,baseOperationId:null,value});privateChange={intent,hash:sha256Hex(intent),state:'PENDING'}}
  await db.shared_mutations.update(id,{state:operations.length?'PREPARED':'APPLIED',operationId:operations[0],operationIds:operations,...(privateChange?{private:privateChange}:{})});
 })}catch(error){
  const code=error instanceof Error&&/^SHARED_[A-Z_]+$/.test(error.message)?error.message:'SHARED_OPERATION_REVIEW_REQUIRED';
  await db.transaction('rw',db.shared_mutations,async()=>{if((await db.shared_mutations.get(id))?.state==='CAPTURED')await db.shared_mutations.update(id,{state:'BLOCKED',code})});
 }
}
