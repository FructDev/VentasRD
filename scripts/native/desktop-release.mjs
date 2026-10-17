// Local preparation only: never uploads, deploys, signs or reads a private key.
import {readFile,writeFile,stat,mkdtemp,rm,rmdir as fsRmdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const versionPattern=/^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;
function https(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.href===value}catch{return false}}
export function validateUpdateConfig(value){
 if(!value||Object.keys(value).some(k=>!['endpoint','publicKey','downloadOrigin','channel'].includes(k))||!['staging','production'].includes(value.channel)||!https(value.endpoint)||new URL(value.endpoint).pathname!=='/api/native/releases/windows-x86_64'||!https(value.downloadOrigin+'/')||new URL(value.downloadOrigin).origin!==value.downloadOrigin)throw Error('DESKTOP_UPDATE_CONFIG_INVALID');
 if(typeof value.publicKey!=='string'||value.publicKey.length>2048)throw Error('DESKTOP_UPDATE_KEY_INVALID');
 const key=Buffer.from(value.publicKey,'base64');if(key.toString('base64')!==value.publicKey||!key.toString().startsWith('untrusted comment:'))throw Error('DESKTOP_UPDATE_KEY_INVALID');
 return structuredClone(value);
}
export function releaseMetadata({manifest,config,url,signature,bytes,sha256,notes,publishedAt}){
 validateUpdateConfig(config);
 if(!versionPattern.test(manifest?.version??'')||!https(url)||new URL(url).origin!==config.downloadOrigin||!Number.isSafeInteger(bytes)||bytes<=0||!(/^[a-f0-9]{64}$/.test(sha256))||typeof notes!=='string'||notes.length>8000||!Number.isFinite(Date.parse(publishedAt)))throw Error('DESKTOP_RELEASE_INVALID');
 if(config.channel==='production'){
  if(manifest.protocol!=='ventard.windows.production.package.1'||manifest.channel!=='PRODUCTION_PILOT'||manifest.build!=='release'||manifest.identifier!=='com.ventard.pos'||manifest.projectRef!=='oxbekqoecunsbjheqgqg')throw Error('DESKTOP_RELEASE_PRODUCTION_PACKAGE_REQUIRED');
 }else if(manifest.protocol!=='ventard.windows.qa.package.1'||manifest.channel!=='STAGING_BOUNDED_PILOT'||manifest.identifier!=='com.ventard.pos.qa')throw Error('DESKTOP_RELEASE_STAGING_PACKAGE_REQUIRED');
 if(manifest.updatePublicKeySha256&&manifest.updatePublicKeySha256!==createHash('sha256').update(config.publicKey).digest('hex'))throw Error('DESKTOP_RELEASE_UPDATE_KEY_MISMATCH');
 if(manifest.installer.sha256!==sha256||manifest.installer.bytes!==bytes)throw Error('DESKTOP_RELEASE_ARTIFACT_CHANGED');
 if(typeof signature!=='string'||signature.length>8192||Buffer.from(signature,'base64').toString('base64')!==signature)throw Error('DESKTOP_RELEASE_SIGNATURE_INVALID');
 const comment=Buffer.from(signature,'base64').toString().split(/\r?\n/).find(line=>line.startsWith('trusted comment: '))?.slice(17);
 if(!comment?.split('\t').includes('version:'+manifest.version))throw Error('DESKTOP_RELEASE_SIGNED_VERSION_REQUIRED');
 return {protocol:'ventard.desktop.release.1',status:'published',channel:config.channel,version:manifest.version,publishedAt,notes,platform:'windows-x86_64',installer:{url,bytes,sha256,signature}};
}
export async function prepareRelease({manifestPath,installerPath,signaturePath,updateConfigPath,url,notesPath,outputPath}){
 const manifest=JSON.parse(await readFile(manifestPath,'utf8')),config=validateUpdateConfig(JSON.parse(await readFile(updateConfigPath,'utf8')));
 let existing;try{existing=JSON.parse(await readFile(outputPath,'utf8'))}catch(e){if(e.code!=='ENOENT')throw Error('DESKTOP_RELEASE_OUTPUT_INVALID')}
 const signature=(await readFile(signaturePath,'utf8')).trim(),bytes=await readFile(installerPath),sha256=createHash('sha256').update(bytes).digest('hex');
 const metadata=releaseMetadata({manifest,config,url,signature,bytes:bytes.length,sha256,notes:notesPath?await readFile(notesPath,'utf8'):'',publishedAt:existing?.publishedAt??new Date().toISOString()});
 if(existing&&JSON.stringify(existing)!==JSON.stringify(metadata))throw Error('DESKTOP_RELEASE_OUTPUT_DIFFERS');
 const verifier=await (async()=>{for(const mode of ['release','debug']){const path=resolve(root,'target',mode,'ventard-release-verify.exe');try{if((await stat(path)).isFile())return path}catch{/* try next built tool */}}throw Error('DESKTOP_RELEASE_VERIFIER_REQUIRED')})();
 // The native verifier uses the same Minisign implementation as Tauri.
 const temporary=await mkdtemp(join(dirname(resolve(outputPath)),'.release-verify-'));
 const publicPath=join(temporary,'public-key');
 try {
 await writeFile(publicPath,config.publicKey+'\n',{flag:'wx'});
 await new Promise((ok,fail)=>{const child=spawn(verifier,[publicPath,resolve(signaturePath),resolve(installerPath),manifest.version],{windowsHide:true,stdio:'ignore'});child.once('error',fail);child.once('exit',code=>code===0?ok():fail(Error('DESKTOP_RELEASE_SIGNATURE_INVALID')))});
 } finally {
 // Remove only this invocation's newly created public-key fixture.
 await rm(publicPath,{force:true});await fsRmdir(temporary);
 }
 if(!existing)await writeFile(outputPath,JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});
 console.log('DESKTOP_RELEASE_PREPARED_LOCALLY; NOT_UPLOADED_OR_DEPLOYED');
 return metadata;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const names={'--manifest':'manifestPath','--installer':'installerPath','--signature':'signaturePath','--updates':'updateConfigPath','--url':'url','--notes':'notesPath','--output':'outputPath'},args={};
 for(let i=2;i<process.argv.length;i+=2){const field=names[process.argv[i]];if(!field||!process.argv[i+1])throw Error('DESKTOP_RELEASE_ARGUMENT_INVALID');args[field]=process.argv[i+1]}
 for(const key of ['manifestPath','installerPath','signaturePath','updateConfigPath','url','outputPath'])if(!args[key])throw Error('DESKTOP_RELEASE_ARGUMENT_MISSING');
 prepareRelease(args).catch(()=>{console.error('DESKTOP_RELEASE_PREPARATION_FAILED');process.exitCode=1});
}
