import type {SharedMutation} from './shared-capture';
import type {sharedFactsFor} from './shared-compile';
import type {SharedServiceTask} from './shared-services';
import {moneyCents} from '@/lib/domain/local/command';
import {canonicalNative} from './shared-journal';
import {sha256Hex} from './inventory/canonical-payload';
import {sharedEffectId} from './shared-sale';
type Obj=Record<string,unknown>;
const obj=(v:unknown):Obj=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('SHARED_RETURN_BASIS_REQUIRED');return v as Obj};
export function sharedReturnTask(raw:SharedMutation,f:ReturnType<typeof sharedFactsFor>):SharedServiceTask|undefined{
 const change=raw.changes.find(change=>change.table==='devoluciones'&&change.after);if(!change)return;
 const r=change.after!,op=String(r.id),saleId=String(r.venta_id),basis=f.entity('RETURN_BASIS',saleId);if(!basis)throw Error('SHARED_RETURN_BASIS_REQUIRED');
 const snapshot=obj(basis.snapshot),sale=obj(snapshot.sale);if(snapshot.ncf!==null)throw Error('SHARED_RETURN_BASIS_REQUIRED');
 const prior=basis.returns as Obj[],serials=raw.changes.filter(c=>c.table==='seriales'&&c.before?.estado==='vendido'&&c.after?.estado==='disponible').map(c=>String(c.before!.numero_serial)).sort();
 const items=(r.items_devueltos as Obj[]).map(item=>{const index=(sale.lines as Obj[]).findIndex((line,i)=>line.productId===item.producto_id||line.productId===null&&String(item.producto_id)===sharedEffectId(saleId,'line/'+i));if(index<0)throw Error('SHARED_RETURN_FREE_LINE_REVIEW_REQUIRED');return{key:(sale.lines as Obj[])[index].productId??'free/'+index,quantity:String(item.cantidad)}}).sort((a,b)=>String(a.key).localeCompare(String(b.key)));
 const rev=sha256Hex(canonicalNative({snapshotHash:basis.snapshotHash,returns:prior.map(p=>({operationId:p.operationId,refund:obj(p.document).refund}))})),turnId=typeof r.caja_id==='string'?r.caja_id:null;if(!turnId)throw Error('SHARED_TURN_LINK_REQUIRED');
 const request={kind:'SALE_RETURN',operationId:op,saleId,expectedReturnRevision:rev,items,serials,reason:r.razon,turnId};
 return{family:'RETURN',kind:'SALE_RETURN',operationId:op,at:String(r.fecha_creacion),request,previous:{sale,prior:prior.map(p=>obj(p.document).refund)},folio:'',folioNumber:'0',turnId,finish(value){
  const refund=obj(value);if(refund.amountCents!==String(moneyCents(Number(r.monto_devuelto)))||canonicalNative(refund.items)!==canonicalNative(items))throw Error('SHARED_RETURN_FACTS_CHANGED');
  const stock=(refund.inventory as Obj[]).map(item=>{const productId=String(item.productId),proof=f.proof(productId),delta=BigInt(String(item.delta)),captured=raw.changes.filter(c=>c.table==='movimientos_stock'&&c.after?.producto_id===productId).reduce((n,c)=>n+BigInt(String(c.after!.delta)),BigInt(0));if(delta!==captured)throw Error('SHARED_RETURN_FACTS_CHANGED');return{productId,delta:delta.toString(),before:proof.effectiveQty,after:(BigInt(proof.effectiveQty)+delta).toString(),expectedRevision:sha256Hex(canonicalNative({quantity:proof.effectiveQty,remoteSequence:proof.remoteSequence,pending:proof.pending})),stockEvidence:proof}});
  const serialProof=(refund.serials as Obj[]).map(serial=>{const old=f.entity('SERIAL',serial.productId+'/'+serial.text);if(!old||old.state!=='SOLD'||old.saleOperationId!==saleId)throw Error('SHARED_RETURN_SERIAL_REVIEW_REQUIRED');return{productId:serial.productId,text:serial.text,expectedRevision:old.revision}});
  let credit:Obj|null=null;if(refund.method==='FIADO'){const customerId=String(obj(sale.payment).customerId),old=f.entity('CUSTOMER',customerId),amount=BigInt(String(refund.amountCents));if(!old||BigInt(String(old.balanceCents))<amount)throw Error('SHARED_RETURN_CREDIT_REVIEW_REQUIRED');credit={customerId,beforeCents:old.balanceCents,afterCents:(BigInt(String(old.balanceCents))-amount).toString(),expectedRevision:old.revision}}
  return{saleId,originalSnapshotHash:basis.snapshotHash,priorReturnIds:prior.map(p=>p.operationId),returnRevision:rev,refund,stock,serialProof,credit,method:refund.method,amountCents:refund.amountCents,concept:r.razon,cashDeltaCents:(-BigInt(String(refund.cashRefundCents))).toString()};
 }};
}
