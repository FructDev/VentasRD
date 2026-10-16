// Engine acceptance with public RFC8032 signing fixture, fake HTTP responses
// and zero network/credentials/database access. Not a live Supabase session.
import {createPrivateKey,createPublicKey,verify} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {createHostedStagingProvision} from '../../../src/lib/native-access/hosted-provision.ts';
import {canonicalGrant} from '../../../src/lib/native-access/provision-handler.ts';
const project='https://blzzinivvzadqjbnpsre.supabase.co';
const key=createPrivateKey({format:'der',type:'pkcs8',key:Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60','hex')});
const env={SUPABASE_URL:project,VENTARD_NATIVE_ENV:'staging',VENTARD_NATIVE_STAGING_URL:project,VENTARD_NATIVE_STAGING_PUBLISHABLE_KEY:'sb_publishable_fixture',VENTARD_NATIVE_GRANT_KEY_ID:'deno-synthetic-rfc8032',VENTARD_NATIVE_GRANT_PRIVATE_KEY_PEM:key.export({format:'pem',type:'pkcs8'}).toString()};
const input={registrationId:'96000000-0000-4000-8000-000000000010',tenantId:'96000000-0000-4000-8000-000000000001',deviceId:'96000000-0000-4000-8000-000000000011',installationId:'96000000-0000-4000-8000-000000000012',scopeType:'GLOBAL',branchId:null};
const actor='96000000-0000-4000-8000-000000000051';
const check=(value:unknown,message:string)=>{if(!value)throw Error(message)};
const request=(body:unknown=input)=>new Request(project+'/functions/v1/native-provision-staging',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer explicitly-synthetic-token'},body:JSON.stringify(body)});
Deno.test('Deno hosted issuer: public health, async signature, cashier isolation and exact replay',async()=>{
 const calls:string[]=[];
 const handler=createHostedStagingProvision(env,async(url,init)=>{
  calls.push(url);check(new Headers(init?.headers).get('authorization')==='Bearer explicitly-synthetic-token','USER_AUTH_NOT_FORWARDED');
  if(url===project+'/auth/v1/user')return Response.json({id:actor,is_anonymous:false});
  check(url===project+'/rest/v1/rpc/native_registrar_instalacion_v1','FOREIGN_DESTINATION');
  return Response.json({...input,actorId:actor,writerEpoch:'1',grantSequence:'1',role:'cajero',issuedAtMs:'1000',license:{planActive:true,planTier:'pro',accessUntilMs:null,trialUntilMs:null}});
 });
 const health=await(await handler(new Request(project))).json();check(health.publicHex==='d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a','HEALTH_KEY_CHANGED');check(calls.length===0,'HEALTH_DID_AUTH');
 const response=await handler(request());check(response.status===200,'SIGNING_FAILED');const text=await response.text(),wire=JSON.parse(text);
 check(verify(null,Buffer.from(canonicalGrant(wire.payload)),createPublicKey(key),Buffer.from(wire.signature,'hex')),'SIGNATURE_INVALID');
 check(wire.payload.role==='cashier'&&wire.payload.capabilities.join(',')==='READ,SELL','ROLE_ESCALATED');
 check(await(await handler(request())).text()===text,'REPLAY_CHANGED');check(!text.includes('PRIVATE KEY')&&!text.includes('explicitly-synthetic-token'),'SECRET_LEAKED');
 check(calls.length===4,'UNEXPECTED_HTTP_CALLS');
});
Deno.test('Deno hosted issuer: foreign environment and anonymous callers cannot register',async()=>{
 let called=0;const http=async()=>{called++;return Response.json({message:'invalid'},{status:401})};
 const disabled=createHostedStagingProvision({...env,SUPABASE_URL:'https://production.test'},http);
 check((await disabled(request())).status===503,'FOREIGN_PROJECT_ENABLED');check(called===0,'FOREIGN_PROJECT_DID_HTTP');
 const handler=createHostedStagingProvision(env,http);check((await handler(request())).status===401,'INVALID_USER_ACCEPTED');check(called===1,'INVALID_USER_REGISTERED');
 check((await handler(request({...input,role:'owner'}))).status===400,'RENDERER_ROLE_ACCEPTED');check(called===1,'BAD_BODY_DID_AUTH');
});
