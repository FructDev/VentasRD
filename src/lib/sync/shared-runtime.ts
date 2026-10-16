import type {VentaRDDatabase} from '@/lib/db/dexie';
import {setSharedCaptureContext,setSharedWriteGuard,markSharedProjection} from './shared-capture';
import {sharedContextKey,canonicalNative,flushSharedOperations,receiveSharedPage,type SharedContext} from './shared-journal';
import {downloadSharedBootstrap,storeSharedEntity} from './shared-bootstrap';
import {prepareSharedMutation} from './shared-compile';
import {projectSharedWebEvent,projectSharedMetadata,reconcileSharedWeb} from './shared-projection';
import type {sharedRemote} from './shared-remote';
import {commandHash} from '@/lib/domain/local/command';

export interface SharedBrowserScope {tenantId:string;actorId:string;branchId:string|null}
type Remote=ReturnType<typeof sharedRemote>;
type Activate=(context:SharedContext)=>Promise<void>;
const activated:Activate=async()=>{};
const scopeKey=(s:SharedBrowserScope)=>'WEB/'+s.tenantId+'/'+(s.branchId??'GLOBAL');
const same=(c:SharedContext,s:SharedBrowserScope)=>c.tenantId===s.tenantId&&c.actorId===s.actorId&&c.branchId===s.branchId;
const tables=['productos','clientes','ventas','venta_detalles','transacciones_fiado','cajas','cortes_caja','seriales','devoluciones','gastos','reparaciones','apartados','movimientos_stock'] as const;
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('SHARED_RESPONSE_INVALID');return v as Record<string,unknown>};

async function legacyPending(db:VentaRDDatabase,s:SharedBrowserScope){
 for(const name of tables)if(await db.table(name).where('negocio_id').equals(s.tenantId).filter(row=>row.estado_sincronizacion===0).count())return true;
 return !!await db.operaciones_locales.where('negocio_id').equals(s.tenantId).filter(row=>row.estado_local==='PREPARED').count();
}
async function retainedCopy(db:VentaRDDatabase,s:SharedBrowserScope):Promise<Record<string,unknown[]>>{
 const prior:Record<string,unknown[]>={};for(const name of tables)prior[name]=await db.table(name).where('negocio_id').equals(s.tenantId).toArray();
 const products=new Set((prior.productos as {id:string}[]).map(p=>p.id));prior.composiciones=(await db.composiciones.toArray()).filter(p=>products.has(p.producto_padre_id));
 if(new TextEncoder().encode(JSON.stringify(prior)).length>33554432)throw Error('SHARED_LOCAL_COPY_TOO_LARGE');return prior;
}

/** Explicit preparation from the EXISTING settings page. Registration is a real
 * browser writer; pending legacy rows must be reconciled before this operation.
 * Identity is durable before HTTP, so a lost enrollment reply cannot clone it. */
