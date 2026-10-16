import {sharedEffectId} from './shared-effects';
type Obj=Record<string,unknown>;
const integer=(v:unknown,signed=false)=>{if(typeof v!=='string'||!(signed?/^-?(0|[1-9][0-9]{0,15})$/:/^(0|[1-9][0-9]{0,15})$/).test(v)||!Number.isSafeInteger(Number(v)))throw Error('SHARED_RECEIPT_MISMATCH');return BigInt(v)};
const id=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const allowed=new Set(['PRODUCT_CREATE','INVENTORY_DELTA','SALE_CONFIRM','SALE_RETURN','REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE','LAYAWAY_CREATE','LAYAWAY_CANCEL']);
/** A merge changes the authoritative stock base only. Its original sale, price,
 * tax, payment, ticket and proof stay byte-for-byte unchanged. */
export function sharedStockBefore(row:Obj,proof:Obj,sequence:unknown):bigint{
 const quoted=integer(proof.effectiveQty);if(row.merge===undefined)return quoted;
 const m=row.merge as Obj;if(!m||m.protocol!=='ventard.stock.merge.1'||m.quotedBefore!==proof.effectiveQty||!Array.isArray(m.concurrent)||m.concurrent.length<1||m.concurrent.length>1000)throw Error('SHARED_RECEIPT_MISMATCH');
 const applied=integer(m.appliedBefore),pending=(proof.pending as Obj[]).reduce((n,p)=>n+integer(p.delta,true),BigInt(0));if(integer(proof.remoteBaseQty)+pending!==quoted||applied>BigInt(2147483647))throw Error('SHARED_RECEIPT_MISMATCH');
 const own=new Set((proof.pending as Obj[]).map(p=>p.effectId)),seen=new Set<string>();let total=quoted,last=integer(proof.remoteSequence);const end=integer(sequence);
 for(const raw of m.concurrent){const e=raw as Obj,op=String(e.operationId),eid=String(e.effectId),seq=integer(e.remoteSequence),delta=integer(e.delta,true);if(!id.test(op)||eid!==sharedEffectId(op,'stock/'+row.productId)||own.has(eid)||seen.has(eid)||seq<=last||seq>=end||!allowed.has(String(e.kind))||delta<BigInt(-2147483648)||delta>BigInt(2147483647))throw Error('SHARED_RECEIPT_MISMATCH');seen.add(eid);last=seq;total+=delta}
 if(total!==applied)throw Error('SHARED_RECEIPT_MISMATCH');return applied;
}
