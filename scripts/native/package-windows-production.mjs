// Local, explicit production PILOT build. No database access, installation,
// upload, deployment, licence activation or private-key generation.
import {readFile,writeFile,mkdir,copyFile,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {validateUpdateConfig} from './desktop-release.mjs';
const root=resolve(import.meta.dirname,'../..');
export const productionTarget={projectRef:'oxbekqoecunsbjheqgqg',tenantId:'864d08e5-2975-4b2d-a1e2-ba5a14f3d677',webOrigin:'https://ventard.vercel.app',issuerUrl:'https://oxbekqoecunsbjheqgqg.supabase.co/functions/v1/native-provision'};
export function productionPublicConfig(v){
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['publishableKey','keyId','publicHex','issuerUrl','webOrigin'].includes(k)))throw Error('PRODUCTION_PUBLIC_CONFIG_INVALID');
 let publicKey=typeof v.publishableKey==='string'&&/^sb_publishable_[A-Za-z0-9_-]{1,480}$/.test(v.publishableKey);
 if(!publicKey&&typeof v.publishableKey==='string'&&v.publishableKey.length<2048){try{const c=JSON.parse(Buffer.from(v.publishableKey.split('.')[1],'base64url').toString());publicKey=c.role==='anon'&&c.ref===productionTarget.projectRef}catch{/* reject */}}
 if(!publicKey||v.issuerUrl!==productionTarget.issuerUrl||v.webOrigin!==productionTarget.webOrigin||!/^production-[A-Za-z0-9-]{1,53}$/.test(v.keyId??'')||!(/^[a-f0-9]{64}$/.test(v.publicHex??''))||/^0+$/.test(v.publicHex))throw Error('PRODUCTION_PUBLIC_CONFIG_INVALID');
 return structuredClone(v);
}
export function productionInstallerConfiguration(version,updates,capability){
 if(!/^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/.test(version))throw Error('PRODUCTION_PACKAGE_VERSION_INVALID');
 validateUpdateConfig(updates);
 if(updates.channel!=='production'||updates.endpoint!==productionTarget.webOrigin+'/api/native/releases/windows-x86_64')throw Error('PRODUCTION_UPDATE_CHANNEL_INVALID');
 return {productName:'VentaRD',version,identifier:'com.ventard.pos',mainBinaryName:'VentaRD',
  build:{beforeBuildCommand:null,beforeBundleCommand:null},
  app:{security:{capabilities:[{...capability,identifier:'pos-production',description:'Acceso verificado del piloto, sin comandos QA ni fiscal.',permissions:capability.permissions.filter(p=>!p.startsWith('allow-qa-')&&!p.startsWith('allow-native-fiscal-'))}]}},
  plugins:{updater:{pubkey:updates.publicKey,requireSignedVersion:true,windows:{installMode:'passive'}}},
  bundle:{active:true,targets:['nsis'],createUpdaterArtifacts:true,resources:[],category:'Business',shortDescription:'VentaRD para Windows',windows:{allowDowngrades:false,webviewInstallMode:{type:'downloadBootstrapper',silent:true},nsis:{installMode:'currentUser',languages:['Spanish'],displayLanguageSelector:false,compression:'lzma',startMenuFolder:'VentaRD',installerHooks:resolve(root,'apps/pos/src-tauri/windows/installer-hooks.nsh')}}}};
}
async function run(file,args,cwd,env){await new Promise((ok,fail)=>{const p=spawn(file,args,{cwd,env,stdio:'inherit',windowsHide:true});p.once('error',fail);p.once('exit',c=>c===0?ok():fail(Error('PRODUCTION_PACKAGE_COMMAND_FAILED')))})}
const digest=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
async function stable(p,v){try{await writeFile(p,v,{flag:'wx'})}catch(e){if(e.code!=='EEXIST'||await readFile(p,'utf8')!==v)throw Error('PRODUCTION_PACKAGE_OUTPUT_DIFFERS')}}
export async function packageWindowsProduction({version,publicConfigPath,updateConfigPath}){
 if(process.platform!=='win32'||process.arch!=='x64')throw Error('PRODUCTION_WINDOWS_X64_REQUIRED');
 const config=productionPublicConfig(JSON.parse(await readFile(publicConfigPath,'utf8'))),updates=validateUpdateConfig(JSON.parse(await readFile(updateConfigPath,'utf8')));
 const capability=JSON.parse(await readFile(resolve(root,'apps/pos/src-tauri/capabilities/pos.json'),'utf8'));
 const overlay=productionInstallerConfiguration(version,updates,capability);
 if(!process.env.TAURI_SIGNING_PRIVATE_KEY)throw Error('PRODUCTION_UPDATER_SIGNING_KEY_REQUIRED');
 const out=resolve(root,'scratch/windows-production-distribution',version);await mkdir(out,{recursive:true});
 const overlayPath=resolve(out,'tauri.production.json');await stable(overlayPath,JSON.stringify(overlay,null,2)+'\n');
 const clientPath=resolve(out,'public-production-config.json');await stable(clientPath,JSON.stringify(config,null,2)+'\n');
 const env={...process.env,TAURI_CONFIG:JSON.stringify(overlay),VENTARD_PRODUCTION_PUBLIC_CONFIG:JSON.stringify(config),VENTARD_UPDATE_URL:updates.endpoint,VENTARD_UPDATE_PUBLIC_KEY:updates.publicKey,VENTARD_UPDATE_DOWNLOAD_ORIGIN:updates.downloadOrigin};
 for(const k of Object.keys(env))if(k.startsWith('VENTARD_QA_')||k.startsWith('VENTARD_NATIVE_STAGING_'))delete env[k];
 const features='production-pilot,custom-protocol,signed-updates';
 await run(process.execPath,[resolve(root,'node_modules/typescript/bin/tsc'),'--noEmit'],resolve(root,'apps/pos'),env);
 await run(process.execPath,[resolve(root,'node_modules/vite/bin/vite.js'),'build'],resolve(root,'apps/pos'),env);
 await run('cargo',['rustc','--release','-p','ventard-pos','--bin','ventard-pos','--features',features,'--locked','--','-C','extra-filename=-production-delivery'],root,env);
 const binary=resolve(root,'target/release/VentaRD.exe');await copyFile(resolve(root,'target/release/deps/ventard_pos-production-delivery.exe'),binary);
 await run(process.execPath,[resolve(root,'node_modules/@tauri-apps/cli/tauri.js'),'bundle','--bundles','nsis','--features',features,'--config',overlayPath,'--ci','--no-binary-patching'],resolve(root,'apps/pos'),env);
 const bundles=resolve(root,'target/release/bundle/nsis'),names=(await readdir(bundles)).filter(n=>n.includes('_'+version+'_')&&n.endsWith('-setup.exe'));if(names.length!==1)throw Error('PRODUCTION_INSTALLER_ARTIFACT_AMBIGUOUS');
 const installer=resolve(out,names[0]);await copyFile(resolve(bundles,names[0]),installer);await copyFile(resolve(bundles,names[0]+'.sig'),installer+'.sig');
 const manifest={protocol:'ventard.windows.production.package.1',version,channel:'PRODUCTION_PILOT',identifier:'com.ventard.pos',installedBinary:'VentaRD.exe',projectRef:productionTarget.projectRef,tenants:[productionTarget.tenantId],architecture:'x86_64',build:'release',updateMode:'SIGNED_UPDATER',fiscal:'DISABLED',installer:{file:names[0],bytes:(await stat(installer)).size,sha256:await digest(installer)},binarySha256:await digest(binary),publicConfigSha256:await digest(clientPath),updatePublicKeySha256:createHash('sha256').update(updates.publicKey).digest('hex')};
 await stable(resolve(out,'package.json'),JSON.stringify(manifest,null,2)+'\n');console.log('PRODUCTION_PILOT_PACKAGE_BUILT_LOCALLY; NOT_INSTALLED_OR_PUBLISHED');return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const names={'--version':'version','--public-config':'publicConfigPath','--updates':'updateConfigPath'},options={};
 for(let i=2;i<process.argv.length;i+=2){const k=names[process.argv[i]];if(!k||!process.argv[i+1])throw Error('PRODUCTION_PACKAGE_ARGUMENT_INVALID');options[k]=process.argv[i+1]}
 if(Object.keys(options).length!==3)throw Error('PRODUCTION_PACKAGE_CONFIG_REQUIRED');
 packageWindowsProduction(options).catch(()=>{console.error('PRODUCTION_PACKAGE_FAILED; no credentials emitted');process.exitCode=1});
}
