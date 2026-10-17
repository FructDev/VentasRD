// Windows-only custody for NEW local release keys. No remote access, signing
// authority upload, user credential access or plaintext secret files in repo.
import {spawn} from 'node:child_process';
import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,timingSafeEqual} from 'node:crypto';
import {readFile,mkdir,open,mkdtemp,rm,rmdir,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'../..');
const purposes=new Set(['production-grant','production-updater','fixture-grant','fixture-updater']);
const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;
try {
 $request=[Console]::In.ReadToEnd()|ConvertFrom-Json;
 if($request.purpose -notin @('production-grant','production-updater','fixture-grant','fixture-updater')){throw 'PURPOSE'};
 $bytes=[Convert]::FromBase64String($request.data);
 if($bytes.Length -gt 65536){throw 'SIZE'};
 $entropy=[Text.Encoding]::UTF8.GetBytes('ventard.signing.v1:oxbekqoecunsbjheqgqg:'+$request.purpose);
 if($request.action -eq 'protect'){$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}
 elseif($request.action -eq 'unprotect'){$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}
 else{throw 'ACTION'};
 [Console]::Out.Write([Convert]::ToBase64String($result));
}catch{[Console]::Error.Write('SIGNING_CUSTODY_FAILED');exit 1}`;
export async function protectSecret(data,purpose,action='protect'){
 if(process.platform!=='win32'||!purposes.has(purpose)||!['protect','unprotect'].includes(action)||!Buffer.isBuffer(data)||data.length>65536)throw Error('SIGNING_CUSTODY_INPUT_INVALID');
 return new Promise((ok,fail)=>{
  const p=spawn(join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','ignore'],timeout:15000});let output='';
  p.stdout.on('data',b=>{output+=b.toString();if(output.length>131072)p.kill()});p.stdin.on('error',()=>{});
  p.once('error',()=>fail(Error('SIGNING_CUSTODY_UNAVAILABLE')));p.once('exit',code=>{if(code!==0||!output||!/^[A-Za-z0-9+/]+=*$/.test(output))return fail(Error('SIGNING_CUSTODY_FAILED'));ok(Buffer.from(output,'base64'))});
  p.stdin.end(JSON.stringify({action,purpose,data:data.toString('base64')}));
 });
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function writeNew(path,body){const file=await open(path,'wx');try{await file.writeFile(body);await file.sync()}finally{await file.close()}}
async function readSmall(path){const meta=await lstat(path);if(!meta.isFile()||meta.isSymbolicLink()||meta.size>131072)throw Error('SIGNING_CUSTODY_FILE_INVALID');return readFile(path)}
async function sealed(path,purpose,secret){
 const encrypted=await protectSecret(secret,purpose),verified=await protectSecret(encrypted,purpose,'unprotect');
 try{if(secret.length!==verified.length||!timingSafeEqual(secret,verified))throw Error('SIGNING_CUSTODY_VERIFY_FAILED');await writeNew(path,JSON.stringify({protocol:'ventard.signing.dpapi.1',purpose,ciphertext:encrypted.toString('base64')})+'\n')}finally{verified.fill(0)}
}
export async function readSecret(directory,purpose){
 if(!['production-grant','production-updater'].includes(purpose))throw Error('SIGNING_PURPOSE_INVALID');
 const envelope=JSON.parse((await readSmall(join(directory,purpose+'.dpapi.json'))).toString());
 if(envelope.protocol!=='ventard.signing.dpapi.1'||envelope.purpose!==purpose||typeof envelope.ciphertext!=='string')throw Error('SIGNING_CUSTODY_FILE_INVALID');
 return protectSecret(Buffer.from(envelope.ciphertext,'base64'),purpose,'unprotect');
}
export async function prepareSigningCustody(directory=resolve(root,'scratch/production-signing')){
 if(process.platform!=='win32')throw Error('SIGNING_WINDOWS_REQUIRED');
 try{await mkdir(directory)}catch(e){if(e.code!=='EEXIST')throw e;
  const m=JSON.parse((await readSmall(join(directory,'public.json'))).toString());
  const secret=await readSecret(directory,'production-grant'),updater=await readSecret(directory,'production-updater');
  try{const pub=createPublicKey(createPrivateKey(secret)).export({format:'der',type:'spki'}).subarray(-32).toString('hex');if(m.protocol!=='ventard.production.signing.public.1'||pub!==m.grantPublicHex||sha(updater)!==m.updaterPrivateFingerprint)throw Error('SIGNING_CUSTODY_MISMATCH');return m}finally{secret.fill(0);updater.fill(0)}
 }
 let temporary;
 try{
  const pair=generateKeyPairSync('ed25519'),secret=Buffer.from(pair.privateKey.export({format:'pem',type:'pkcs8'}));
  try{await sealed(join(directory,'production-grant.dpapi.json'),'production-grant',secret)}finally{secret.fill(0)}
  // Tauri writes its key only into the OS temp directory, never OneDrive/repo.
  temporary=await mkdtemp(join(tmpdir(),'ventard-new-updater-'));
  const keyPath=join(temporary,'release.key');
  await new Promise((ok,fail)=>{const p=spawn(process.execPath,[resolve(root,'node_modules/@tauri-apps/cli/tauri.js'),'signer','generate','--ci','-w',keyPath],{windowsHide:true,stdio:'ignore',env:{...process.env,TAURI_SIGNING_PRIVATE_KEY_PASSWORD:''}});p.once('error',()=>fail(Error('SIGNING_KEY_GENERATION_FAILED')));p.once('exit',n=>n===0?ok():fail(Error('SIGNING_KEY_GENERATION_FAILED')))});
  const updater=await readFile(keyPath),publicKey=(await readFile(keyPath+'.pub','utf8')).trim();
  const fingerprint=sha(updater);
  try{await sealed(join(directory,'production-updater.dpapi.json'),'production-updater',updater)}finally{updater.fill(0)}
  const metadata={protocol:'ventard.production.signing.public.1',custody:'WINDOWS_DPAPI_CURRENT_USER',keyId:'production-native-v1',grantPublicHex:pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'),updaterPublicKey:publicKey,updaterPrivateFingerprint:fingerprint,remoteUploadPerformed:false};
  await writeNew(join(directory,'public.json'),JSON.stringify(metadata,null,2)+'\n');return metadata;
 }catch{throw Error('SIGNING_PREPARATION_FAILED_KEEP_EXISTING_FILES')}finally{
  if(temporary){for(const name of ['release.key','release.key.pub'])await rm(join(temporary,name),{force:true});await rmdir(temporary)}
 }
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))prepareSigningCustody().then(m=>console.log(JSON.stringify({status:'LOCAL_KEYS_PROTECTED',keyId:m.keyId,custody:m.custody,remoteUploadPerformed:false}))).catch(()=>{console.error('SIGNING_PREPARATION_FAILED; no key material emitted');process.exitCode=1});
