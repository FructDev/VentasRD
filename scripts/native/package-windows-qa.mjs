// Creates a local QA installer only. No installation, publishing, signing keys,
// accounts, database access or production configuration is performed here.
import {readFile,writeFile,mkdir,copyFile,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateUpdateConfig} from './desktop-release.mjs';
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const project='blzzinivvzadqjbnpsre';
const hostedIssuer='https://blzzinivvzadqjbnpsre.supabase.co/functions/v1/native-provision-staging';
export function validatePublicConfig(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['publishableKey','keyId','publicHex','issuerUrl','webOrigin'].includes(k)))throw Error('QA_PUBLIC_CONFIG_FIELDS_INVALID');
 const key=value.publishableKey;
 let publicKey=typeof key==='string'&&/^sb_publishable_[A-Za-z0-9_-]{1,480}$/.test(key);
 if(!publicKey&&typeof key==='string'&&key.length<2048){try{const claims=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString());publicKey=claims.role==='anon'&&claims.ref===project}catch{/* reject */}}
 if(!publicKey||!['http://127.0.0.1:3107/api/native/provision',hostedIssuer].includes(value.issuerUrl)||!/^[-A-Za-z0-9_]{1,128}$/.test(value.keyId??'')||!(/^[a-f0-9]{64}$/.test(value.publicHex??''))||/^0+$/.test(value.publicHex))throw Error('QA_PUBLIC_CONFIG_INVALID');
 if(value.webOrigin!=null){let parsed;try{parsed=new URL(value.webOrigin)}catch{throw Error('QA_WEB_ORIGIN_INVALID')}
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash||parsed.origin!==value.webOrigin)throw Error('QA_WEB_ORIGIN_INVALID');
 }
 return structuredClone(value);
}
export function installerConfiguration(version,publicConfigPath,updates){
 if(!/^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/.test(version))throw Error('QA_PACKAGE_VERSION_INVALID');
 if(updates){validateUpdateConfig(updates);if(updates.channel!=='staging')throw Error('QA_UPDATE_CHANNEL_INVALID')}
 return{productName:'VentaRD QA',version,identifier:'com.ventard.pos.qa',mainBinaryName:'VentaRD-QA',
  ...(updates?{plugins:{updater:{pubkey:updates.publicKey,requireSignedVersion:true,windows:{installMode:'passive'}}}}:{}),
  build:{beforeBuildCommand:null,beforeBundleCommand:null},
  bundle:{active:true,targets:['nsis'],createUpdaterArtifacts:Boolean(updates),category:'Business',shortDescription:'VentaRD · pruebas Staging y piloto acotado',
   resources:{[resolve(publicConfigPath)]:'public-staging-config.json'},
   windows:{allowDowngrades:false,webviewInstallMode:{type:'downloadBootstrapper',silent:true},nsis:{installMode:'currentUser',languages:['Spanish'],displayLanguageSelector:false,compression:'lzma',startMenuFolder:'VentaRD',installerHooks:resolve(repository,'apps/pos/src-tauri/windows/installer-hooks.nsh')}}}};
}
async function writeStable(path,body){try{await writeFile(path,body,{flag:'wx'})}catch(e){if(e.code!=='EEXIST'||await readFile(path,'utf8')!==body)throw Error('QA_PACKAGE_OUTPUT_ALREADY_DIFFERS')}}
async function run(file,args,cwd,env=process.env){await new Promise((ok,fail)=>{const child=spawn(file,args,{cwd,env,stdio:'inherit',windowsHide:true});child.once('error',fail);child.once('exit',code=>code===0?ok():fail(Error('QA_PACKAGE_COMMAND_FAILED')))})}
const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
export async function packageWindowsQa({version,publicConfigPath,issuer,updateConfigPath}){
 if(process.platform!=='win32'||process.arch!=='x64')throw Error('QA_PACKAGE_WINDOWS_X64_REQUIRED');
 const config=validatePublicConfig(JSON.parse(await readFile(resolve(publicConfigPath),'utf8')));
 if(issuer!==undefined){if(issuer!=='staging-edge')throw Error('QA_PACKAGE_ISSUER_INVALID');config.issuerUrl=hostedIssuer}
 const out=resolve(repository,'scratch/windows-qa-distribution',version);
 const clientPath=resolve(out,'public-staging-config.json');
 const updates=updateConfigPath?validateUpdateConfig(JSON.parse(await readFile(updateConfigPath,'utf8'))):null;
 const overlay=installerConfiguration(version,clientPath,updates);
 const features='qa-spike,custom-protocol'+(updates?',signed-updates':'');
 const env={...process.env,TAURI_CONFIG:JSON.stringify(overlay)};
 // Prevent inherited production/update settings from leaking into a QA build.
 delete env.VENTARD_PRODUCTION_PUBLIC_CONFIG;delete env.VENTARD_UPDATE_URL;delete env.VENTARD_UPDATE_PUBLIC_KEY;delete env.VENTARD_UPDATE_DOWNLOAD_ORIGIN;
 if(updates){if(!env.TAURI_SIGNING_PRIVATE_KEY)throw Error('QA_UPDATER_SIGNING_KEY_REQUIRED');Object.assign(env,{VENTARD_UPDATE_URL:updates.endpoint,VENTARD_UPDATE_PUBLIC_KEY:updates.publicKey,VENTARD_UPDATE_DOWNLOAD_ORIGIN:updates.downloadOrigin})}
 await mkdir(out,{recursive:true});
 await writeStable(clientPath,JSON.stringify(config,null,2)+'\n');
 const overlayPath=resolve(out,'tauri.qa.json');await writeStable(overlayPath,JSON.stringify(overlay,null,2)+'\n');
 await run(process.execPath,[resolve(repository,'node_modules/typescript/bin/tsc'),'--noEmit'],resolve(repository,'apps/pos'));
 await run(process.execPath,[resolve(repository,'node_modules/vite/bin/vite.js'),'build'],resolve(repository,'apps/pos'));
 // Keep the running debug executable and its profiles intact. The bundler gets
 // its own compiled binary with the same stable installed filename every time.
 await run('cargo',['rustc','-p','ventard-pos','--bin','ventard-pos','--features',features,'--locked','--','-C','extra-filename=-delivery'],repository,env);
 const compiled=resolve(repository,'target/debug/deps/ventard_pos-delivery.exe');
 const packagedBinary=resolve(repository,'target/debug/VentaRD-QA.exe');
 await copyFile(compiled,packagedBinary);
 await run(process.execPath,[resolve(repository,'node_modules/@tauri-apps/cli/tauri.js'),'bundle','--debug','--bundles','nsis','--features',features,'--config',overlayPath,'--ci',...(updates?[]:['--no-sign']),'--no-binary-patching'],resolve(repository,'apps/pos'),env);
 const bundles=resolve(repository,'target/debug/bundle/nsis');
 const names=(await readdir(bundles)).filter(n=>n.includes('_'+version+'_')&&n.endsWith('-setup.exe'));
 if(names.length!==1)throw Error('QA_INSTALLER_ARTIFACT_AMBIGUOUS');
 const installer=resolve(out,names[0]);await copyFile(resolve(bundles,names[0]),installer);
 if(updates)await copyFile(resolve(bundles,names[0]+'.sig'),installer+'.sig');
 const manifest={protocol:'ventard.windows.qa.package.1',version,channel:'STAGING_BOUNDED_PILOT',tenants:['96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002','96000000-0000-4000-8000-000000000003'],identifier:overlay.identifier,installedBinary:overlay.mainBinaryName+'.exe',architecture:'x86_64',build:'debug-qa',updateMode:updates?'SIGNED_UPDATER':'REINSTALL_SAME_IDENTITY',...(updates?{updatePublicKeySha256:createHash('sha256').update(updates.publicKey).digest('hex')}:{}),signing:'UNSIGNED_QA',issuer:config.issuerUrl===hostedIssuer?'HOSTED_STAGING':'LOCAL_DEVELOPMENT_REQUIRED',installer:{file:names[0],bytes:(await stat(installer)).size,sha256:await digest(installer)},binarySha256:await digest(packagedBinary),publicConfigSha256:await digest(clientPath)};
 await writeFile(resolve(out,'package.json'),JSON.stringify(manifest,null,2)+'\n');
 const accessDescription=manifest.issuer==='HOSTED_STAGING'?'Requiere que native-provision-staging esté desplegada y configurada con la misma clave verificada en Staging. No necesita el servidor local.':'Requiere conexión al emisor de desarrollo existente en este equipo.';
 await writeFile(resolve(out,'LEEME.txt'),`VentaRD QA ${version} · sólo Staging: QA A/B y piloto acotado\n\nInstala para el usuario actual de Windows. El asistente descarga WebView2 si falta.\nPara actualizar, cierra VentaRD y ejecuta el instalador más reciente de este mismo canal, sin desinstalar antes. La identidad de aplicación y la carpeta de datos se conservan; no se admite instalar una versión anterior.\n${accessDescription} El acceso requiere sesión humana, permisos y PIN. El instalador no incluye usuarios, contraseñas, bases ni licencias.\nEste paquete QA no tiene firma comercial y no habilita producción. ${updates?'Incluye el actualizador firmado del canal Staging configurado.':'La actualización es manual mediante el instalador; no hay servidor de actualizaciones configurado.'}\n`);
 console.log(JSON.stringify({status:'QA_WINDOWS_INSTALLER_BUILT',directory:out,manifest},null,2));
 return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options={};for(let i=2;i<process.argv.length;i+=2){const name=process.argv[i],value=process.argv[i+1];if(!['--version','--public-config','--issuer','--updates'].includes(name)||!value)throw Error('QA_PACKAGE_ARGUMENT_INVALID');options[name==='--version'?'version':name==='--issuer'?'issuer':name==='--updates'?'updateConfigPath':'publicConfigPath']=value}
 if(!options.version||!options.publicConfigPath)throw Error('QA_PACKAGE_VERSION_AND_PUBLIC_CONFIG_REQUIRED');
 packageWindowsQa(options).catch(()=>{console.error('QA_PACKAGE_FAILED; no credentials emitted');process.exitCode=1});
}
