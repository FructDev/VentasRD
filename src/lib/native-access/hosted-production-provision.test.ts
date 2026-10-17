import {describe,it,expect} from 'vitest';
import {generateKeyPairSync,verify} from 'node:crypto';
import {createHostedProductionProvision} from './hosted-production-provision';
import {canonicalGrant} from './provision-handler';
const keys=generateKeyPairSync('ed25519'),project='https://oxbekqoecunsbjheqgqg.supabase.co';
const input={registrationId:'96000000-0000-4000-8000-000000000010',tenantId:'864d08e5-2975-4b2d-a1e2-ba5a14f3d677',deviceId:'96000000-0000-4000-8000-000000000011',installationId:'96000000-0000-4000-8000-000000000012',scopeType:'GLOBAL',branchId:null};
const actor='96000000-0000-4000-8000-000000000051';
const env={SUPABASE_URL:project,VENTARD_NATIVE_ENV:'production',VENTARD_NATIVE_PRODUCTION_URL:project,VENTARD_NATIVE_PRODUCTION_PUBLISHABLE_KEY:'sb_publishable_fixture',VENTARD_NATIVE_PRODUCTION_GRANT_KEY_ID:'production-fixture',VENTARD_NATIVE_PRODUCTION_GRANT_PRIVATE_KEY_PEM:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString()};
const request=(body:unknown=input,token='fixture-token')=>new Request(project+'/functions/v1/native-provision',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});
function fixture(role='owner'){
 const calls:{url:string;method:string;headers:Headers;body:unknown}[]=[];
 const http=async(url:string,init?:RequestInit)=>{
  const headers=new Headers(init?.headers);calls.push({url,method:init?.method??'GET',headers,body:init?.body?JSON.parse(String(init.body)):null});
  if(url===project+'/auth/v1/user')return headers.get('authorization')==='Bearer fixture-token'?Response.json({id:actor,is_anonymous:false}):Response.json({message:'bad token'},{status:401});
  if(url===project+'/rest/v1/rpc/native_registrar_instalacion_v1')return Response.json({...input,actorId:actor,writerEpoch:'1',grantSequence:'1',role,issuedAtMs:'1000',license:{planActive:true,planTier:'pro',accessUntilMs:null,trialUntilMs:null}});
  throw Error('UNEXPECTED_DESTINATION');
 };
 return{calls,http};
}
describe('hosted production provision (isolated HTTP fixture), same handler and authenticated registration',()=>{
 it('public health exposes only matching public metadata without Auth or registration calls',async()=>{
  const f=fixture(),r=await createHostedProductionProvision(env,f.http)(new Request(project+'/functions/v1/native-provision'));
  expect(r.status).toBe(200);const health=await r.json();expect(health.projectRef).toBe('oxbekqoecunsbjheqgqg');expect(health.keyId).toBe(env.VENTARD_NATIVE_PRODUCTION_GRANT_KEY_ID);
  expect(health.publicHex).toBe(keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'));expect(f.calls).toHaveLength(0);expect(await JSON.stringify(health)).not.toMatch(/PRIVATE KEY|fixture-token/);
 });
 it('authenticates the user before registration and produces the existing verifiable wire',async()=>{
  const f=fixture(),r=await createHostedProductionProvision(env,f.http)(request());expect(r.status).toBe(200);const wire=await r.json();
  expect(verify(null,Buffer.from(canonicalGrant(wire.payload)),keys.publicKey,Buffer.from(wire.signature,'hex'))).toBe(true);expect(wire.payload.role).toBe('owner');expect(wire.payload.audience).toBe('ventard.native.production.v1');
  expect(f.calls.map(c=>c.url)).toEqual([project+'/auth/v1/user',project+'/rest/v1/rpc/native_registrar_instalacion_v1']);
  expect(f.calls.every(c=>c.headers.get('apikey')==='sb_publishable_fixture'&&c.headers.get('authorization')==='Bearer fixture-token')).toBe(true);
  expect(JSON.stringify(wire)).not.toMatch(/PRIVATE KEY|fixture-token/);expect(f.calls[1].body).toMatchObject({p_registration_id:input.registrationId,p_installation_id:input.installationId});
 });
 it('invalid session and client-selected capabilities never reach registration',async()=>{
  const f=fixture(),handler=createHostedProductionProvision(env,f.http);expect((await handler(request(input,'invalid-token'))).status).toBe(401);expect(f.calls).toHaveLength(1);
  f.calls.length=0;expect((await handler(request({...input,capabilities:['MANAGE']}))).status).toBe(400);expect(f.calls).toHaveLength(0);
 });
 it('another deployment project, missing key or production environment stay disabled',async()=>{
  for(const patch of [{SUPABASE_URL:'https://another-project.supabase.co'},{VENTARD_NATIVE_PRODUCTION_GRANT_PRIVATE_KEY_PEM:''},{VENTARD_NATIVE_ENV:'staging'}]){
   const f=fixture(),handler=createHostedProductionProvision({...env,...patch},f.http);expect((await handler(request())).status).toBe(503);expect((await handler(new Request(project))).status).toBe(503);expect(f.calls).toHaveLength(0);
  }
 });
 it('cashier receives only existing POS capabilities from the verified receipt',async()=>{
  const f=fixture('cajero'),wire=await(await createHostedProductionProvision(env,f.http)(request())).json();expect(wire.payload.role).toBe('cashier');expect(wire.payload.capabilities).toEqual(['READ','SELL']);
 });
});
