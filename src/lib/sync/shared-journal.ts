import type {VentaRDDatabase} from '@/lib/db/dexie';
import {sha256Hex} from './inventory/canonical-payload';
import {markSharedProjection} from './shared-capture';
import {sharedEffectId} from './shared-effects';
import {sharedStockBefore} from './shared-stock-merge';
export class SharedRemoteError extends Error{constructor(readonly code:'SHARED_AUTH_REQUIRED'|'SHARED_REMOTE_CONFLICT'|'SHARED_TRANSPORT_UNCERTAIN'){super(code)}}

export interface SharedContext {tenantId:string;actorId:string;installationId:string;deviceId:string;writerEpoch:string;scopeType:'GLOBAL'|'BRANCH';branchId:string|null;permissionGrantId:string}
export interface SharedWire {intent:string;intentHash:string;snapshot:string|null;snapshotHash:string|null}
export interface SharedOutbox {id:string;scopeKey:string;operationId:string;order:number;context:SharedContext;wire:SharedWire;state:'PENDING'|'UNCERTAIN'|'APPLIED'|'BLOCKED';receipt?:Record<string,unknown>;lastCode?:string;sourceOrder?:number;sourceMutationId?:string;sourcePart?:number}
export interface SharedState {id:string;cursor:string;nextOrder:number;leaseOwner?:string;leaseUntil?:number;activatedAt?:string;context?:SharedContext;bootstrap?:Record<string,unknown>;serviceCounters?:Partial<Record<'REPAIR'|'LAYAWAY',number>>;activeTurnId?:string|null;identity?:{installationId:string;deviceId:string;registrationId:string};code?:string}
export interface SharedEvent {intent:string;snapshot:string|null;receipt:Record<string,unknown>}
export interface SharedInbox {id:string;scopeKey:string;operationId:string;sequence:string;eventHash:string;event:SharedEvent}
export interface SharedRemote {lookup:(context:SharedContext,operationId:string,hash:string)=>Promise<unknown>;submit:(context:SharedContext,wire:SharedWire)=>Promise<unknown>}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const kinds=new Set(['SALE_CONFIRM','SALE_RETURN','CREDIT_PAYMENT','TURN_OPEN','CUT_X','TURN_CLOSE','EXPENSE_RECORD','CASH_ENTRY','INVENTORY_DELTA','INVENTORY_COUNT','PRODUCT_CREATE','PRODUCT_PATCH','PRODUCT_DELETE','CUSTOMER_CREATE','CUSTOMER_PATCH','CUSTOMER_DELETE','REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE','SERVICE_REFUND','LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL','CONFIG_PATCH','WARRANTY_PATCH']);
function fail(code='SHARED_RESPONSE_INVALID'):never{throw Error(code)}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail();return value as Record<string,unknown>}
function decimal(value:unknown):bigint{if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(value)||BigInt(value)>BigInt(Number.MAX_SAFE_INTEGER))fail();return BigInt(value)}
export function canonicalNative(value:unknown,depth=0):string{
 if(depth>64)fail('SHARED_CANON_INVALID');
 if(value===null||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<0)fail('SHARED_CANON_INVALID');return String(value)}
 if(typeof value==='string'){
  for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))fail('SHARED_CANON_INVALID')}else if(c>=0xdc00&&c<=0xdfff)fail('SHARED_CANON_INVALID')}
  return JSON.stringify(value);
 }
 if(Array.isArray(value))return '['+value.map(v=>canonicalNative(v,depth+1)).join(',')+']';
 const record=object(value);return '{'+Object.keys(record).sort().map(k=>{if(/[^\x00-\x7f]/.test(k))fail('SHARED_CANON_INVALID');return JSON.stringify(k)+':'+canonicalNative(record[k],depth+1)}).join(',')+'}';
}
export function sharedContextKey(c:SharedContext):string{
 if(![c.tenantId,c.actorId,c.installationId,c.deviceId,c.permissionGrantId].every(id=>uuid.test(id))||decimal(c.writerEpoch)===BigInt(0)||!['GLOBAL','BRANCH'].includes(c.scopeType)||(c.scopeType==='GLOBAL'?c.branchId!==null:typeof c.branchId!=='string'||!uuid.test(c.branchId)))fail('SHARED_CONTEXT_INVALID');
 // Renewal of a grant does not create another journal, cursor or writer identity.
 return [c.tenantId,c.actorId,c.installationId,c.deviceId,c.writerEpoch,c.scopeType,c.branchId??'GLOBAL'].join('/');
}
function parseIntent(w:SharedWire):Record<string,unknown>{
 if(typeof w.intent!=='string'||new TextEncoder().encode(w.intent).length>1048576||sha256Hex(w.intent)!==w.intentHash)fail('SHARED_WIRE_INVALID');
 const v=object(JSON.parse(w.intent));if(canonicalNative(v)!==w.intent||v.protocol!=='ventard.native.v1'||v.canonicalizationVersion!=='C-N1'||v.contractVersion!==1||!uuid.test(String(v.operationId))||!kinds.has(String(v.kind)))fail('SHARED_WIRE_INVALID');
 if(w.snapshot===null){if(w.snapshotHash!==null)fail('SHARED_WIRE_INVALID')}else{
  if(typeof w.snapshot!=='string'||new TextEncoder().encode(w.snapshot).length>1048576||sha256Hex(w.snapshot)!==w.snapshotHash)fail('SHARED_WIRE_INVALID');
  const s=object(JSON.parse(w.snapshot));if(canonicalNative(s)!==w.snapshot||s.operationId!==v.operationId||s.tenantId!==v.negocioId||s.actorId!==v.actorId)fail('SHARED_WIRE_INVALID');
 }
 return v;
}
function belongs(v:Record<string,unknown>,c:SharedContext){return v.negocioId===c.tenantId&&v.actorId===c.actorId&&v.installationId===c.installationId&&v.originDeviceId===c.deviceId&&v.writerEpoch===c.writerEpoch&&v.permissionGrantId===c.permissionGrantId&&canonicalNative(v.scope)===canonicalNative({type:c.scopeType,sucursalId:c.branchId})}
function receiptFor(value:unknown,w:SharedWire,c:SharedContext,own=true):Record<string,unknown>{
 const r=object(value),v=parseIntent(w);
 if(v.negocioId!==c.tenantId||canonicalNative(v.scope)!==canonicalNative({type:c.scopeType,sucursalId:c.branchId})||r.protocol!=='ventard.native.receipt.1'||r.namespace!=='NATIVE1'||r.status!=='APPLIED'||r.tenantId!==c.tenantId||r.operationId!==v.operationId||r.actorId!==v.actorId||r.deviceId!==v.originDeviceId||r.installationId!==v.installationId||r.writerEpoch!==v.writerEpoch||r.intentHash!==w.intentHash||r.snapshotHash!==w.snapshotHash||canonicalNative(r.scope)!==canonicalNative({type:c.scopeType,branchId:c.branchId})||decimal(r.remoteSequence)===BigInt(0)||own&&!belongs(v,c))fail('SHARED_RECEIPT_MISMATCH');
 if(w.snapshot!==null){const s=object(JSON.parse(w.snapshot));if(r.ticket!==s.ticket||r.ncf!==s.ncf||s.version!=='ventard.ticket.snapshot.1'||canonicalNative(s.sale)!==canonicalNative(object(v.payload).sale)||s.originAtUtcMs!==v.originAtUtcMs||canonicalNative(s.scope)!==canonicalNative(r.scope)||r.totalCents!==object(object(object(v.payload).sale).totals).totalCents)fail('SHARED_RECEIPT_MISMATCH')}
 validateEffects(v,r);
 return r;
}
/** Verify exact effects and absolute resulting stock before acknowledging or
 * exposing a receipt. Identity/hash matching alone is insufficient. */
