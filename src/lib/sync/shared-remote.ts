import type {SharedContext,SharedRemote,SharedWire} from './shared-journal';
import {sharedContextKey,SharedRemoteError} from './shared-journal';
interface RpcClient {rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:unknown}>}
const stage='https://blzzinivvzadqjbnpsre.supabase.co';
// Bounded Staging cohort: the two existing QA businesses and one new pilot.
// Membership, licence, installation and scope are still verified by every RPC.
const tenants=new Set(['96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002','96000000-0000-4000-8000-000000000003']);
export type SharedMode='LEGACY'|'SHARED_JOURNAL'|'SCOPE_BLOCKED';
export function sharedStagingEnabled(url:string|undefined,flag:string|undefined,tenant:string):boolean{return url===stage&&flag==='staging'&&tenants.has(tenant)}
export function sharedChannelEnabled(url:string|undefined,flag:string|undefined,tenant:string):boolean {
 return sharedStagingEnabled(url,flag,tenant) || (url==='https://oxbekqoecunsbjheqgqg.supabase.co'&&flag==='production-pilot'&&tenant==='864d08e5-2975-4b2d-a1e2-ba5a14f3d677');
}
export function sharedRemote(client:RpcClient,url:string,tenant:string,flag=process.env.NEXT_PUBLIC_VENTARD_SHARED_JOURNAL??(url===stage?'staging':undefined)){
 if(!sharedChannelEnabled(url,flag,tenant))throw Error('SHARED_STAGING_ONLY');
 const call=async(name:string,args:Record<string,unknown>)=>{
  let response;try{response=await client.rpc(name,args)}catch{throw new SharedRemoteError('SHARED_TRANSPORT_UNCERTAIN')}
  if(response.error){const error=response.error as {code?:unknown;message?:unknown};
   if(error.code==='42501'||error.code==='PGRST301'||error.code==='PGRST303')throw new SharedRemoteError('SHARED_AUTH_REQUIRED');
   if(typeof error.message==='string'&&/^(NATIVE|STOCK|PRODUCT|CUSTOMER|REPAIR|LAYAWAY|SERVICE|WARRANTY|BUSINESS|CATALOGUE)_/.test(error.message))throw new SharedRemoteError('SHARED_REMOTE_CONFLICT');
   throw new SharedRemoteError('SHARED_TRANSPORT_UNCERTAIN');
  }return response.data;
 };
 const bound=(c:SharedContext)=>{sharedContextKey(c);if(c.tenantId!==tenant)throw Error('SHARED_CONTEXT_MISMATCH');return c};
 const transport:SharedRemote={
  lookup:(c,operationId,hash)=>call('native_web_lookup_v1',{p_context:bound(c),p_operation_id:operationId,p_hash:hash}),
  submit:(c,w:SharedWire)=>call('native_web_submit_v1',{p_context:bound(c),p_intent:w.intent,p_hash:w.intentHash,p_snapshot:w.snapshot,p_snapshot_hash:w.snapshotHash}),
 };
 return{...transport,
  async mode(branchId:string|null):Promise<SharedMode>{
   const v=await call('native_web_mode_v1',{p_negocio_id:tenant,p_sucursal_id:branchId}) as Record<string,unknown>|null;
   if(!v||v.protocol!=='ventard.web.mode.1'||v.tenantId!==tenant||v.branchId!==branchId||!['LEGACY','SHARED_JOURNAL','SCOPE_BLOCKED'].includes(String(v.mode)))throw Error('SHARED_RESPONSE_INVALID');return v.mode as SharedMode;
  },
  enroll:(installationId:string,deviceId:string,branchId:string|null,registrationId:string)=>call('native_web_enroll_v1',{p_negocio_id:tenant,p_installation_id:installationId,p_device_id:deviceId,p_sucursal_id:branchId,p_registration_id:registrationId}),
  feed:(c:SharedContext,after:string)=>call('native_web_feed_v1',{p_context:bound(c),p_after:after}),
  bootstrap:(c:SharedContext,snapshotId:string)=>call('native_web_bootstrap_v1',{p_context:bound(c),p_snapshot_id:snapshotId}),
  page:(c:SharedContext,snapshotId:string,index:number)=>call('native_web_bootstrap_page_v1',{p_context:bound(c),p_snapshot_id:snapshotId,p_page_index:index}),
  planService:(c:SharedContext,family:string,request:Record<string,unknown>,previous:Record<string,unknown>|null,at:string,folio:string,folioNumber:string)=>family==='RETURN'?call('native_web_return_plan_v1',{p_context:bound(c),p_sale:previous?.sale,p_prior:previous?.prior,p_items:request.items,p_serials:request.serials}):call('native_web_service_plan_v1',{p_context:bound(c),p_family:family,p_request:request,p_previous:previous,p_at:at,p_folio:folio,p_folio_number:folioNumber}),
  resolutionHistory:(c:SharedContext,cutoverId:string)=>call('native_web_resolution_history_v1',{p_context:bound(c),p_cutover_id:cutoverId}),
  catalogue:(c:SharedContext)=>{bound(c);return call('native_catalogue_settings_v1',{p_negocio_id:c.tenantId,p_installation_id:c.installationId,p_device_id:c.deviceId,p_writer_epoch:c.writerEpoch,p_scope_kind:c.scopeType,p_sucursal_id:c.branchId})},
  privateSubmit:(c:SharedContext,intent:string,hash:string)=>{bound(c);return call('native_repairs_private_submit_v1',{p_intent:intent,p_hash:hash})},
  privateRead:(c:SharedContext)=>{bound(c);return call('native_repairs_private_read_v1',{p_negocio_id:c.tenantId,p_installation_id:c.installationId,p_device_id:c.deviceId,p_writer_epoch:c.writerEpoch,p_scope_kind:c.scopeType,p_sucursal_id:c.branchId})},
 };
}
