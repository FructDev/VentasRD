// Only public key, fixed staging host, denied unauthenticated catalogue calls.
// No SQL endpoint, privileged key or commercial RPC. Does NOT prove actor RLS.
import {readFile} from 'node:fs/promises';
import {parsePublicConfig} from './start-staging-access.mjs';
const publicKey=parsePublicConfig(await readFile(new URL('../../.env.qa-staging.local',import.meta.url),'utf8'));
for(const [name,body] of [
 ['native_catalogue_begin_v1',{p_snapshot_id:'96000000-0000-4000-8000-000000000091',p_negocio_id:'96000000-0000-4000-8000-000000000001',p_installation_id:'96000000-0000-4000-8000-000000000092',p_device_id:'96000000-0000-4000-8000-000000000093',p_writer_epoch:'1',p_scope_kind:'GLOBAL',p_sucursal_id:null}],
 ['native_catalogue_page_v1',{p_snapshot_id:'96000000-0000-4000-8000-000000000091',p_page_index:0}],
]) {
 const headers={apikey:publicKey,'Content-Type':'application/json'};if(!publicKey.startsWith('sb_publishable_'))headers.Authorization=`Bearer ${publicKey}`;
 const r=await fetch(`https://blzzinivvzadqjbnpsre.supabase.co/rest/v1/rpc/${name}`,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
 const result=await r.json();const code=/^[A-Z0-9_]{1,32}$/.test(String(result.code))?result.code:'REDACTED';
 console.log(JSON.stringify({projectRef:'blzzinivvzadqjbnpsre',function:name,status:r.status,code,unauthenticatedDenied:[401,403].includes(r.status)}));if(![401,403].includes(r.status))process.exitCode=1;
}
