// Read-only checks of synthetic QA setup/auth metadata. Never prints credentials.
import {readFile} from 'node:fs/promises';
import {validateQaServerKey} from '../qa/pro00-runtime.mjs';
const ref='blzzinivvzadqjbnpsre';
const text=await readFile(new URL('../../.env.qa-staging.local',import.meta.url),'utf8');
const line=text.split(/\r?\n/).find(x=>x.startsWith('VENTARD_QA_SERVER_KEY='));
if(!line)throw Error('STAGING_KEY_MISSING');
const key=validateQaServerKey(line.slice(line.indexOf('=')+1).trim().replace(/^["']|["']$/g,''));
const headers={apikey:key};if(!key.startsWith('sb_secret_'))headers.Authorization=`Bearer ${key}`;
async function get(path){const r=await fetch(`https://${ref}.supabase.co/${path}`,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(`STAGING_READ_HTTP_${r.status}`);return r.json();}
const mode=await get('rest/v1/native_sales_mode_v1?select=scope_kind,sucursal_id&negocio_id=eq.96000000-0000-4000-8000-000000000001');
console.log(JSON.stringify({projectRef:ref,syntheticTenant:'QA_A',adopted:mode.length===1,mode}));
const operation=process.argv.find(a=>a.startsWith('--operation='))?.slice('--operation='.length);
if(operation){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation))throw Error('QA_OPERATION_INVALID');
 const rows=await get(`rest/v1/native_sales_ledger_v1?select=operation_id,remote_sequence,receipt&negocio_id=eq.96000000-0000-4000-8000-000000000001&operation_id=eq.${operation}`);
 console.log(JSON.stringify({syntheticOperation:operation,remoteAppliedLedgerFound:rows.length===1,ledger:rows}));
}
if(process.argv.includes('--source-check')){
 const products=await get('rest/v1/productos?select=id,precio_venta,costo,tasa_itbis,precio_2,precio_3&negocio_id=eq.96000000-0000-4000-8000-000000000001&limit=1000');
 const counts={productsChecked:products.length,priceMissing:0,taxMissing:0,taxOutsideRatio:0,negativePrice:0,negativeCost:0};
 for(const p of products){
  if(p.precio_venta==null)counts.priceMissing++;
  if(p.tasa_itbis==null)counts.taxMissing++;
  else if(Number(p.tasa_itbis)<0||Number(p.tasa_itbis)>1)counts.taxOutsideRatio++;
  if(p.precio_venta!=null&&Number(p.precio_venta)<0)counts.negativePrice++;
  if(p.costo!=null&&Number(p.costo)<0)counts.negativeCost++;
 }
 console.log(JSON.stringify({syntheticSourceValidation:counts,scope:'QA_A_ONLY',boundedSample:true,noSourceMutation:true}));
}
const accounts=await get('auth/v1/admin/users?page=1&per_page=100');
for(const email of ['pro00-owner-a@example.test','pro00-admin-a@example.test','pro00-seller-a@example.test']){
 const user=accounts.users?.find(u=>u.email===email);
 let membership=[];
 if(user)membership=await get(`rest/v1/usuarios_negocio?select=rol,activo&negocio_id=eq.96000000-0000-4000-8000-000000000001&user_id=eq.${user.id}`);
 console.log(JSON.stringify({account:email,exists:!!user,confirmed:!!user?.email_confirmed_at,banned:!!user?.banned_until&&Date.parse(user.banned_until)>Date.now(),lastSignInKnown:!!user?.last_sign_in_at,membership}));
}
