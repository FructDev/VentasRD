// Deployment metadata only. Never runs a business RPC or reads commercial rows.
import {readFile} from 'node:fs/promises';
import {parsePublicConfig} from './start-staging-access.mjs';
import {validateQaServerKey} from '../qa/pro00-runtime.mjs';
const ref='blzzinivvzadqjbnpsre';
const config=await readFile(new URL('../../.env.qa-staging.local',import.meta.url),'utf8');
const publicKey=parsePublicConfig(config);
const line=config.split(/\r?\n/).find(l=>l.startsWith('VENTARD_QA_SERVER_KEY='));
const serverKey=line?validateQaServerKey(line.slice(line.indexOf('=')+1).trim().replace(/^["']|["']$/g,'')):null;
if(!serverKey)throw new Error('STAGING_METADATA_KEY_MISSING');
const headers={apikey:serverKey,Accept:'application/openapi+json'};
if(!serverKey.startsWith('sb_secret_'))headers.Authorization=`Bearer ${serverKey}`;
const response=await fetch(`https://${ref}.supabase.co/rest/v1/`,{headers,redirect:'error',signal:AbortSignal.timeout(20000)});
if(!response.ok)throw new Error(`STAGING_METADATA_HTTP_${response.status}`);
const schema=await response.json();
const rpcs=['activate','bootstrap','bootstrap_page','submit','lookup','feed','fiscal_allocate'].map(n=>`native_sales_${n}_v1`);
const tables=['mode','counter','ledger','stock','credit','turns','effects','write_context','snapshots','pages'].map(n=>`native_sales_${n}_v1`);
const result={projectRef:ref,metadataOnly:true,privilegedKeyUsedForMetadataOnly:true,
 functions:rpcs.map(name=>({name,found:!!schema.paths?.[`/rpc/${name}`]})),
 tables:tables.map(name=>({name,found:!!schema.paths?.[`/${name}`]}))};
if(process.argv.includes('--source-columns')){
 result.sourceColumns=Object.fromEntries(['productos','composiciones','clientes','seriales','transacciones_fiado'].map(name=>[name,Object.keys(schema.definitions?.[name]?.properties??{})]));
}
// Anonymous schema visibility is not proof of authenticated role/RLS isolation.
const anonHeaders={apikey:publicKey,Accept:'application/openapi+json'};
if(!publicKey.startsWith('sb_publishable_'))anonHeaders.Authorization=`Bearer ${publicKey}`;
const anon=await fetch(`https://${ref}.supabase.co/rest/v1/`,{headers:anonHeaders,redirect:'error',signal:AbortSignal.timeout(20000)});
const anonSchema=anon.ok?await anon.json():{};
result.anonymousSchemaStatus=anon.status;
result.anonymousVisibleSalesObjects=[...rpcs.map(n=>`/rpc/${n}`),...tables.map(n=>`/${n}`)].filter(n=>anonSchema.paths?.[n]);
result.deploymentMetadataPass=result.functions.every(f=>f.found)&&result.tables.every(t=>t.found);
console.log(JSON.stringify(result,null,2));
if(!result.deploymentMetadataPass||result.anonymousVisibleSalesObjects.length)process.exitCode=1;
