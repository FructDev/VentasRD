'use client';
import {useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {db} from '@/lib/db/dexie';
import {supabase} from '@/lib/supabase/client';
import {useConfigStore} from '@/store/useConfigStore';
import {sharedRemote,sharedChannelEnabled} from '@/lib/sync/shared-remote';
import {prepareSharedBrowser,syncSharedBrowser} from '@/lib/sync/shared-runtime';
import {sharedContextKey} from '@/lib/sync/shared-journal';
import {hydrateSharedBrand} from '@/lib/sync/shared-brand';
import {syncQuiescence} from '@/lib/sync/quiescence';

const messages:Record<string,string>={SHARED_OTHER_ACTOR_PENDING:'Hay cambios de otra cuenta en este navegador. Vuelve a esa cuenta y sincronízalos antes de continuar.',NATIVE_SHARED_UPGRADE_REQUIRED:'Actualiza VentaRD en los equipos del negocio para compartir el registro.',SHARED_LEGACY_PENDING:'Este navegador conserva cambios anteriores pendientes. Prepara su traslado cifrado y concílialos antes de conectar el registro compartido.',SHARED_BUSINESS_NOT_READY:'Primero completa y confirma el traslado del negocio desde la aplicación instalada.',SHARED_SCOPE_CHANGED:'La cuenta o la sucursal cambió. Abre de nuevo esta sección.',SHARED_AUTH_REQUIRED:'Renueva tu sesión online. Los datos y pendientes permanecen guardados.',SHARED_REMOTE_CONFLICT:'Hay una diferencia que requiere revisión. La operación original sigue guardada y no se ha creado otra.',SHARED_PREPARATION_REQUIRED:'Prepara este navegador para recibir los mismos datos que la aplicación.',SHARED_LOCAL_SOURCE_CHANGED:'Los datos locales cambiaron durante la preparación. Se conservó la copia anterior; vuelve a revisar el traslado.',SHARED_OPERATION_REVIEW_REQUIRED:'Hay una operación local que necesita revisión antes de sincronizar.',SHARED_TRANSPORT_UNCERTAIN:'No se pudo confirmar la conexión. Se consultará el mismo intento al reconectar, sin repetir sus efectos.'};
export default function SharedBusinessSync(){
 const tenant=useConfigStore(s=>s.negocioId),actor=useConfigStore(s=>s.user?.id??s.usuarioCacheId),branch=useConfigStore(s=>s.sucursalId??null);
 const enabled=!!tenant&&sharedChannelEnabled(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.NEXT_PUBLIC_VENTARD_SHARED_JOURNAL,tenant);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),gate=useRef(false);
 const scopeId=JSON.stringify([tenant,actor,branch]);
 const observed=useLiveQuery(async()=>{
  if(!enabled||!tenant||!actor)return null;
  const foreign=await db.shared_mutations.filter(r=>r.context.tenantId===tenant&&r.context.branchId===branch&&r.context.actorId!==actor&&r.state!=='APPLIED').count();
  const states=await db.shared_state.toArray(),state=states.find(row=>row.activatedAt&&row.context?.tenantId===tenant&&row.context.actorId===actor&&row.context.branchId===branch);
  if(!state?.context)return{scopeId,context:null,pending:0,blocked:0,cursor:'0',code:foreign?'SHARED_OTHER_ACTOR_PENDING':''};
  const key=sharedContextKey(state.context),raw=await db.shared_mutations.where('scopeKey').equals(key).toArray(),ops=await db.shared_outbox.where('scopeKey').equals(key).toArray();
  return{scopeId,context:state.context,cursor:state.cursor,pending:raw.filter(r=>r.state!=='APPLIED').length,blocked:raw.filter(r=>r.state==='BLOCKED'||ops.some(op=>op.sourceMutationId===r.id&&op.state==='BLOCKED')).length,code:foreign?'SHARED_OTHER_ACTOR_PENDING':state.code??raw.find(r=>r.code)?.code??ops.find(op=>op.lastCode)?.lastCode??''};
 },[enabled,tenant,actor,branch,scopeId]);
 const status=observed?.scopeId===scopeId?observed:null;
 async function run(){if(gate.current||!tenant||!actor)return;gate.current=true;setBusy(true);setError('');let release:(()=>void)|undefined;
  try{release=await syncQuiescence.acquire();const scope={tenantId:tenant,actorId:actor,branchId:branch},live=()=>{const s=useConfigStore.getState();return s.negocioId===tenant&&(s.user?.id??s.usuarioCacheId)===actor&&(s.sucursalId??null)===branch};
   const remote=sharedRemote(supabase,process.env.NEXT_PUBLIC_SUPABASE_URL??'',tenant),c=status?.context??await prepareSharedBrowser(db,scope,remote,live,ctx=>hydrateSharedBrand(db,ctx,live));await syncSharedBrowser(db,c,remote,live);await hydrateSharedBrand(db,c,live);
  }catch(e){setError(messages[e instanceof Error?e.message:'']??'No se pudo completar la sincronización. Conservamos los datos y el intento original.')}finally{release?.();gate.current=false;setBusy(false)}
 }
 if(!enabled)return null;
 return <section className="mt-6 bg-navy-2 rounded-2xl border border-navy-3 p-4 sm:p-8"><h3 className="text-lg font-bold text-gold mb-3">Web y aplicación · mismo negocio</h3><p className="text-sm text-vr-gray mb-4">Ambas versiones usan el mismo registro de operaciones. Este navegador conservará su identidad, sus pendientes y una copia anterior a la preparación. Disponible para los negocios autorizados de este piloto.</p>{status?.context?<p role="status" className="text-sm text-vr-gray mb-3">{status.pending===0?'Al día':`${status.pending} pendientes`} · {status.blocked} por revisar · Registro recibido: {status.cursor}</p>:<p className="text-sm text-vr-gray mb-3">Prepara primero el traslado del negocio. Los cambios anteriores de este navegador deben estar conciliados.</p>}<button type="button" disabled={busy||!actor} onClick={()=>void run()} className="px-4 py-3 bg-gold text-navy font-bold rounded-xl text-sm disabled:opacity-40">{busy?'Conectando…':status?.context?'Sincronizar ahora':'Preparar este navegador'}</button>{(error||status?.code)&&<p role="alert" className="mt-3 text-sm text-vr-red">{error||messages[status?.code??'']||'Hay un intento conservado que necesita revisión. No borres los datos del navegador.'}</p>}</section>;
}
