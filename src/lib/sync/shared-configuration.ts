import type {VentaRDDatabase} from '@/lib/db/dexie';
import {getSharedCaptureContext,type SharedMutation} from './shared-capture';
import {sharedContextKey} from './shared-journal';
import {commandHash} from '@/lib/domain/local/command';
type Obj=Record<string,unknown>;
export async function queueSharedConfiguration(db:VentaRDDatabase,kind:'BUSINESS_SAVE'|'CATALOGUE_PUBLISH'|'WARRANTY_DEFAULT'|'SERVICE_REFUND',definition:Obj){
 const c=getSharedCaptureContext(db);if(!c)throw Error('SHARED_PREPARATION_REQUIRED');
 const key=sharedContextKey(c),change={table:'shared_configuration',key:kind,before:null,after:{kind,...structuredClone(definition)}},identity=(after:Obj)=>{const {at,...facts}=after;void at;return commandHash(facts)},hash=identity(change.after);
 return db.transaction('rw',db.shared_state,db.shared_mutations,db.shared_entities,async()=>{
  const state=await db.shared_state.get(key);if(!state?.activatedAt)throw Error('SHARED_PREPARATION_REQUIRED');
  const previous=await db.shared_mutations.where('scopeKey').equals(key).toArray(),duplicate=previous.find(row=>row.state!=='APPLIED'&&row.changes.length===1&&row.changes[0].table==='shared_configuration'&&row.changes[0].after&&identity(row.changes[0].after)===hash);if(duplicate)return duplicate.id;
  const facts:Obj={MANIFEST:structuredClone(state.bootstrap??{}),ACTIVE_TURN_ID:state.activeTurnId??null};if(kind==='SERVICE_REFUND'){const family=definition.family==='repair'?'REPAIR':'LAYAWAY',id=String(definition.serviceId);for(const name of [family,'SERVICE_REFUNDS']){const entity=await db.shared_entities.get(key+'/'+name+'/'+(name==='SERVICE_REFUNDS'?definition.family+'/':'')+id);facts[name+'/'+(name==='SERVICE_REFUNDS'?definition.family+'/':'')+id]=entity??null}}
  state.nextOrder++;if(!Number.isSafeInteger(state.nextOrder))throw Error('SHARED_ORDER_INVALID');const row:SharedMutation={id:crypto.randomUUID(),scopeKey:key,context:structuredClone(c),order:state.nextOrder,changes:[change],facts,sourceHash:commandHash({changes:[change],facts}),state:'CAPTURED'};await db.shared_state.put(state);await db.shared_mutations.add(row);return row.id;
 });
}
