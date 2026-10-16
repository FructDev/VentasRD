import type {VentaRDDatabase} from '@/lib/db/dexie';
import {canonicalNative,sharedContextKey,validateSharedEvent,type SharedContext,type SharedEvent} from './shared-journal';
import {sha256Hex} from './inventory/canonical-payload';
import {markSharedProjection} from './shared-capture';
import {warrantyFromSale,warrantyRevision} from './shared-warranty';
export interface SharedEntity {id:string;scopeKey:string;kind:string;entityId:string;sequence:string;value:Record<string,unknown>;business?:unknown}
export interface SharedCapture {id:string;scopeKey:string;manifest:Record<string,unknown>;pages:Record<string,string>;state:'STAGING'|'ACTIVE'|'EXPIRED';history?:Record<string,unknown>;prior?:Record<string,unknown[]>}
interface BootstrapRemote {bootstrap:(c:SharedContext,id:string)=>Promise<unknown>;page:(c:SharedContext,id:string,index:number)=>Promise<unknown>;resolutionHistory?:(c:SharedContext,id:string)=>Promise<unknown>}
function invalid():never{throw Error('SHARED_BOOTSTRAP_INVALID')}
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))invalid();return v as Record<string,unknown>}
function count(v:unknown):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)invalid();return v}
function decimal(v:unknown):bigint{if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(v)||BigInt(v)>BigInt(Number.MAX_SAFE_INTEGER))invalid();return BigInt(v)}
export const sharedEntityKey=(c:SharedContext,kind:string,id:string)=>sharedContextKey(c)+'/'+kind+'/'+id;
function validateManifest(c:SharedContext,v:unknown){
 const m=object(v);if(m.version!=='ventard.native.operational.1'||m.namespace!=='NATIVE1'||canonicalNative(m.context)!==canonicalNative({tenantId:c.tenantId,actorId:c.actorId,deviceId:c.deviceId,installationId:c.installationId,writerEpoch:c.writerEpoch,scopeType:c.scopeType,branchId:c.branchId})||!Array.isArray(m.pages)||m.pages.length>2048||count(m.totalCount)>60000||typeof m.snapshotId!=='string'||decimal(m.expiresAtMs)<=BigInt(Date.now())||decimal(m.watermark)<BigInt(0))invalid();
 let total=0,bytes=0;for(let index=0;index<m.pages.length;index++){const p=object(m.pages[index]);if(p.index!==index||count(p.count)>1000||count(p.byteLength)>1048576||typeof p.sha256!=='string'||!(/^[a-f0-9]{64}$/).test(p.sha256))invalid();total+=count(p.count);bytes+=count(p.byteLength)}
 if(total!==m.totalCount||bytes>33554432)invalid();return m;
}
export async function storeSharedEntity(db:VentaRDDatabase,c:SharedContext,kind:string,id:string,value:Record<string,unknown>,sequence:string,business?:unknown){
 if(!/^[A-Z_]{1,40}$/.test(kind)||!id||id.length>512)invalid();decimal(sequence);
 const key=sharedEntityKey(c,kind,id),old=await db.shared_entities.get(key);
 if(old&&decimal(old.sequence)>decimal(sequence))throw Error('SHARED_ENTITY_REGRESSION');
 await db.shared_entities.put({...old,id:key,scopeKey:sharedContextKey(c),kind,entityId:id,sequence,value:structuredClone(value),...(business!==undefined?{business:structuredClone(business)}:{})});
}
export async function downloadSharedBootstrap(db:VentaRDDatabase,c:SharedContext,remote:BootstrapRemote,project?: (row:Record<string,unknown>)=>Promise<void>,activate?:()=>Promise<void>):Promise<Record<string,unknown>>{
 const key=sharedContextKey(c);
 let capture=(await db.shared_captures.where('scopeKey').equals(key).toArray()).find(x=>x.state==='STAGING');
 if(capture&&decimal(capture.manifest.expiresAtMs)<=BigInt(Date.now())){await db.shared_captures.update(capture.id,{state:'EXPIRED'});capture=undefined}
 if(!capture){const manifest=validateManifest(c,await remote.bootstrap(c,crypto.randomUUID()));capture={id:key+'/'+manifest.snapshotId,scopeKey:key,manifest,pages:{},state:'STAGING'};await db.shared_captures.add(capture)}
 const manifest=validateManifest(c,capture.manifest),descriptors=manifest.pages as Record<string,unknown>[];
 if(manifest.legacyResolutionHistory&&!capture.history){
  const meta=object(manifest.legacyResolutionHistory);if(!remote.resolutionHistory)throw Error('SHARED_HISTORY_REQUIRED');
  const history=object(await remote.resolutionHistory(c,String(meta.cutoverId))),body=object(history.history),receipt=object(history.receipt),context=object(receipt.context);
  if(history.protocol!=='ventard.web.resolution.history.envelope.1'||canonicalNative(history.context)!==canonicalNative(c)||body.protocol!=='ventard.web.resolution.history.1'||history.historyHash!==meta.sha256||sha256Hex(canonicalNative(body))!==meta.sha256||receipt.cutoverId!==meta.cutoverId||receipt.status!=='BASELINE_ADOPTED'||context.tenantId!==c.tenantId||context.scopeType!==c.scopeType||context.branchId!==c.branchId)invalid();
  capture.history=history;await db.shared_captures.update(capture.id,{history});
 }
 for(const p of descriptors){const index=String(p.index);if(capture.pages[index]!==undefined)continue;
  const response=object(await remote.page(c,String(manifest.snapshotId),Number(p.index)));
  if(response.snapshotId!==manifest.snapshotId||response.index!==p.index||typeof response.payload!=='string'||sha256Hex(response.payload)!==p.sha256||new TextEncoder().encode(response.payload).length!==p.byteLength)invalid();
  const rows:unknown=JSON.parse(response.payload);if(!Array.isArray(rows)||rows.length!==p.count)invalid();
  await db.transaction('rw',db.shared_captures,async()=>{const current=await db.shared_captures.get(capture!.id);if(!current||current.state!=='STAGING'||canonicalNative(current.manifest)!==canonicalNative(manifest))invalid();if(current.pages[index]!==undefined&&current.pages[index]!==response.payload)invalid();current.pages[index]=String(response.payload);await db.shared_captures.put(current)});
  capture.pages[index]=response.payload;
 }
 const rows:Record<string,unknown>[]=[];for(const descriptor of descriptors){const payload=capture.pages[String(descriptor.index)];if(typeof payload!=='string'||sha256Hex(payload)!==descriptor.sha256)invalid();rows.push(...(JSON.parse(payload) as unknown[]).map(object))}
 await db.transaction('rw',db.tables,async()=>{
  markSharedProjection();
  const state=await db.shared_state.get(key)??{id:key,cursor:'0',nextOrder:0};
  if(state.activatedAt!==undefined||await db.shared_outbox.where('scopeKey').equals(key).count())throw Error('SHARED_BOOTSTRAP_ALREADY_OPERATIONAL');
  await db.shared_entities.where('scopeKey').equals(key).delete();const seen=new Set<string>();
  if(capture!.history){const meta=object(manifest.legacyResolutionHistory);await storeSharedEntity(db,c,'LEGACY_HISTORY',String(meta.cutoverId),capture!.history,String(manifest.watermark));if(project)await project({kind:'LEGACY_HISTORY',envelope:capture!.history})}
  for(const raw of manifest.legacyServices as unknown[]??[]){const envelope=object(raw),receipt=object(envelope.receipt),document=object(envelope.document),kind=envelope.table==='reparaciones'?'REPAIR':envelope.table==='apartados'?'LAYAWAY':null;
   if(!kind||receipt.protocol!=='ventard.service.baseline.receipt.1'||receipt.status!=='BASELINE_ADOPTED'||receipt.legacyReplay!==false||receipt.tenantId!==c.tenantId||canonicalNative(receipt.scope)!==canonicalNative({type:c.scopeType,branchId:c.branchId})||receipt.documentHash!==sha256Hex(canonicalNative(document)))invalid();
   await storeSharedEntity(db,c,kind,String(document.id),document,String(manifest.watermark),null);if(project)await project({kind,id:document.id,document,business:null,legacyBaseline:envelope});
  }
  for(const row of rows){const kind=String(row.kind),id=kind==='SERIAL'?String(row.productId)+'/'+String(row.text):String(row.id);
   if(seen.has(kind+'/'+id))invalid();seen.add(kind+'/'+id);
   if(kind==='REPAIR'||kind==='LAYAWAY'){const event=validateSharedEvent(c,row.event,manifest.watermark),intent=object(JSON.parse(event.intent)),document=object(object(intent.payload).document),service=object(document[kind==='REPAIR'?'repair':'layaway']);if(service.id!==row.id)invalid();await storeSharedEntity(db,c,kind,id,service,String(manifest.watermark),document.business??null)}
   else await storeSharedEntity(db,c,kind,id,row,String(manifest.watermark));
   if(kind==='HISTORY_EVENT'){const event=validateSharedEvent(c,row.event,manifest.watermark),intent=object(JSON.parse(event.intent));if(intent.operationId!==id)invalid();await storeSharedEntity(db,c,'EVENT',id,{kind:intent.kind,event},String(object(event.receipt).remoteSequence));if(intent.kind==='SALE_CONFIRM'&&typeof event.snapshot==='string')await storeSharedEntity(db,c,'SALE',id,object(JSON.parse(event.snapshot)),String(object(event.receipt).remoteSequence))}
   if(project)await project(row);
  }
  await storeSharedEntity(db,c,'MANIFEST',String(manifest.snapshotId),manifest,String(manifest.watermark));
  if(manifest.turn){const event=validateSharedEvent(c,manifest.turn,manifest.watermark),v=object(JSON.parse(event.intent)),payload=object(v.payload);if(v.kind!=='TURN_OPEN')invalid();await storeSharedEntity(db,c,'TURN',String(v.operationId),{id:v.operationId,status:'OPEN',openingCents:payload.openingCents,openedAtMs:v.originAtUtcMs,actorId:v.actorId},String(manifest.watermark))}
  await storeSharedPageMetadata(db,c,manifest,String(manifest.watermark));
  state.cursor=String(manifest.watermark);state.activatedAt=String(manifest.capturedAtMs);state.context=structuredClone(c);state.bootstrap=structuredClone(manifest);state.activeTurnId=manifest.turn?String(object(JSON.parse(String(object(manifest.turn).intent))).operationId):null;await db.shared_state.put(state);
  if(activate)await activate();
  await db.shared_captures.update(capture!.id,{state:'ACTIVE'});
 });return manifest;
}
/** Absolute scoped cash base and current brand, never replayed as cash entries. */
export async function storeSharedPageMetadata(db:VentaRDDatabase,c:SharedContext,page:Record<string,unknown>,sequence:string){
 if(page.business!==undefined)await storeSharedEntity(db,c,'BUSINESS','current',object(page.business),sequence);
 if(page.cashBase!==undefined&&page.cashBase!==null){const cash=object(page.cashBase);if(cash.tenantId!==c.tenantId||canonicalNative(cash.scope)!==canonicalNative({type:c.scopeType,branchId:c.branchId})||decimal(cash.sequence)>decimal(sequence)||typeof cash.netCents!=='string'||!(/^-?(0|[1-9][0-9]{0,15})$/).test(cash.netCents)||typeof cash.turnId!=='string')invalid();await storeSharedEntity(db,c,'CASH_BASE',cash.turnId,cash,sequence)}
}
export async function projectSharedEntities(db:VentaRDDatabase,c:SharedContext,event:SharedEvent,sequence=String(event.receipt.remoteSequence)){
 const v=object(JSON.parse(event.intent)),payload=object(v.payload),doc=payload.document?object(payload.document):{},op=String(v.operationId),kind=String(v.kind);
 const prior=await db.shared_entities.get(sharedEntityKey(c,'EVENT',op));if(prior){if(canonicalNative(prior.value.event)!==canonicalNative(event))throw Error('SHARED_EVENT_CONFLICT');return}
 await storeSharedEntity(db,c,'EVENT',op,{kind,event},sequence);
 if(doc.businessSettings&&doc.business)await storeSharedEntity(db,c,'BUSINESS','current',object(doc.business),sequence);
 if(doc.cataloguePublication)await storeSharedEntity(db,c,'CATALOGUE_PUBLICATION','current',object(doc.cataloguePublication),sequence);
 if(doc.warrantyDefault)await storeSharedEntity(db,c,'WARRANTY_DEFAULT','current',object(doc.warrantyDefault),sequence);
 for(const created of doc.products as unknown[]??[]){const product=object(object(object(created).document).product);await storeSharedEntity(db,c,'PRODUCT',String(product.id),{...product,stock:{quantity:'0',version:'0',authority:'VERIFIED'}},sequence)}
 for(const [field,type] of [['product','PRODUCT'],['customer','CUSTOMER'],['repair','REPAIR'],['layaway','LAYAWAY']] as const){if(doc[field]){const value=object(doc[field]),old=await db.shared_entities.get(sharedEntityKey(c,type,String(value.id))),merged={...old?.value,...value};if(type==='CUSTOMER'){merged.metadataRevision=value.revision;merged.revision=old?.value.revision??value.balanceRevision??'1';merged.balanceCents=value.balanceCents??old?.value.balanceCents??'0'}await storeSharedEntity(db,c,type,String(value.id),merged,sequence,type==='REPAIR'||type==='LAYAWAY'?doc.business??null:undefined)}}
 for(const raw of event.receipt.stock as unknown[]??[]){const stock=object(raw),key=sharedEntityKey(c,'PRODUCT',String(stock.productId)),old=await db.shared_entities.get(key);if(!old)throw Error('SHARED_PRODUCT_MISSING');const next=structuredClone(old.value);next.stock={quantity:stock.after,version:stock.version,authority:'VERIFIED'};await storeSharedEntity(db,c,'PRODUCT',String(stock.productId),next,sequence)}
 if(kind==='TURN_OPEN')await storeSharedEntity(db,c,'TURN',op,{id:op,status:'OPEN',openingCents:payload.openingCents,openedAtMs:v.originAtUtcMs,actorId:v.actorId},sequence);
 if(kind==='TURN_CLOSE'){const turnId=String(v.originalTurnId),old=await db.shared_entities.get(sharedEntityKey(c,'TURN',turnId));if(old)await storeSharedEntity(db,c,'TURN',turnId,{...old.value,status:'CLOSED',closedAtMs:v.originAtUtcMs},sequence)}
 if(kind==='TURN_OPEN'||kind==='TURN_CLOSE')await db.shared_state.update(sharedContextKey(c),{activeTurnId:kind==='TURN_OPEN'?op:null});
 if(kind==='SALE_CONFIRM'&&event.snapshot){const snapshot=object(JSON.parse(event.snapshot));await storeSharedEntity(db,c,'SALE',op,snapshot,sequence)}
 const serial=async(pid:string,text:string,patch:Record<string,unknown>)=>{const id=pid+'/'+text,old=await db.shared_entities.get(sharedEntityKey(c,'SERIAL',id));await storeSharedEntity(db,c,'SERIAL',id,{...old?.value,productId:pid,text,revision:old?.value.revision??'1',...patch},sequence)};
 if(kind==='SALE_CONFIRM'){const sale=object(payload.sale);for(const raw of sale.serials as unknown[]??[]){const s=object(raw),days=String(s.warrantyDays??'0');await serial(String(s.productId),String(s.text),{state:'SOLD',saleOperationId:op,soldAtMs:v.originAtUtcMs,warrantyDays:days,warrantyUntilMs:decimal(days)>BigInt(0)?(decimal(v.originAtUtcMs)+decimal(days)*BigInt(86400000)).toString():null,customerName:object(sale.customer??{}).name??null,warranty:warrantyFromSale(v,s)})}}
 if(doc.warranty){const warranty=warrantyRevision(object(doc.warranty));await serial(String(warranty.productId),String(warranty.serial),{warranty,warrantyDays:warranty.days,warrantyUntilMs:warranty.untilMs})}
 if(['INVENTORY_DELTA','INVENTORY_COUNT'].includes(kind)){
  const selected=new Set((doc.serials as string[])??[]),pid=String(doc.productId);
  if(doc.mode==='COUNT')for(const current of await db.shared_entities.where('[scopeKey+kind]').equals([sharedContextKey(c),'SERIAL']).toArray())if(current.value.productId===pid&&['AVAILABLE','LOST'].includes(String(current.value.state))&&!selected.has(String(current.value.text)))await serial(pid,String(current.value.text),{state:'LOST',saleOperationId:null});
  for(const text of selected)await serial(pid,text,{state:doc.mode==='LOSS'?'LOST':'AVAILABLE',saleOperationId:null});
 }
 if(kind.startsWith('LAYAWAY_'))for(const raw of doc.serials as unknown[]??[]){const s=object(raw);await serial(String(s.productId),String(s.text),{state:kind==='LAYAWAY_CANCEL'?'AVAILABLE':kind==='LAYAWAY_COMPLETE'?'SOLD':'RESERVED',saleOperationId:null,layawayId:object(doc.layaway).id})}
 if(kind==='SALE_RETURN')for(const raw of doc.serialProof as unknown[]??[]){const s=object(raw);await serial(String(s.productId),String(s.text),{state:'AVAILABLE',saleOperationId:null,soldAtMs:null,warrantyDays:'0',warrantyUntilMs:null,customerName:null})}
 let credit:unknown=doc.balanceAfterCents!==undefined?{customerId:doc.customerId,balanceCents:doc.balanceAfterCents,revision:doc.balanceRevision}:null;
 if(doc.credit){const change=object(doc.credit);credit={customerId:change.customerId,balanceCents:change.afterCents,revision:(decimal(change.expectedRevision)+BigInt(1)).toString()}}
 if(kind==='SALE_CONFIRM'){const pay=object(object(payload.sale).payment);if(pay.method==='FIADO'){const current=await db.shared_entities.get(sharedEntityKey(c,'CUSTOMER',String(pay.customerId)));if(!current)throw Error('SHARED_CUSTOMER_MISSING');credit={customerId:pay.customerId,balanceCents:(decimal(current.value.balanceCents)+decimal(pay.creditChargeCents)).toString(),revision:(decimal(current.value.revision)+BigInt(1)).toString()}}}
 if(credit){const current=object(credit),customerId=String(current.customerId),old=await db.shared_entities.get(sharedEntityKey(c,'CUSTOMER',customerId));if(!old)throw Error('SHARED_CUSTOMER_MISSING');await storeSharedEntity(db,c,'CUSTOMER',customerId,{...old.value,balanceCents:current.balanceCents,revision:current.revision},sequence)}
}
