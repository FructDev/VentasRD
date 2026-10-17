import {db} from '@/lib/db/dexie';
import {supabase} from '@/lib/supabase/client';
import {useConfigStore} from '@/store/useConfigStore';
import {setSharedCaptureContext,setSharedWriteGuard} from './shared-capture';
import {sharedRemote,sharedChannelEnabled} from './shared-remote';
import {restoreSharedBrowser,syncSharedBrowser,type SharedBrowserScope} from './shared-runtime';
import {sharedContextKey,type SharedContext} from './shared-journal';
import {hydrateSharedBrand} from './shared-brand';

let ready:Promise<SharedContext|null>=Promise.resolve(null),key='',generation=0;
export const sharedWebEnabled=(tenant:string)=>sharedChannelEnabled(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.NEXT_PUBLIC_VENTARD_SHARED_JOURNAL,tenant);
function current():SharedBrowserScope|null{const state=useConfigStore.getState(),actor=state.user?.id??state.usuarioCacheId;return state.negocioId&&actor?{tenantId:state.negocioId,actorId:actor,branchId:state.sucursalId??null}:null}
export function refreshSharedWorker(){
 const s=current(),next=s&&sharedWebEnabled(s.tenantId)?JSON.stringify(s):'';if(next===key)return;key=next;const own=++generation;
 setSharedCaptureContext(db,null);setSharedWriteGuard(db,next?'SHARED_PREPARING':null);
 ready=s&&next?restoreSharedBrowser(db,s,()=>own===generation,c=>hydrateSharedBrand(db,c,()=>own===generation)).catch(()=>{if(own===generation)setSharedWriteGuard(db,'SHARED_STORAGE_UNAVAILABLE');return null}):Promise.resolve(null);
}
/** True consumes the whole legacy worker cycle. No product/movement/fiado
 * table upload, legacy pull, retention or Realtime projection can run beside it. */
export async function runSharedWorkerCycle():Promise<boolean>{
 refreshSharedWorker();const s=current();if(!s||!sharedWebEnabled(s.tenantId))return false;
 const own=generation,c=await ready??await restoreSharedBrowser(db,s,()=>own===generation,c=>hydrateSharedBrand(db,c,()=>own===generation));if(own!==generation)return true;
 if(!c)return true;
 const remote=sharedRemote(supabase,process.env.NEXT_PUBLIC_SUPABASE_URL??'',s.tenantId);
 const live=()=>own===generation&&JSON.stringify(current())===JSON.stringify(s);
 try{await syncSharedBrowser(db,c,remote,live);await hydrateSharedBrand(db,c,live);if(live())await db.shared_state.update(sharedContextKey(c),{code:undefined})}
 catch(error){if(live()){const code=error instanceof Error&&/^SHARED_[A-Z_]+$/.test(error.message)?error.message:'SHARED_TRANSPORT_UNCERTAIN';await db.shared_state.update(sharedContextKey(c),{code});console.warn('[sync] '+code+': pendientes conservados')}}return true;
}
export function resetSharedWorker(){key='';generation++;ready=Promise.resolve(null);setSharedCaptureContext(db,null);const s=current();setSharedWriteGuard(db,s&&sharedWebEnabled(s.tenantId)?'SHARED_PREPARATION_REQUIRED':null)}
