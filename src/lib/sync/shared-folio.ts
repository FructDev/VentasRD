import type {VentaRDDatabase} from '@/lib/db/dexie';
import {getSharedCaptureContext} from './shared-capture';
import {sharedContextKey} from './shared-journal';
export async function reserveSharedFolio(db:VentaRDDatabase,tenantId:string,family:'REPAIR'|'LAYAWAY'):Promise<string|null>{
 const context=getSharedCaptureContext(db);if(!context||context.tenantId!==tenantId)return null;
 const key=sharedContextKey(context),prefix=(family==='REPAIR'?'REP-':'AP-')+'N'+context.installationId.replaceAll('-','');
 return db.transaction('rw',db.shared_state,db.shared_entities,async()=>{
  const state=await db.shared_state.get(key);if(!state?.activatedAt)throw Error('SHARED_PREPARATION_REQUIRED');
  const counters=state.serviceCounters??{};let last=counters[family];
  if(last===undefined){last=0;for(const row of await db.shared_entities.where('[scopeKey+kind]').equals([key,family]).toArray()){if(typeof row.value.folio==='string'&&row.value.folio.startsWith(prefix+'-'))last=Math.max(last,Number(row.value.folioNumber??0))}}
  if(!Number.isSafeInteger(last)||last>=2147483647)throw Error('SHARED_FOLIO_EXHAUSTED');last++;counters[family]=last;await db.shared_state.update(key,{serviceCounters:counters});return prefix+'-'+String(last).padStart(3,'0');
 });
}
