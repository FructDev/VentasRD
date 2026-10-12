// Development helper, NOT another frontend/backend business implementation.
// Imports the same production handler used by Next; binds loopback only.
import {createServer} from 'node:http';
import {readFile,mkdir,open,stat} from 'node:fs/promises';
import {generateKeyPairSync,createPrivateKey,createPublicKey} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProvisionHandler} from '../../src/lib/native-access/provision-handler.ts';
import {stagingDependencies} from '../../src/lib/native-access/staging-dependencies.ts';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const stage='https://blzzinivvzadqjbnpsre.supabase.co';
const keyId='staging-development-1';
export function clientEnvironment(source,publishable,keyId,publicHex){
 const os=new Set(['path','systemroot','windir','comspec','pathext','temp','tmp','userprofile','localappdata','appdata','programfiles','programfiles(x86)','systemdrive','homedrive','homepath']);
 const result={};for(const[name,value]of Object.entries(source)){if(os.has(name.toLowerCase())&&typeof value==='string')result[name]=value;}
 return {...result,VENTARD_NATIVE_STAGING_PUBLISHABLE_KEY:publishable,VENTARD_NATIVE_GRANT_KEY_ID:keyId,VENTARD_NATIVE_GRANT_PUBLIC_HEX:publicHex};
}
export function parsePublicConfig(text){const line=text.split(/\r?\n/).find(l=>l.startsWith('VENTARD_QA_PUBLISHABLE_KEY='));if(!line)throw new Error('STAGING_PUBLIC_KEY_MISSING');const key=line.slice(line.indexOf('=')+1).trim().replace(/^["']|["']$/g,'');if(!key.startsWith('sb_publishable_')){let c;try{c=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString());}catch{throw new Error('STAGING_PUBLIC_KEY_INVALID')}if(c.role!=='anon'||c.ref!=='blzzinivvzadqjbnpsre')throw new Error('STAGING_PUBLIC_KEY_INVALID');}return key;}
async function issuer(){
 const dir=resolve(root,'.env.native-staging-issuer');await mkdir(dir,{recursive:true,mode:0o700});
 if(process.platform!=='win32')throw new Error('STAGING_ISSUER_WINDOWS_ONLY');
 const owner=execFileSync('whoami',[],{encoding:'utf8',windowsHide:true}).trim();
 execFileSync('icacls',[dir,'/inheritance:r','/grant:r',`${owner}:(OI)(CI)F`],{stdio:'ignore',windowsHide:true});
 const p=resolve(dir,'private-key.der');let key;
 try {const meta=await stat(p);if(!meta.isFile()||meta.size>256)throw new Error('STAGING_ISSUER_INVALID');const der=await readFile(p);try{key=createPrivateKey({key:der,format:'der',type:'pkcs8'});}finally{der.fill(0);}}
 catch(e){if(e.code!=='ENOENT')throw new Error('STAGING_ISSUER_UNAVAILABLE');key=generateKeyPairSync('ed25519').privateKey;const der=key.export({format:'der',type:'pkcs8'});const f=await open(p,'wx',0o600);try{await f.writeFile(der);await f.sync();}finally{der.fill(0);await f.close();}}
 if(key.asymmetricKeyType!=='ed25519')throw new Error('STAGING_ISSUER_INVALID');
 const publicHex=createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32).toString('hex');return {key,publicHex};
}
export function candidatePath(candidate){const paths={standard:'target/debug/ventard-pos.exe',catalogue:'target/debug/ventard-pos-catalogue.exe','account-drafts':'target/debug/ventard-pos-account-drafts.exe'};if(!Object.hasOwn(paths,candidate))throw new Error('NATIVE_CANDIDATE_INVALID');return paths[candidate];}
export async function start({launch=false,candidate='standard',launchOnly=false}={}){
 const candidateFile=candidatePath(candidate);
 const publishable=parsePublicConfig(await readFile(resolve(root,'.env.qa-staging.local'),'utf8'));
 const {key,publicHex}=await issuer();
 const env={VENTARD_NATIVE_ENV:'staging',VENTARD_NATIVE_STAGING_URL:stage,VENTARD_NATIVE_STAGING_PUBLISHABLE_KEY:publishable,VENTARD_NATIVE_GRANT_KEY_ID:keyId,VENTARD_NATIVE_GRANT_PRIVATE_KEY_PEM:key.export({format:'pem',type:'pkcs8'}).toString()};
 const dep=stagingDependencies(env);if(!dep.enabled)throw new Error('STAGING_ISSUER_UNAVAILABLE');const handler=createProvisionHandler(dep);
 const launchClient=async()=>{const binary=resolve(root,candidateFile);await stat(binary);const client=spawn(binary,[],{cwd:root,env:clientEnvironment(process.env,publishable,keyId,publicHex),windowsHide:false,stdio:'ignore'});client.on('error',()=>console.log('NATIVE_CLIENT_LAUNCH_FAILED'));};
 if(launchOnly){const r=await fetch('http://127.0.0.1:3107/api/native/provision',{signal:AbortSignal.timeout(2000)});const health=await r.json();if(!r.ok||health.projectRef!=='blzzinivvzadqjbnpsre'||health.publicHex!==publicHex||health.keyId!==keyId)throw new Error('NATIVE_ISSUER_MISMATCH');await launchClient();return null;}
 const server=createServer(async(req,res)=>{
  try {
   if(req.url!=='/api/native/provision'){res.writeHead(404);res.end();return;}
   if(req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({protocol:'ventard.native.provision.health.v1',projectRef:'blzzinivvzadqjbnpsre',keyId,publicHex}));return;}
   const request=new Request('http://127.0.0.1:3107/api/native/provision',{method:req.method,headers:req.headers,body:Readable.toWeb(req),duplex:'half'});
   const r=await handler(request);res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));
  }catch{res.writeHead(503,{'Content-Type':'application/json'});res.end('{"code":"NATIVE_PROVISION_UNAVAILABLE"}');}
 });
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(3107,'127.0.0.1',ok)});
 console.log('NATIVE_STAGING_ISSUER_READY 127.0.0.1:3107; production disabled; signing key private');
 if(launch)await launchClient();
 return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){start({launch:process.argv.includes('--launch'),launchOnly:process.argv.includes('--launch-only'),candidate:process.argv.find(a=>a.startsWith('--candidate='))?.slice('--candidate='.length)??'standard'}).catch(()=>{console.error('NATIVE_STAGING_START_FAILED; no secrets emitted');process.exitCode=1;});}
