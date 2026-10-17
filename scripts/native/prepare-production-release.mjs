// Review artifacts only. No Supabase connection, publishing, activation or keys.
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {createHash} from 'node:crypto';import {resolve} from 'node:path';
import {productionOperations,productionOperationsFile} from './prepare-production-operations.mjs';
import {productionTarget} from './package-windows-production.mjs';
const root=resolve(import.meta.dirname,'../..');
export async function prepareProductionRelease(){
 const names=['20261017125853_native_production_access_v1.sql',productionOperationsFile],migrations=[];
 for(const file of names){const sql=await readFile(resolve(root,'supabase/migrations',file),'utf8');if(file===productionOperationsFile&&sql!==await productionOperations())throw Error('PRODUCTION_MIGRATION_SOURCE_DRIFT');migrations.push({file,sha256:createHash('sha256').update(sql).digest('hex'),bytes:Buffer.byteLength(sql),sql})}
 const digest=createHash('sha256').update(migrations.map(m=>m.sha256).join(':')).digest('hex'),out=resolve(root,'scratch/production-release-review',digest.slice(0,16));
 await mkdir(resolve(out,'supabase/migrations'),{recursive:true});
 const stable=async(path,body)=>{try{await writeFile(path,body,{flag:'wx'})}catch(e){if(e.code!=='EEXIST'||await readFile(path,'utf8')!==body)throw Error('PRODUCTION_REVIEW_OUTPUT_DIFFERS')}};
 for(const m of migrations)await stable(resolve(out,'supabase/migrations',m.file),m.sql);
 await stable(resolve(out,'supabase/config.toml'),'project_id = "ventard-production-release-review"\n[db.seed]\nenabled = false\n');
 const manifest={protocol:'ventard.production.release.review.1',status:'LOCAL_PREPARATION_ONLY',projectRef:productionTarget.projectRef,business:'Pica Chicken',tenantId:productionTarget.tenantId,website:productionTarget.webOrigin,downloadPage:productionTarget.webOrigin+'/descargar',updateEndpoint:productionTarget.webOrigin+'/api/native/releases/windows-x86_64',migrations:migrations.map(({sql,...m})=>m),fiscal:'EXCLUDED',cohortEnabled:false,commercialRowsRead:false,productionMutationsExecuted:false,installerBuilt:false,releasePublished:false,rootDbPushAllowed:false,requiredBeforeDeployment:['Explicit production mutation/deployment authorization','Verified recoverable backup','Read migration history and ensure dry-run contains only these two versions; never repair or apply QA history implicitly','Distinct production grant/updater signing keys and reviewed public configuration','Build and verify signed production installer','Owner reviews cloud capture, closes old writers, verifies encrypted backup and confirms cutover in the app']};
 await stable(resolve(out,'review.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({status:manifest.status,directory:out,migrations:manifest.migrations},null,2));return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))await prepareProductionRelease();
