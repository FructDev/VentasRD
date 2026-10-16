// Same protocol and user-scoped RPC as the existing Node/loopback issuer.
// Deployment is disabled outside this exact synthetic Staging project.
import {createPublicKey} from 'node:crypto';
import {createProvisionHandler} from './provision-handler';
import {stagingDependencies,NATIVE_STAGING_URL} from './staging-dependencies';
type Environment=Record<string,string|undefined>;
type Http=(url:string,init?:RequestInit)=>Promise<Response>;
export function createHostedStagingProvision(env:Environment,http:Http=fetch){
 const dependencies=stagingDependencies({...env,VENTARD_NATIVE_ENV:env.SUPABASE_URL===NATIVE_STAGING_URL?env.VENTARD_NATIVE_ENV:undefined},http);
 const handler=createProvisionHandler(dependencies);
 return async(request:Request)=>{
  if(request.method!=='GET')return handler(request);
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  if(!dependencies.enabled||!dependencies.privateKey)return Response.json({code:'NATIVE_PROVISION_UNAVAILABLE'},{status:503,headers});
  const publicHex=createPublicKey(dependencies.privateKey).export({format:'der',type:'spki'}).subarray(-32).toString('hex');
  return Response.json({protocol:'ventard.native.provision.health.v1',projectRef:'blzzinivvzadqjbnpsre',keyId:dependencies.keyId,publicHex},{headers});
 };
}
