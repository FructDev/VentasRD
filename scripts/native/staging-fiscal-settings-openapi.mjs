// GET metadata only. No RPC invocation, business rows or credential output.
import {readFile} from 'node:fs/promises';
import {validateQaServerKey} from '../qa/pro00-runtime.mjs';
const ref='blzzinivvzadqjbnpsre',text=await readFile(new URL('../../.env.qa-staging.local',import.meta.url),'utf8');
const line=text.split(/\r?\n/).find(x=>x.startsWith('VENTARD_QA_SERVER_KEY='));if(!line)throw Error('STAGING_KEY_MISSING');
const key=validateQaServerKey(line.slice(line.indexOf('=')+1).trim().replace(/^["']|["']$/g,''));
const headers={apikey:key,Accept:'application/openapi+json'};if(!key.startsWith('sb_secret_'))headers.Authorization=`Bearer ${key}`;
const response=await fetch(`https://${ref}.supabase.co/rest/v1/`,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error(`STAGING_METADATA_HTTP_${response.status}`);
const schema=await response.json(),names=['read','lookup','submit','abandon'].map(n=>`native_fiscal_settings_${n}_v1`),available=names.filter(n=>schema.paths?.[`/rpc/${n}`]);
console.log(JSON.stringify({projectRef:ref,metadataOnly:true,fiscalRpc:available.length,required:4}));if(available.length!==4)throw Error('STAGING_FISCAL_API_MISSING');
