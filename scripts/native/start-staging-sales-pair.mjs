// Two real account clients, same permanent UI/broker, separate encrypted vaults.
// No synthetic adapter, copied vault, captured password/PIN, or privileged key.
import {mkdtemp,mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,basename} from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {start,parsePublicConfig,clientEnvironment,candidatePath} from './start-staging-access.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const coordinates=join(root,'scratch/native-staging-sales-pair.json');
const resume=process.argv.includes('--resume');let previous;
if(resume){
 previous=JSON.parse(await readFile(coordinates,'utf8'));
 if(previous.projectRef!=='blzzinivvzadqjbnpsre'||previous.clients?.length!==2||previous.clients.map(c=>c.name).join(',')!=='A,B')throw Error('STAGING_PAIR_INVALID');
 for(const c of previous.clients){
  if(!Number.isInteger(c.port)||c.port<1024||c.port>65535||typeof c.directory!=='string'||dirname(resolve(c.directory)).toLowerCase()!==resolve(tmpdir()).toLowerCase()||!basename(c.directory).startsWith('ventard-native-spike-sales-'))throw Error('STAGING_PAIR_INVALID');
  if(!(await stat(c.directory)).isDirectory())throw Error('STAGING_PAIR_DIRECTORY_MISSING');
  let running=false;try{running=(await fetch(`http://127.0.0.1:${c.port}/json/version`,{signal:AbortSignal.timeout(1000)})).ok;}catch{}
  if(running)throw Error('STAGING_PAIR_ALREADY_RUNNING');
 }
}else{
 try{await stat(coordinates);throw Error('STAGING_PAIR_ALREADY_PREPARED; use --resume after closing existing clients');}
 catch(error){if(error.code!=='ENOENT')throw error;}
}
const binary=resolve(root,candidatePath('standard'));
await stat(binary);
const publicKey=parsePublicConfig(await readFile(join(root,'.env.qa-staging.local'),'utf8'));
const health=async()=>{
 const response=await fetch('http://127.0.0.1:3107/api/native/provision',{signal:AbortSignal.timeout(3000)});
 const value=await response.json();
 if(!response.ok||value.projectRef!=='blzzinivvzadqjbnpsre'||!/^\w[\w-]{1,64}$/.test(value.keyId)||!/^[a-f0-9]{64}$/.test(value.publicHex))throw Error('STAGING_ISSUER_MISMATCH');
 return value;
};
let issuer;
try{await health();}catch{issuer=await start();}
const identity=await health();
const clients=[];
for(const name of ['A','B']){
 const existing=previous?.clients.find(c=>c.name===name);
 const directory=existing?.directory??await mkdtemp(join(tmpdir(),'ventard-native-spike-sales-'));
 let port=existing?.port;
 if(!port){const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));port=socket.address().port;await new Promise(r=>socket.close(r));}
 const env={...clientEnvironment(process.env,publicKey,identity.keyId,identity.publicHex),VENTARD_QA_FIXTURE_ROOT:directory,VENTARD_QA_CDP_PORT:String(port)};
 const child=spawn(binary,[],{cwd:root,env,windowsHide:false,stdio:'ignore'});
 child.on('error',()=>console.error(`STAGING_CLIENT_${name}_FAILED`));
 clients.push({name,port,pid:child.pid,directory});
}
await mkdir(join(root,'scratch'),{recursive:true});
// Technical launch coordinates only, never credentials or account captures.
await writeFile(coordinates,JSON.stringify({projectRef:identity.projectRef,clients},null,2),{flag:resume?'w':'wx'});
console.log('STAGING_SALES_PAIR_READY: A=first window, B=second window; no production; separate vaults.');
if(!issuer)for(const client of clients)console.log(`STAGING_CLIENT_${client.name}_PORT ${client.port}`);