function validateEffects(v:Record<string,unknown>,r:Record<string,unknown>){
 const op=String(v.operationId),kind=String(v.kind),p=object(v.payload),d=p.document?object(p.document):{},effects:Record<string,unknown>[]=[],stock:{productId:string;after:string}[]=[];
 const add=(part:string,type:string,payload:unknown)=>effects.push({id:sharedEffectId(op,part),kind:type,payload});
 const stockEffect=(pid:string,delta:unknown,before:unknown)=>{if(typeof delta!=='string'||!(/^-?(0|[1-9][0-9]{0,15})$/).test(delta))fail('SHARED_RECEIPT_MISMATCH');const after=decimal(before)+BigInt(delta);if(after<BigInt(0)||after>BigInt(2147483647))fail('SHARED_RECEIPT_MISMATCH');add('stock/'+pid,'STOCK',{productId:pid,delta});stock.push({productId:pid,after:after.toString()})};
 if(kind==='TURN_OPEN')effects.push({id:op,kind,amountCents:p.openingCents});
 else if(kind==='SALE_CONFIRM'){const sale=object(p.sale);for(const [index,line]of(sale.lines as unknown[]).entries())add('line/'+index,'LINE',line);for(const raw of sale.inventory as unknown[]){const item=object(raw),pid=String(item.productId),proof=(sale.stockEvidence as unknown[]).map(object).find(p=>p.productId===pid);if(!proof)fail('SHARED_RECEIPT_MISMATCH');stockEffect(pid,item.delta,proof.effectiveQty)}const pay=object(sale.payment);add('payment','PAYMENT',pay);if(pay.method==='FIADO')add('credit','CREDIT',{customerId:pay.customerId,amountCents:pay.creditChargeCents});if(['EFECTIVO','MIXTO'].includes(String(pay.method)))add('cash','CASH',{turnId:pay.turnId,amountCents:pay.cashNetCents});for(const raw of sale.serials as unknown[]??[]){const s=object(raw);add('serial/'+s.text,'SERIAL',s)}if(sale.fiscal!==null)add('fiscal','FISCAL',sale.fiscal);
 }else{
  add('management',kind,d);
  if(kind==='PRODUCT_CREATE')stockEffect(String(object(d.product).id),'0','0');
  else if(['INVENTORY_DELTA','INVENTORY_COUNT'].includes(kind))stockEffect(String(d.productId),d.delta,d.before);
  else for(const raw of d.stock as unknown[]??[]){const item=object(raw);stockEffect(String(item.productId),item.delta,item.before)}
  for(const raw of (kind.startsWith('LAYAWAY_')?d.serials:d.serialChanges) as unknown[]??[]){const serial=object(raw);add('serial/'+serial.text,'SERIAL',serial)}
 }
 const sorted=(items:Record<string,unknown>[])=>items.sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 if(!Array.isArray(r.effects)||r.effects.length!==effects.length||canonicalNative(sorted(r.effects.map(object)))!==canonicalNative(sorted(effects))||!Array.isArray(r.stock)||r.stock.length!==stock.length)fail('SHARED_RECEIPT_MISMATCH');
 const seen=new Set<string>();for(const raw of r.stock){const row=object(raw),pid=String(row.productId);let after=stock.find(x=>x.productId===pid)?.after;if(row.merge!==undefined){if(kind!=='SALE_CONFIRM')fail('SHARED_RECEIPT_MISMATCH');const sale=object(p.sale),proof=(sale.stockEvidence as unknown[]).map(object).find(p=>p.productId===pid),delta=(sale.inventory as unknown[]).map(object).find(p=>p.productId===pid);if(!proof||!delta)fail('SHARED_RECEIPT_MISMATCH');after=(sharedStockBefore(row,proof,r.remoteSequence)+BigInt(String(delta.delta))).toString()}if(seen.has(pid)||row.version!==r.remoteSequence||after!==row.after)fail('SHARED_RECEIPT_MISMATCH');seen.add(pid)}
}
export async function freezeSharedOperation(db:VentaRDDatabase,context:SharedContext,wire:SharedWire):Promise<SharedOutbox>{
 const c=structuredClone(context),w=structuredClone(wire),scopeKey=sharedContextKey(c),v=parseIntent(w);
 if(!belongs(v,c))fail('SHARED_CONTEXT_MISMATCH');
 const operationId=String(v.operationId),id=scopeKey+'/'+operationId;
 return db.transaction('rw',db.shared_outbox,db.shared_state,async()=>{
  const old=await db.shared_outbox.get(id);if(old){if(canonicalNative(old.wire)!==canonicalNative(w))fail('SHARED_OPERATION_ID_CONFLICT');return old}
  const state=await db.shared_state.get(scopeKey)??{id:scopeKey,cursor:'0',nextOrder:0};
  if(!Number.isSafeInteger(state.nextOrder+1))fail('SHARED_ORDER_INVALID');state.nextOrder++;
  const row:SharedOutbox={id,scopeKey,operationId,order:state.nextOrder,context:c,wire:w,state:'PENDING'};
  await db.shared_state.put(state);await db.shared_outbox.add(row);return row;
 });
}
export async function flushSharedOperations(db:VentaRDDatabase,c:SharedContext,remote:SharedRemote):Promise<void>{
 const key=sharedContextKey(c),owner=crypto.randomUUID();
 const leased=await db.transaction('rw',db.shared_state,async()=>{const s=await db.shared_state.get(key);if(!s||s.leaseOwner&&(s.leaseUntil??0)>Date.now())return false;await db.shared_state.update(key,{leaseOwner:owner,leaseUntil:Date.now()+90000});return true});
 if(!leased)return;
 try{
  const rows=(await db.shared_outbox.where('scopeKey').equals(key).toArray()).filter(r=>r.state!=='APPLIED').sort((a,b)=>a.order-b.order);
  for(const row of rows.slice(0,20)){
   if(row.state==='BLOCKED')break;
   const stillOwned=await db.transaction('rw',db.shared_state,async()=>{if((await db.shared_state.get(key))?.leaseOwner!==owner)return false;await db.shared_state.update(key,{leaseUntil:Date.now()+90000});return true});if(!stillOwned)return;
   try{
    const found=object(await remote.lookup(row.context,row.operationId,row.wire.intentHash));let result:unknown=found;
    if(found.status==='NOT_FOUND'){
     if(found.operationId!==row.operationId||found.intentHash!==row.wire.intentHash)fail('SHARED_RECEIPT_MISMATCH');
     // Persist uncertainty BEFORE HTTP; a lost response must be looked up with
     // the original actor, operation and exact bytes after any restart.
     await db.shared_outbox.update(row.id,{state:'UNCERTAIN'});
     result=await remote.submit(row.context,structuredClone(row.wire));
    }
    const receipt=receiptFor(result,row.wire,row.context);
    await db.shared_outbox.update(row.id,{state:'APPLIED',receipt,lastCode:undefined});
   }catch(error){
    const code=error instanceof SharedRemoteError?error.code:error instanceof Error&&/^SHARED_(RECEIPT_MISMATCH|WIRE_INVALID|RESPONSE_INVALID)$/.test(error.message)?error.message:'SHARED_TRANSPORT_UNCERTAIN';
    await db.shared_outbox.update(row.id,{state:['SHARED_TRANSPORT_UNCERTAIN','SHARED_AUTH_REQUIRED'].includes(code)?'UNCERTAIN':'BLOCKED',lastCode:code});break;
   }
  }
 }finally{await db.transaction('rw',db.shared_state,async()=>{if((await db.shared_state.get(key))?.leaseOwner===owner)await db.shared_state.update(key,{leaseOwner:undefined,leaseUntil:undefined})})}
}
export function validateSharedEvent(c:SharedContext,raw:unknown,through?:unknown):SharedEvent{
 const e=object(raw);if(typeof e.intent!=='string'||!(e.snapshot===null||typeof e.snapshot==='string'))fail('SHARED_PAGE_INVALID');const r=object(e.receipt);
 const w={intent:e.intent,intentHash:String(r.intentHash),snapshot:e.snapshot,snapshotHash:r.snapshotHash as string|null};receiptFor(r,w,c,false);
 if(through!==undefined&&decimal(r.remoteSequence)>decimal(through))fail('SHARED_PAGE_INVALID');
 return{intent:e.intent,snapshot:e.snapshot,receipt:r};
}
export async function receiveSharedPage(db:VentaRDDatabase,c:SharedContext,after:string,value:unknown,project?: (event:SharedEvent)=>Promise<void>):Promise<void>{
 const key=sharedContextKey(c),p=object(value),scope={type:c.scopeType,branchId:c.branchId};
 if(p.namespace!=='NATIVE1'||p.tenantId!==c.tenantId||p.coverage!=='COMPLETE'||canonicalNative(p.scope)!==canonicalNative(scope)||!Array.isArray(p.events)||p.events.length>200||decimal(p.scannedThrough)<decimal(after)||decimal(p.watermark)<decimal(p.scannedThrough)||new TextEncoder().encode(JSON.stringify(p)).length>33554432)fail('SHARED_PAGE_INVALID');
 const events:SharedInbox[]=[];let last=BigInt(-1);
 for(const raw of p.events){const e=validateSharedEvent(c,raw,p.scannedThrough),r=e.receipt;
  const sequence=String(r.remoteSequence);if(decimal(sequence)<=last||decimal(sequence)>decimal(p.scannedThrough))fail('SHARED_PAGE_INVALID');last=decimal(sequence);
  const event={intent:e.intent,snapshot:e.snapshot,receipt:r};events.push({id:key+'/'+sequence,scopeKey:key,operationId:String(r.operationId),sequence,eventHash:sha256Hex(canonicalNative(event)),event});
 }
 // The projection callback uses this same Dexie transaction. Cursor, inbox and
 // visible rows either all commit, or all remain available to retry from server.
 await db.transaction('rw',db.tables,async()=>{
  markSharedProjection();
  const state=await db.shared_state.get(key)??{id:key,cursor:'0',nextOrder:0};if(state.cursor!==after)fail('SHARED_CURSOR_CHANGED');
  for(const row of events){const old=await db.shared_inbox.get(row.id);if(old){if(old.eventHash!==row.eventHash)fail('SHARED_EVENT_CONFLICT');continue}
   if(decimal(row.sequence)<=decimal(after)||await db.shared_inbox.where('[scopeKey+operationId]').equals([key,row.operationId]).first())fail('SHARED_EVENT_CONFLICT');
   if(project)await project(structuredClone(row.event));await db.shared_inbox.add(row);
   const pending=await db.shared_outbox.get(key+'/'+row.operationId);if(pending){receiptFor(row.event.receipt,pending.wire,pending.context);if(pending.wire.intent!==row.event.intent||pending.wire.snapshot!==row.event.snapshot)fail('SHARED_EVENT_CONFLICT');await db.shared_outbox.update(pending.id,{state:'APPLIED',receipt:row.event.receipt})}
  }
  const projected=await db.shared_state.get(key)??state;projected.cursor=String(p.scannedThrough);await db.shared_state.put(projected);
 });
}