export async function prepareSharedBrowser(db:VentaRDDatabase,s:SharedBrowserScope,remote:Remote,isCurrent:()=>boolean,onActivate:Activate=activated){
 const check=()=>{if(!isCurrent())throw Error('SHARED_SCOPE_CHANGED')};check();
 setSharedWriteGuard(db,'SHARED_PREPARING');
 if(await legacyPending(db,s))throw Error('SHARED_LEGACY_PENDING');
 if(await remote.mode(s.branchId)!=='SHARED_JOURNAL')throw Error('SHARED_BUSINESS_NOT_READY');check();
 const identityKey=scopeKey(s),identity=await db.transaction('rw',db.shared_state,async()=>{
  const row=await db.shared_state.get(identityKey)??{id:identityKey,cursor:'0',nextOrder:0};
  if(!row.identity){row.identity={installationId:crypto.randomUUID(),deviceId:crypto.randomUUID(),registrationId:crypto.randomUUID()};await db.shared_state.put(row)}return row.identity;
 });
 const response=object(await remote.enroll(identity.installationId,identity.deviceId,s.branchId,identity.registrationId));check();
 if(response.tenantId!==s.tenantId||response.actorId!==s.actorId||response.installationId!==identity.installationId||response.deviceId!==identity.deviceId||response.scopeType!==(s.branchId?'BRANCH':'GLOBAL')||response.branchId!==s.branchId||response.registrationId!==identity.registrationId)throw Error('SHARED_REGISTRATION_MISMATCH');
 const c:SharedContext={...s,installationId:identity.installationId,deviceId:identity.deviceId,writerEpoch:String(response.writerEpoch),scopeType:s.branchId?'BRANCH':'GLOBAL',permissionGrantId:identity.registrationId};sharedContextKey(c);
 if((await db.shared_state.get(sharedContextKey(c)))?.activatedAt){await onActivate(c);check();setSharedCaptureContext(db,c);setSharedWriteGuard(db,null);return c}
 const prior=await db.transaction('r',db.tables,()=>retainedCopy(db,s)),priorHash=commandHash(prior);
 await downloadSharedBootstrap(db,c,remote,undefined,async()=>{
  check();if(await legacyPending(db,s)||commandHash(await retainedCopy(db,s))!==priorHash)throw Error('SHARED_LOCAL_SOURCE_CHANGED');
  // Keep a complete original browser copy before changing any visible row.
  const captures=await db.shared_captures.where('scopeKey').equals(sharedContextKey(c)).toArray(),capture=captures.find(row=>row.state==='STAGING');if(!capture)throw Error('SHARED_CAPTURE_REQUIRED');await db.shared_captures.update(capture.id,{prior});
  await reconcileSharedWeb(db,c);
 });
 await onActivate(c);check();setSharedCaptureContext(db,c);setSharedWriteGuard(db,null);return c;
}

export async function restoreSharedBrowser(db:VentaRDDatabase,s:SharedBrowserScope,isCurrent:()=>boolean=()=>true,onActivate:Activate=activated){
 const states=await db.shared_state.toArray(),state=states.find(row=>row.activatedAt&&row.context&&same(row.context,s));
 const foreign=await db.shared_mutations.filter(row=>row.context.tenantId===s.tenantId&&row.context.branchId===s.branchId&&row.context.actorId!==s.actorId&&row.state!=='APPLIED').first();if(!isCurrent())return null;if(foreign){setSharedCaptureContext(db,null);setSharedWriteGuard(db,'SHARED_OTHER_ACTOR_PENDING');return null}
 if(!isCurrent())return null;const c=state?.context??null;if(c){setSharedWriteGuard(db,'SHARED_PREPARING');await onActivate(c);if(!isCurrent())return null}setSharedCaptureContext(db,c);setSharedWriteGuard(db,c?null:'SHARED_PREPARATION_REQUIRED');return c;
}

/** Called by the one existing web worker. An earlier unresolved source always
 * stops later sends; it cannot be bypassed by a separately uploaded stock row. */
