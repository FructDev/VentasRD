// Support-only GET of technical capture timestamps. Never shipped to native UI.
// No users/products/business records, RPC, SQL execution or writes.
import {readFile} from 'node:fs/promises';
import {parsePublicConfig} from './start-staging-access.mjs';
const file=await readFile(new URL('../../.env.qa-staging.local',import.meta.url),'utf8');
parsePublicConfig(file); // refuses a foreign public project configuration
const line=file.split(/\r?\n/).find(l=>l.startsWith('VENTARD_QA_SERVER_KEY='));
if(!line)throw new Error('STAGING_SUPPORT_KEY_MISSING');
let key=line.slice(line.indexOf('=')+1).trim();
if([34,39].includes(key.charCodeAt(0))&&key[0]===key.at(-1))key=key.slice(1,-1);
if(!key.startsWith('sb_secret_')){
 let claims;try{claims=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString());}catch{throw new Error('STAGING_SUPPORT_KEY_INVALID');}
 if(claims.role!=='service_role'||claims.ref!=='blzzinivvzadqjbnpsre')throw new Error('STAGING_SUPPORT_KEY_INVALID');
}
const sentAtMs=Date.now();
const response=await fetch('https://blzzinivvzadqjbnpsre.supabase.co/rest/v1/native_catalogue_snapshots_v1?select=captured_at_ms,expires_at_ms&order=captured_at_ms.desc&limit=5',{
 method:'GET',headers:{apikey:key,Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(10000),
});
const receivedAtMs=Date.now();
if(!response.ok){console.log(JSON.stringify({status:response.status}));process.exit(1);}
const rows=await response.json();
const times=rows.map(row=>({capturedAtMs:String(row.captured_at_ms),expiresAtMs:String(row.expires_at_ms)}));
console.log(JSON.stringify({projectRef:'blzzinivvzadqjbnpsre',onlyTechnicalTimes:true,sentAtMs,receivedAtMs,httpDate:response.headers.get('date'),times}));
