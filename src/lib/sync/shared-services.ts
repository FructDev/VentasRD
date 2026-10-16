import type {SharedMutation} from './shared-capture';
import type {sharedFactsFor} from './shared-compile';
import {moneyCents} from '@/lib/domain/local/command';
import {canonicalNative,type SharedContext} from './shared-journal';
import {sha256Hex} from './inventory/canonical-payload';
type Obj=Record<string,unknown>;
const obj=(v:unknown):Obj=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('SHARED_SERVICE_REVIEW_REQUIRED');return v as Obj};
const cents=(v:unknown)=>String(moneyCents(Number(v)));
const method=(v:unknown)=>({efectivo:'EFECTIVO',tarjeta:'TARJETA',transferencia:'TRANSFERENCIA'} as Record<string,string>)[String(v)]??(()=>{throw Error('SHARED_SERVICE_METHOD_REQUIRED')})();
export type SharedServicePlanner=(c:SharedContext,family:string,request:Obj,previous:Obj|null,at:string,folio:string,folioNumber:string)=>Promise<unknown>;
export interface SharedServiceTask {family:'REPAIR'|'LAYAWAY'|'RETURN';kind:string;operationId:string;at:string;request:Obj;previous:Obj|null;folio:string;folioNumber:string;turnId:string|null;finish:(candidate:unknown)=>Obj}
export function sharedServiceTask(raw:SharedMutation,f:ReturnType<typeof sharedFactsFor>):SharedServiceTask|undefined{
 const repairChange=raw.changes.find(c=>c.table==='reparaciones'),layawayChange=raw.changes.find(c=>c.table==='apartados');if(!repairChange&&!layawayChange)return;
 if(repairChange&&layawayChange)throw Error('SHARED_SERVICE_REVIEW_REQUIRED');
 const change=repairChange??layawayChange!,family=repairChange?'REPAIR':'LAYAWAY',r=change.after;if(!r)throw Error('SHARED_SERVICE_REVIEW_REQUIRED');
 const previous=f.entity(family,String(r.id)),revision=String(previous?.revision??'0');
 const journal=raw.changes.find(c=>c.table==='operaciones_locales'&&c.after?.tipo===(repairChange?'REPARACION':'APARTADO'))?.after;
 if(!journal)throw Error('SHARED_SERVICE_REVIEW_REQUIRED');const op=String(journal.operation_id),at=String(journal.fecha_origen);
 const beforePaid=BigInt(String(previous?.paidCents??'0')),paid=BigInt(cents(repairChange?r.abono:r.abonado)),delta=paid-beforePaid;if(delta<BigInt(0))throw Error('SHARED_SERVICE_REVIEW_REQUIRED');
 const payments=(repairChange?r.pagos:r.abonos) as Obj[]??[],priorPayments=(repairChange?change.before?.pagos:change.before?.abonos) as Obj[]??[],added=payments.slice(priorPayments.length);
 if(added.length>1)throw Error('SHARED_SERVICE_REVIEW_REQUIRED');
 const payment=added[0],paymentMethod=payment?method(payment.metodo):'EFECTIVO',turnId=payment?.caja_id?String(payment.caja_id):null;
 let request:Obj,kind:string;
 if(family==='REPAIR'&&previous?.state==='abandonado'&&r.estado==='cancelado'){
  kind='REPAIR_DISASSEMBLE';const entries=new Map<string,bigint>();for(const c of raw.changes.filter(c=>c.table==='movimientos_stock'&&c.after)){const m=c.after!;entries.set(String(m.producto_id),(entries.get(String(m.producto_id))??BigInt(0))+BigInt(String(m.delta)))}
  request={kind,operationId:op,repairId:r.id,expectedRevision:revision,entries:[...entries].sort(([a],[b])=>a.localeCompare(b)).map(([productId,quantity])=>{if(quantity<=BigInt(0))throw Error('SHARED_SERVICE_REVIEW_REQUIRED');const created=raw.changes.find(c=>c.table==='productos'&&c.before===null&&c.after?.id===productId)?.after;return{productId,quantity:quantity.toString(),newProduct:created?{name:created.nombre,code:'',priceCents:'0',tier2Cents:null,tier3Cents:null,costCents:cents(created.costo),taxPercent:'0',productType:'insumo',location:'',minimum:'0',serialRequired:false,recipe:[]}:null}})};
 }else if(family==='REPAIR'){
  const parts=(r.repuestos as Obj[]??[]).map(p=>({productId:p.desde_inventario?p.producto_id??null:null,name:p.nombre,quantity:String(p.cantidad),costCents:cents(p.costo),priceCents:cents(p.precio)}));
  const labour=BigInt(cents(r.mano_obra)),partsTotal=parts.reduce((n,p)=>n+BigInt(p.priceCents)*BigInt(p.quantity),BigInt(0)),total=BigInt(cents(r.total)),chargeParts=partsTotal>BigInt(0)&&total===labour+partsTotal?true:partsTotal>BigInt(0)&&total===labour?false:(previous?.definition as Obj|undefined)?.partsChargeSeparate??false;
  const definition:Obj={customerId:r.cliente_id??null,customerName:r.cliente_nombre,phone:r.cliente_telefono??'',brand:r.equipo_marca??'',model:r.equipo_modelo,imei:r.equipo_imei??'',color:r.equipo_color??'',conditionChecks:r.condicion_checklist??[],conditionNotes:r.condicion_entrada??'',accessories:r.accesorios??'',problem:r.problema_reportado,diagnosis:r.diagnostico??'',notes:r.notas??'',technician:r.tecnico_nombre??'',labourCents:cents(r.mano_obra),partsChargeSeparate:chargeParts,parts};
  if(r.es_garantia&&r.reparacion_origen_id)definition.warrantyOriginId=r.reparacion_origen_id;
  if(!previous||delta===BigInt(0)&&r.estado===previous.state||r.estado==='cotizado'&&['recibido','diagnostico','cotizado'].includes(String(previous.state))&&delta===BigInt(0)){
   kind=previous?'REPAIR_EDIT':'REPAIR_CREATE';request={kind:'REPAIR_SAVE',operationId:op,repairId:r.id,expectedRevision:revision,definition,quote:r.estado==='cotizado',initialPaymentCents:previous?'0':delta.toString(),method:paymentMethod,turnId};
  }else{
   const actions:Record<string,string>={diagnostico:'DIAGNOSE',en_reparacion:previous.state==='cotizado'?'APPROVE':'WORK',esperando_repuesto:'WAIT',listo:'READY',entregado:'DELIVER',no_reparado:'REJECT',abandonado:'ABANDON',cancelado:'CANCEL'};
   const action=r.estado===previous.state&&delta>BigInt(0)?'PAYMENT':actions[String(r.estado)];if(!action)throw Error('SHARED_SERVICE_REVIEW_REQUIRED');
   kind='REPAIR_EDIT';request={kind:'REPAIR_ACTION',operationId:op,repairId:r.id,expectedRevision:revision,action,amountCents:action==='DELIVER'?'0':delta.toString(),method:paymentMethod,turnId,warrantyDays:action==='DELIVER'?String(r.garantia_dias??0):'0'};
  }
 }else if(!previous){kind='LAYAWAY_CREATE';request={kind:'LAYAWAY_CREATE',operationId:op,layawayId:r.id,definition:{customerId:r.cliente_id??null,customerName:r.cliente_nombre,phone:r.cliente_telefono??'',notes:r.notas??'',items:(r.items as Obj[]).map(item=>({productId:item.producto_id,name:item.nombre,quantity:String(item.cantidad),priceCents:cents(item.precio_unitario),serial:item.serial_numero??null}))},initialPaymentCents:delta.toString(),method:paymentMethod,turnId}}
 else{const action=r.estado==='completado'?'COMPLETE':r.estado==='cancelado'?'CANCEL':delta>BigInt(0)?'PAYMENT':null;if(!action)throw Error('SHARED_SERVICE_REVIEW_REQUIRED');kind=action==='PAYMENT'?'LAYAWAY_PAYMENT':action==='COMPLETE'?'LAYAWAY_COMPLETE':'LAYAWAY_CANCEL';request={kind:'LAYAWAY_ACTION',operationId:op,layawayId:r.id,expectedRevision:revision,action,amountCents:action==='PAYMENT'?delta.toString():'0',method:paymentMethod,turnId,warrantyDays:action==='COMPLETE'?String(r.garantia_dias??0):'0'}}
 if(!previous&&r.cliente_id&&!f.entity('CUSTOMER',String(r.cliente_id))){if(!raw.changes.some(c=>c.table==='clientes'&&c.after?.id===r.cliente_id))throw Error('SHARED_BASE_REQUIRED');request.createCustomer=true}
 const folio=String(previous?.folio??r.folio),number=String(previous?.folioNumber??folio.split('-').at(-1));
 if(!previous&&folio!==(family==='REPAIR'?'REP-':'AP-')+'N'+raw.context.installationId.replaceAll('-','')+'-'+number.padStart(3,'0'))throw Error('SHARED_SERVICE_FOLIO_REQUIRES_REVIEW');
 const stockDeltas=new Map<string,bigint>();for(const c of raw.changes.filter(c=>c.table==='movimientos_stock'&&c.after)){const m=c.after!;stockDeltas.set(String(m.producto_id),(stockDeltas.get(String(m.producto_id))??BigInt(0))+BigInt(String(m.delta)))}
 const stock=[...stockDeltas].filter(([,qty])=>qty!==BigInt(0)).sort(([a],[b])=>a.localeCompare(b)).map(([productId,quantity])=>{const created=kind==='REPAIR_DISASSEMBLE'&&(request.entries as Obj[]).some(e=>e.productId===productId&&e.newProduct),proof=created?{productId,remoteBaseQty:'0',remoteSequence:'0',pending:[],effectiveQty:'0'}:f.proof(productId),before=BigInt(proof.effectiveQty);return{productId,delta:quantity.toString(),before:before.toString(),after:(before+quantity).toString(),expectedRevision:sha256Hex(canonicalNative({quantity:proof.effectiveQty,remoteSequence:proof.remoteSequence,pending:proof.pending})),stockEvidence:proof}});
 const business=previous?f.serviceBusiness(family,String(r.id)):f.manifest.business??null;
 return{family,kind,operationId:op,at,request,previous,folio,folioNumber:BigInt(number).toString(),turnId,finish(value){
  const response=obj(value);if(response.protocol!=='ventard.web.service.candidate.1'||response.family!==family||response.operationId!==op)throw Error('SHARED_SERVICE_CANDIDATE_INVALID');
  const candidate=obj(response.candidate),service=obj(candidate[family==='REPAIR'?'repair':'layaway']);
  if(service.id!==r.id||service.state!==r.estado||service.totalCents!==cents(r.total)||service.paidCents!==paid.toString()||service.folio!==folio||candidate.amountCents!==delta.toString())throw Error('SHARED_SERVICE_FACTS_CHANGED');
  const document:Obj={...candidate,stock,business};
  if(kind==='REPAIR_DISASSEMBLE')document.products=(request.entries as Obj[]).filter(e=>e.newProduct).map(entry=>{const definition=obj(entry.newProduct),pid=String(entry.productId);return{request:{kind:'PRODUCT_SAVE',operationId:op,productId:pid,expectedRevision:'0',definition},document:{product:{id:pid,name:definition.name,code:'',revision:'1',deleted:false,priceTiers:{retailCents:'0',tier2Cents:null,tier3Cents:null},metadata:{costCents:definition.costCents,taxRate:{numerator:'0',denominator:'1'},serialRequired:false,recipe:[],productType:'insumo',recipeCostPolicy:'DECLARED',location:'',minimum:'0'}}}}});
  if(family==='LAYAWAY'){const changes:Obj[]=[];if(!previous||request.action==='COMPLETE'||request.action==='CANCEL')for(const item of (obj(service.definition).items as Obj[])){if(!item.serial)continue;const s=f.entity('SERIAL',item.productId+'/'+item.serial),before=previous?'RESERVED':'AVAILABLE';if(!s||s.state!==before)throw Error('SHARED_SERVICE_SERIAL_REVIEW_REQUIRED');changes.push({productId:item.productId,text:item.serial,expectedRevision:s.revision,before,after:request.action==='COMPLETE'?'SOLD':request.action==='CANCEL'?'AVAILABLE':'RESERVED'})}document.serials=changes.sort((a,b)=>String(a.text).localeCompare(String(b.text)))}
  if(request.createCustomer){document.customer={id:r.cliente_id,name:r.cliente_nombre,phone:r.cliente_telefono??null,limitCents:'0',priceTier:1,wholesale:false,active:true,revision:'1',...(family==='LAYAWAY'?{balanceCents:'0',balanceRevision:'1',authority:'VERIFIED'}:{})}}
  return document;
 }};
}
