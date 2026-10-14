// Resume one existing QA installation. No new vault, identity, PIN or context.
import {readFile,writeFile,stat} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parsePublicConfig,clientEnvironment} from './start-staging-access.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const name=process.argv[2]??'B';
if(!['A','B'].includes(name))throw Error('QA_CLIENT_REQUIRED');
const coordinates=join(root,'scratch/native-staging-sales-pair.json');
const pair=JSON.parse(await readFile(coordinates,'utf8'));
if(pair.projectRef!=='blzzinivvzadqjbnpsre')throw Error('QA_SCOPE_REQUIRED');
const client=pair.clients?.find(c=>c.name===name);
if(!client||!Number.isInteger(client.port)||client.port<1024||client.port>65535||typeof client.directory!=='string'||dirname(resolve(client.directory)).toLowerCase()!==resolve(tmpdir()).toLowerCase()||!basename(client.directory).startsWith('ventard-native-spike-sales-'))throw Error('QA_PROFILE_INVALID');
await stat(join(client.directory,'vault/native-access/selected.json'));
let active=false;
try{active=(await fetch(`http://127.0.0.1:${client.port}/json/version`,{signal:AbortSignal.timeout(1500)})).ok}catch{}
if(active){console.log(`QA_${name}_ALREADY_OPEN`);process.exit(0)}
const issuerPath=join(root,'scripts/native/start-staging-access.mjs');
await stat(join(root,'.env.native-staging-issuer/private-key.der'));
async function health(){const r=await fetch('http://127.0.0.1:3107/api/native/provision',{signal:AbortSignal.timeout(1500)});const v=await r.json();if(!r.ok||v.projectRef!=='blzzinivvzadqjbnpsre'||!/^[a-f0-9]{64}$/.test(v.publicHex)||!/^\w[\w-]{1,64}$/.test(v.keyId))throw Error('QA_ISSUER_INVALID');return v}
let issuer;
try{issuer=await health()}catch{
 const daemon=spawn(process.execPath,[issuerPath],{cwd:root,detached:true,windowsHide:true,stdio:'ignore'});
 daemon.on('error',()=>{});daemon.unref();
 for(let attempt=0;attempt<30&&!issuer;attempt++){await new Promise(r=>setTimeout(r,200));try{issuer=await health()}catch{}}
}
if(!issuer)throw Error('QA_ISSUER_UNAVAILABLE');
const publishable=parsePublicConfig(await readFile(join(root,'.env.qa-staging.local'),'utf8'));
const binary=join(root,'target/debug/ventard-pos.exe');await stat(binary);
const child=spawn(binary,[],{cwd:root,env:{...clientEnvironment(process.env,publishable,issuer.keyId,issuer.publicHex),VENTARD_QA_FIXTURE_ROOT:client.directory,VENTARD_QA_CDP_PORT:String(client.port)},detached:true,windowsHide:false,stdio:'ignore'});
await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});
client.pid=child.pid;await writeFile(coordinates,JSON.stringify(pair,null,2));child.unref();
console.log(`QA_${name}_RESUMED_WITH_EXISTING_PROFILE`);
