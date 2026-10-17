// Opens the actual packaged app on one dedicated, reusable local pilot profile.
// No credentials, grants, installation identities or database files are seeded.
import {readFile,writeFile,mkdir,mkdtemp,copyFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {validatePublicConfig} from './package-windows-qa.mjs';
import {clientEnvironment} from './start-staging-access.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const projectRef='blzzinivvzadqjbnpsre',tenantId='96000000-0000-4000-8000-000000000003',version='0.1.8';
const hash=body=>createHash('sha256').update(body).digest('hex');
const coordinates=resolve(root,'scratch/staging-pilot-pc.json');
const distribution=resolve(root,'scratch/windows-qa-distribution',version);
const manifest=JSON.parse(await readFile(resolve(distribution,'package.json'),'utf8'));
const config=validatePublicConfig(JSON.parse(await readFile(resolve(distribution,'public-staging-config.json'),'utf8')));
if(manifest.version!==version||manifest.channel!=='STAGING_BOUNDED_PILOT'||!manifest.tenants.includes(tenantId)||config.issuerUrl!==`https://${projectRef}.supabase.co/functions/v1/native-provision-staging`)throw Error('PILOT_PACKAGE_INVALID');
let client;
try{client=JSON.parse(await readFile(coordinates,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(client){
 if(client.projectRef!==projectRef||client.tenantId!==tenantId||dirname(resolve(client.directory)).toLowerCase()!==resolve(tmpdir()).toLowerCase()||!basename(client.directory).startsWith('ventard-native-spike-pilot-')||!Number.isInteger(client.port)||client.port<1024||client.port>65535)throw Error('PILOT_PROFILE_INVALID');
 if(!(await stat(client.directory)).isDirectory())throw Error('PILOT_PROFILE_MISSING');
 try{const r=await fetch(`http://127.0.0.1:${client.port}/json/version`,{signal:AbortSignal.timeout(1000)});if(r.ok){console.log('STAGING_PILOT_ALREADY_OPEN');process.exit(0)}}catch{}
}else{
 const server=createServer();await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok)});
 const port=server.address().port;await new Promise(ok=>server.close(ok));
 client={projectRef,tenantId,directory:await mkdtemp(resolve(tmpdir(),'ventard-native-spike-pilot-')),port};
 await writeFile(coordinates,JSON.stringify(client,null,2)+'\n',{flag:'wx'});
}
const out=resolve(root,'scratch/staging-pilot-runtime',version);await mkdir(out,{recursive:true});
const binary=resolve(out,'VentaRD-QA.exe');
let present;try{present=await readFile(binary)}catch(e){if(e.code!=='ENOENT')throw e;}
if(present){if(hash(present)!==manifest.binarySha256)throw Error('PILOT_BINARY_CHANGED');}
else{const compiled=resolve(root,'target/debug/VentaRD-QA.exe');if(hash(await readFile(compiled))!==manifest.binarySha256)throw Error('PILOT_BINARY_CHANGED');await copyFile(compiled,binary);}
await writeFile(resolve(out,'public-staging-config.json'),JSON.stringify(config,null,2)+'\n');
const child=spawn(binary,[],{cwd:out,env:{...clientEnvironment(process.env,config.publishableKey,config.keyId,config.publicHex),VENTARD_QA_FIXTURE_ROOT:client.directory,VENTARD_QA_CDP_PORT:String(client.port)},detached:true,windowsHide:true,stdio:'ignore'});
await new Promise((ok,fail)=>{child.once('spawn',ok);child.once('error',fail)});child.unref();
await writeFile(coordinates,JSON.stringify({...client,pid:child.pid,version},null,2)+'\n');
console.log('STAGING_PILOT_APP_OPENED; EXISTING_PROFILE_PRESERVED; UNLOCK_WITH_PIN_OR_COMPLETE_FIRST_LOGIN');