export async function syncSharedBrowser(db:VentaRDDatabase,c:SharedContext,remote:Remote,isCurrent:()=>boolean){
 if(!isCurrent())throw Error('SHARED_SCOPE_CHANGED');
 const key=sharedContextKey(c),sources=(await db.shared_mutations.where('scopeKey').equals(key).toArray()).sort((a,b)=>a.order-b.order);
 for(const raw of sources){if(!isCurrent())throw Error('SHARED_SCOPE_CHANGED');if(raw.state==='BLOCKED')break;if(raw.state==='CAPTURED'){await prepareSharedMutation(db,raw.id,remote.planService);if((await db.shared_mutations.get(raw.id))?.state!=='PREPARED'&&(await db.shared_mutations.get(raw.id))?.state!=='APPLIED')break}}
 // Never send a later prepared group past an earlier captured/blocked source.
 const all=(await db.shared_mutations.where('scopeKey').equals(key).toArray()).sort((a,b)=>a.order-b.order),barrier=all.find(row=>row.state==='BLOCKED'||row.state==='CAPTURED');
 if(!barrier)await flushSharedOperations(db,c,remote);
 else await flushSharedOperations(db,c,{...remote,submit:async(context,wire)=>{const op=String(object(JSON.parse(wire.intent)).operationId),row=await db.shared_outbox.get(key+'/'+op);if((row?.sourceOrder??Number.MAX_SAFE_INTEGER)>=barrier.order)throw Error('SHARED_SOURCE_BARRIER');return remote.submit(context,wire)}});
 for(const raw of (await db.shared_mutations.where('scopeKey').equals(key).toArray()).sort((a,b)=>a.order-b.order)){
  if(!isCurrent())throw Error('SHARED_SCOPE_CHANGED');const privateChange=raw.private;if(!privateChange||privateChange.state==='APPLIED')continue;
  const v=object(JSON.parse(privateChange.intent)),financial=await db.shared_outbox.get(key+'/'+v.operationId);if(financial?.state!=='APPLIED')break;
  const receipt=object(await remote.privateSubmit(raw.context,privateChange.intent,privateChange.hash));if(receipt.protocol!=='ventard.repair.private.receipt.1'||receipt.operationId!==v.operationId||receipt.tenantId!==c.tenantId||canonicalNative(receipt.scope)!==canonicalNative({type:c.scopeType,branchId:c.branchId})||receipt.repairId!==v.repairId||receipt.intentHash!==privateChange.hash||!['APPLIED','SUPERSEDED'].includes(String(receipt.status)))throw Error('SHARED_PRIVATE_RECEIPT_MISMATCH');await db.shared_mutations.update(raw.id,{private:{...privateChange,state:'APPLIED',receipt}});
 }
 if(!isCurrent())throw Error('SHARED_SCOPE_CHANGED');
 const after=(await db.shared_state.get(key))?.cursor??'0',page=object(await remote.feed(c,after));
 if(!isCurrent())throw Error('SHARED_SCOPE_CHANGED');
 await db.transaction('rw',db.tables,async()=>{markSharedProjection();if(!isCurrent())throw Error('SHARED_SCOPE_CHANGED');await receiveSharedPage(db,c,after,page,event=>projectSharedWebEvent(db,c,event));await projectSharedMetadata(db,c,page);await reconcileSharedWeb(db,c)});
 if(await db.shared_entities.where('[scopeKey+kind]').equals([key,'REPAIR']).count()){
  const bundle=object(await remote.privateRead(c));if(!isCurrent())throw Error('SHARED_SCOPE_CHANGED');
  if(bundle.protocol!=='ventard.repair.private.view.1'||bundle.tenantId!==c.tenantId||canonicalNative(bundle.scope)!==canonicalNative({type:c.scopeType,branchId:c.branchId})||!Array.isArray(bundle.rows)||bundle.rows.length>10000||new TextEncoder().encode(JSON.stringify(bundle)).length>1048576)throw Error('SHARED_PRIVATE_RESPONSE_INVALID');
  await db.transaction('rw',db.tables,async()=>{markSharedProjection();const pending=await db.shared_mutations.where('scopeKey').equals(key).toArray(),seen=new Set<string>();for(const raw of bundle.rows as unknown[]){const row=object(raw),id=String(row.repairId),revision=String(row.repairRevision);if(seen.has(id)||typeof row.value!=='string'||row.value.length>256||!(/^[1-9][0-9]{0,9}$/).test(revision))throw Error('SHARED_PRIVATE_RESPONSE_INVALID');seen.add(id);const service=await db.shared_entities.get(key+'/REPAIR/'+id),local=await db.reparaciones.get(id);if(!service||!local||BigInt(String(service.value.revision))<BigInt(revision))continue;if(pending.some(raw=>raw.state!=='APPLIED'&&raw.changes.some(change=>change.table==='reparaciones'&&change.key===id)))continue;await storeSharedEntity(db,c,'PRIVATE_REPAIR',id,row,String(page.scannedThrough));await db.reparaciones.update(id,{patron_clave:row.value})}});
 }
}
