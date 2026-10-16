// Planning is read-only. Apply is exclusively for a specifically authorized
// deployment of this QA issuer, never the repository's default linked project.
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {createHash,createPrivateKey,createPublicKey,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validatePublicConfig} from './package-windows-qa.mjs';
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const projectRef='blzzinivvzadqjbnpsre';
const url=`https://${projectRef}.supabase.co`;
const functionName='native-provision-staging';
const files=['scripts/native/deploy-staging-issuer.mjs','scripts/native/package-windows-qa.mjs',
 'src/lib/native-access/hosted-provision.ts','src/lib/native-access/provision-handler.ts',
 'src/lib/native-access/staging-dependencies.ts','supabase/config.toml',
 'supabase/functions/native-provision-staging/index.ts',
 'supabase/functions/native-provision-staging/deno.json',
 'supabase/functions/native-provision-staging/deno.lock'];
const hash=value=>createHash('sha256').update(value).digest('hex');
export function deploymentPlan(config,sourceHashes,project=projectRef){
 if(project!==projectRef)throw Error('STAGING_PROJECT_REQUIRED');
 const validated=validatePublicConfig(config);
 if(!/^[A-Za-z0-9-]{1,64}$/.test(validated.keyId))throw Error('STAGING_KEY_ID_INVALID');
 const body={protocol:'ventard.staging.issuer.deployment.v1',projectRef,functionName,verifyJwt:false,
  issuerUrl:`${url}/functions/v1/${functionName}`,keyId:validated.keyId,publicHex:validated.publicHex,
  publicConfigSha256:hash(JSON.stringify(validated)),sourceHashes,
  secretNames:['VENTARD_NATIVE_ENV','VENTARD_NATIVE_STAGING_URL','VENTARD_NATIVE_STAGING_PUBLISHABLE_KEY','VENTARD_NATIVE_GRANT_KEY_ID','VENTARD_NATIVE_GRANT_PRIVATE_KEY_PEM']};
 return{...body,digest:hash(JSON.stringify(body))};
}
export function secretFileBody(config,der){
 const validated=validatePublicConfig(config);
 const key=createPrivateKey({key:der,type:'pkcs8',format:'der'});
 if(key.asymmetricKeyType!=='ed25519'||createPublicKey(key).export({type:'spki',format:'der'}).subarray(-32).toString('hex')!==validated.publicHex)throw Error('STAGING_SIGNING_TRUST_MISMATCH');
 const values={VENTARD_NATIVE_ENV:'staging',VENTARD_NATIVE_STAGING_URL:url,
  VENTARD_NATIVE_STAGING_PUBLISHABLE_KEY:validated.publishableKey,VENTARD_NATIVE_GRANT_KEY_ID:validated.keyId,
  VENTARD_NATIVE_GRANT_PRIVATE_KEY_PEM:key.export({type:'pkcs8',format:'pem'}).toString()};
 return Object.entries(values).map(([name,value])=>`${name}=${JSON.stringify(value)}`).join('\n')+'\n';
}
function command(file,args){return new Promise((ok,fail)=>{
 const child=spawn(file,args,{cwd:repository,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>{if(output.length<65536)output+=chunk});
 // Never forward CLI stderr: failures of secret upload must not echo secrets.
 child.stderr.on('data',()=>{});child.once('error',()=>fail(Error('STAGING_COMMAND_FAILED')));
 child.once('exit',code=>code===0?ok(output):fail(Error('STAGING_COMMAND_FAILED')));
});}
export async function verifyHostedIssuer(plan,publicKey,http=fetch){
 const requestOptions={headers:{apikey:publicKey},redirect:'error',signal:AbortSignal.timeout(20000)};
 const health=await http(plan.issuerUrl,requestOptions);
 if(health.status!==200)throw Error('STAGING_HEALTH_UNAVAILABLE');
 const actual=await health.json();
 if(actual.protocol!=='ventard.native.provision.health.v1'||actual.projectRef!==projectRef||actual.keyId!==plan.keyId||actual.publicHex!==plan.publicHex)throw Error('STAGING_HEALTH_TRUST_MISMATCH');
 const rejection=await http(plan.issuerUrl,{...requestOptions,method:'POST',headers:{apikey:publicKey,'Content-Type':'application/json'},body:JSON.stringify({registrationId:'96000000-0000-4000-8000-000000000010',tenantId:'96000000-0000-4000-8000-000000000002',deviceId:'96000000-0000-4000-8000-000000000011',installationId:'96000000-0000-4000-8000-000000000012',scopeType:'GLOBAL',branchId:null})});
 if(rejection.status!==401||(await rejection.json()).code!=='NATIVE_AUTH_REQUIRED')throw Error('STAGING_UNAUTHENTICATED_REJECTION_FAILED');
 return{health:'MATCHING_PUBLIC_TRUST',unauthenticatedPost:'REJECTED_WITHOUT_REGISTRATION'};
}
async function main(args){
 const options={};for(let i=0;i<args.length;i+=2){const name=args[i],value=args[i+1];
  if(!['--mode','--project-ref','--public-config','--expected-digest'].includes(name)||!value||options[name])throw Error('STAGING_ARGUMENT_INVALID');options[name]=value;
 }
 if(!options['--public-config']||!['plan','apply'].includes(options['--mode']??'plan')||options['--project-ref']!==projectRef)throw Error('STAGING_ARGUMENT_INVALID');
 const config=validatePublicConfig(JSON.parse(await readFile(resolve(options['--public-config']),'utf8')));
 const sourceHashes={};for(const file of files)sourceHashes[file]=hash(await readFile(resolve(repository,file)));
 const plan=deploymentPlan(config,sourceHashes,options['--project-ref']);
 if(options['--mode']!=='apply'){console.log(JSON.stringify(plan,null,2));return}
 if(!/^[a-f0-9]{64}$/.test(options['--expected-digest']??'')||options['--expected-digest']!==plan.digest)throw Error('STAGING_APPROVED_DIGEST_REQUIRED');
 const dirty=await command('git',['status','--porcelain','--',...files]);
 if(dirty.trim())throw Error('STAGING_COMMITTED_SOURCES_REQUIRED');
 for(const file of files)await command('git',['ls-files','--error-unmatch','--',file]);
 const npx=resolve(dirname(process.execPath),'node_modules/npm/bin/npx-cli.js');
 await command(process.execPath,[npx,'--offline','supabase','--version']);
 const keyDirectory=resolve(repository,'.env.native-staging-issuer');
 const body=secretFileBody(config,await readFile(resolve(keyDirectory,'private-key.der')));
 const temporary=resolve(keyDirectory,`hosted-deploy-${randomUUID()}.env`);
 // Same pre-existing protected directory as the QA key; never persist in scratch.
 await writeFile(temporary,body,{flag:'wx',mode:0o600});
 try{await command(process.execPath,[npx,'--offline','supabase','secrets','set','--project-ref',projectRef,'--workdir',repository,'--env-file',temporary]);}
 finally{await unlink(temporary)}
 await command(process.execPath,[npx,'--offline','supabase','functions','deploy',functionName,'--project-ref',projectRef,'--workdir',repository,'--use-api','--no-verify-jwt']);
 const verification=await verifyHostedIssuer(plan,config.publishableKey);
 console.log(JSON.stringify({status:'STAGING_ISSUER_DEPLOYED',digest:plan.digest,projectRef,functionName,verification}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(()=>{console.error('STAGING_ISSUER_NOT_CONFIRMED; no credentials emitted; inspect deployment before retrying');process.exitCode=1});
