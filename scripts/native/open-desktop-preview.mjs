// Runs the existing Next routes locally; never deploys or authenticates anyone.
import {readFile,open,writeFile} from 'node:fs/promises';import {spawn} from 'node:child_process';import {resolve} from 'node:path';
import {validatePublicConfig} from './package-windows-qa.mjs';
const root=resolve(import.meta.dirname,'../..'),url='http://127.0.0.1:3023/descargar';
if(process.argv.slice(2).some(arg=>arg!=='--serve'))throw Error('LOCAL_PREVIEW_ARGUMENT_INVALID');
async function ready(){try{const r=await fetch(url,{signal:AbortSignal.timeout(3000)});if(!r.ok)return false;return (await r.text()).includes('Revisión local en este PC.')}catch{return false}}
if(await ready()){console.log('DESKTOP_LOCAL_PREVIEW_READY '+url);process.exit(0)}
let config;for(const v of ['0.1.8','0.1.6']){try{config=validatePublicConfig(JSON.parse(await readFile(resolve(root,'scratch/windows-qa-distribution',v,'public-staging-config.json'),'utf8')));break}catch{/* exact existing public QA config only */}}
if(!config)throw Error('LOCAL_PREVIEW_STAGING_PUBLIC_CONFIG_REQUIRED');
const log=await open(resolve(root,'scratch/desktop-local-preview.log'),'a');
const env={...process.env,NEXT_PUBLIC_SUPABASE_URL:'https://blzzinivvzadqjbnpsre.supabase.co',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:config.publishableKey,SUPABASE_SERVICE_ROLE_KEY:'local-preview-no-service-authority',VENTARD_NATIVE_ENV:'disabled',NEXT_PUBLIC_VENTARD_SHARED_JOURNAL:'staging',NEXT_TELEMETRY_DISABLED:'1',SENTRY_AUTH_TOKEN:'',SENTRY_DSN:'',NEXT_PUBLIC_SENTRY_DSN:'',VENTARD_DESKTOP_WEB_FIXTURE:'1',VENTARD_DESKTOP_LOCAL_PREVIEW:'1',VENTARD_DESKTOP_RELEASE_JSON:'',NEXT_FONT_GOOGLE_MOCKED_RESPONSES:resolve(root,'scratch/shared-ui-fonts.cjs')};
for(const k of Object.keys(env))if(k==='TAURI_SIGNING_PRIVATE_KEY'||k==='TAURI_SIGNING_PRIVATE_KEY_PASSWORD'||k.includes('GRANT_PRIVATE_KEY'))delete env[k];
const child=spawn(process.execPath,[resolve(root,'node_modules/next/dist/bin/next'),'dev','--webpack','--hostname','127.0.0.1','--port','3023'],{cwd:root,env,windowsHide:true,stdio:['ignore',log.fd,log.fd]});await log.close();
await writeFile(resolve(root,'scratch/desktop-local-preview.json'),JSON.stringify({protocol:'ventard.local.preview.1',pid:child.pid,url,bind:'127.0.0.1',productionDeployment:false},null,2)+'\n');
for(let i=0;i<120;i++){if(child.exitCode!==null)throw Error('DESKTOP_PREVIEW_SERVER_EXITED');if(await ready()){console.log('DESKTOP_LOCAL_PREVIEW_READY '+url);await new Promise(r=>child.once('exit',r));process.exit(0)}await new Promise(r=>setTimeout(r,500))}
console.error('DESKTOP_LOCAL_PREVIEW_NOT_READY; see scratch/desktop-local-preview.log');process.exitCode=1;
