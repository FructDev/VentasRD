// Local preparation/build only; never deploys, authenticates or reads business
// data. Only public Supabase settings are selected from the local environment.
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {resolve} from 'node:path';import {parseEnv} from 'node:util';import {createHash} from 'node:crypto';
import {prepareSigningCustody,readSecret} from './signing-custody.mjs';
import {productionPublicConfig,productionTarget,packageWindowsProduction} from './package-windows-production.mjs';
import {validateUpdateConfig,prepareRelease} from './desktop-release.mjs';
const root=resolve(import.meta.dirname,'../..');
export function publicProductionEnvironment(text){
 const env=parseEnv(text);
 if(env.NEXT_PUBLIC_SUPABASE_URL!=='https://'+productionTarget.projectRef+'.supabase.co'||!env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)throw Error('PRODUCTION_PUBLIC_ENV_REQUIRED');
 return env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
}
async function stable(path,body){try{await writeFile(path,body,{flag:'wx'})}catch(e){if(e.code!=='EEXIST'||await readFile(path,'utf8')!==body)throw Error('PRODUCTION_LOCAL_CONFIG_DIFFERS')}}
export async function buildProductionLocal({version='0.1.9',prepareOnly=false}={}){
 const publishableKey=publicProductionEnvironment(await readFile(resolve(root,'.env.local'),'utf8'));
 await mkdir(resolve(root,'scratch'),{recursive:true});
 const custody=resolve(root,'scratch/production-signing'),keys=await prepareSigningCustody(custody);
 const publicConfig=productionPublicConfig({publishableKey,keyId:keys.keyId,publicHex:keys.grantPublicHex,issuerUrl:productionTarget.issuerUrl,webOrigin:productionTarget.webOrigin});
 const updates=validateUpdateConfig({channel:'production',endpoint:productionTarget.webOrigin+'/api/native/releases/windows-x86_64',downloadOrigin:productionTarget.webOrigin,publicKey:keys.updaterPublicKey});
 const publicConfigPath=resolve(root,'scratch/production-public-config.json'),updateConfigPath=resolve(root,'scratch/production-updates.json');
 await stable(publicConfigPath,JSON.stringify(publicConfig,null,2)+'\n');await stable(updateConfigPath,JSON.stringify(updates,null,2)+'\n');
 if(prepareOnly){console.log('PRODUCTION_LOCAL_PUBLIC_CONFIG_READY; PRIVATE_KEYS_DPAPI_PROTECTED; NOT_UPLOADED');return}
 const secret=await readSecret(custody,'production-updater'),previous=process.env.TAURI_SIGNING_PRIVATE_KEY,previousPassword=process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
 try{
  process.env.TAURI_SIGNING_PRIVATE_KEY=secret.toString().trim();process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD='';process.env.CARGO_INCREMENTAL='0';
  let manifest;try{manifest=JSON.parse(await readFile(resolve(root,'scratch/windows-production-distribution',version,'package.json'),'utf8'))}catch(e){if(e.code!=='ENOENT')throw Error('PRODUCTION_EXISTING_PACKAGE_INVALID')}
  if(manifest){
   const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
   if(manifest.version!==version||manifest.publicConfigSha256!==hash(await readFile(publicConfigPath))||manifest.updatePublicKeySha256!==hash(updates.publicKey))throw Error('PRODUCTION_EXISTING_PACKAGE_CONFIG_CHANGED');
  }else manifest=await packageWindowsProduction({version,publicConfigPath,updateConfigPath});
  const directory=resolve(root,'scratch/windows-production-distribution',version),installerPath=resolve(directory,manifest.installer.file);
  await prepareRelease({manifestPath:resolve(directory,'package.json'),installerPath,signaturePath:installerPath+'.sig',updateConfigPath,url:productionTarget.webOrigin+'/downloads/windows-x86_64/'+version+'/'+encodeURIComponent(manifest.installer.file),outputPath:resolve(root,'scratch/production-release.json')});
  console.log('PRODUCTION_CANDIDATE_VERIFIED_LOCALLY; NOT_PUBLISHED_OR_ACTIVATED');return manifest;
 }finally{
  secret.fill(0);if(previous===undefined)delete process.env.TAURI_SIGNING_PRIVATE_KEY;else process.env.TAURI_SIGNING_PRIVATE_KEY=previous;
  if(previousPassword===undefined)delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;else process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD=previousPassword;
 }
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 if(process.argv.slice(2).some(v=>v!=='--prepare-only'))throw Error('PRODUCTION_LOCAL_ARGUMENT_INVALID');
 buildProductionLocal({prepareOnly:process.argv.includes('--prepare-only')}).catch(()=>{console.error('PRODUCTION_LOCAL_BUILD_FAILED; no private material emitted');process.exitCode=1});
}
