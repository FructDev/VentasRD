// PostgreSQL embedded engine, synthetic isolated database. NOT deployed RLS.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const tenant='96000000-0000-4000-8000-000000000001',other='96000000-0000-4000-8000-000000000002';
const id=n=>`96100000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=id(1),device=id(2),installation=id(3),branch=id(4);
const request=(n,changes={})=>Object.fromEntries(Object.entries({version:'2',requestId:id(n),tenantId:tenant,actorId:actor,deviceId:device,installationId:installation,writerEpoch:'1',scopeType:'BRANCH',branchId:branch,kind:'B02',quantity:'20',...changes}).sort(([a],[b])=>a.localeCompare(b)));
const hash=r=>createHash('sha256').update(JSON.stringify(r)).digest('hex');
async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table public.negocios(id uuid primary key,nombre text not null,"dueño_id" uuid);
 create table public.sucursales(id uuid primary key,negocio_id uuid not null,nombre text);
 create table public.usuarios_negocio(id uuid primary key,negocio_id uuid,user_id uuid,rol text,activo boolean);
 create table public.ncf_secuencias(negocio_id uuid primary key,tipo text not null,desde bigint not null,hasta bigint not null,proximo bigint not null,habilitado boolean not null);
 insert into auth.users values('${actor}'),('${id(7)}'),('${id(8)}');
 insert into public.negocios values('${tenant}','PRO00 QA A - SINTETICO','${actor}'),('${other}','PRO00 QA B - SINTETICO','${id(8)}');
 insert into public.sucursales values('${branch}','${tenant}','Synthetic');
 insert into public.usuarios_negocio values('${id(80)}','${tenant}','${id(7)}','vendedor',true);
 grant usage on schema auth,public to authenticated;grant execute on function auth.uid() to authenticated;`);
 await db.exec(await readFile(new URL('../../supabase/migrations/20261009180752_native_provision_v1.sql',import.meta.url),'utf8'));
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
 await db.query(`select public.native_registrar_instalacion_v1($1,$2,$3,$4,'BRANCH',$5)`,[id(9),tenant,installation,device,branch]);
 await db.exec(`insert into public.ncf_secuencias values('${tenant}','B02',1,1000,1,true);set role authenticated;`);
 if(process.env.VENTARD_FISCAL_RED!=='1') {
  await db.exec('reset role');
  const migration=await readFile(new URL('../../supabase/migrations/20261010134537_native_fiscal_allocation_v2.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration); // Idempotent DDL replay.
  await db.exec('set role authenticated');
 }
 return db;
}
async function rpc(db,name,r,h=hash(r)){return (await db.query(`select public.${name}($1::jsonb,$2) as receipt`,[JSON.stringify(r),h])).rows[0].receipt;}
const allocate=(db,r,h)=>rpc(db,'native_fiscal_allocate_v2',r,h);
const lookup=(db,r,h)=>rpc(db,'native_fiscal_lookup_v2',r,h);
async function admin(db,sql){await db.exec('reset role');try{return (await db.exec(sql)).at(-1);}finally{await db.exec('set role authenticated');}}
test('NCF: lost reply/replay/lookup, v1-shared cursor, distinct installations and partial last block',async()=>{
 const db=await setup();try{
  const r=request(10),one=await allocate(db,r);
  assert.equal(one.first,'1');assert.equal(one.last,'20');assert.equal(one.payloadHash,hash(r));
  assert.deepEqual(await allocate(db,r),one);assert.deepEqual(await lookup(db,r),one);
  assert.equal((await admin(db,'select proximo from public.ncf_secuencias')).rows[0].proximo,21);
  assert.deepEqual(await lookup(db,request(11)),{status:'NOT_FOUND',requestId:id(11),payloadHash:hash(request(11))});
  // A v1 allocation holds/advances the exact same authoritative row, not a new sequence.
  await admin(db,'update public.ncf_secuencias set proximo=41');
  assert.equal((await allocate(db,request(12))).first,'41');
  await admin(db,`insert into public.native_installations_v1 values('${tenant}','${id(30)}','${id(31)}','GLOBAL',null,1,'${actor}','REGISTERED');insert into public.native_actor_sequences_v1 values('${tenant}','${id(30)}','${actor}',1)`);
  const global=request(13,{installationId:id(30),deviceId:id(31),scopeType:'GLOBAL',branchId:null});
  assert.equal((await allocate(db,global)).first,'61');
  await admin(db,'update public.ncf_secuencias set proximo=996');
  const last=await allocate(db,request(14));assert.equal(last.first,'996');assert.equal(last.last,'1000');
  const none=await allocate(db,request(15));assert.equal(none.status,'NO_BLOCK');assert.equal(none.reason,'EXHAUSTED');
  assert.deepEqual(await allocate(db,request(15)),none);
 }finally{await db.close();}
});
test('NCF: invalid hash/context/reused identity rejected with no counter or receipt mutation',async()=>{
 const db=await setup();try{
  for(const changes of [{quantity:'1'},{quantity:20},{tenantId:other},{branchId:id(99)},{actorId:id(8)},{writerEpoch:'2'},{scopeType:'GLOBAL'},{extra:'secret'},{deviceId:id(90)},{kind:'eCF'}]) {
   await assert.rejects(allocate(db,request(20,changes)));
  }
  await assert.rejects(allocate(db,request(20),'0'.repeat(64)));
  assert.equal((await admin(db,'select count(*) as n from public.native_fiscal_requests_v2')).rows[0].n,0);
  assert.equal((await admin(db,'select proximo from public.ncf_secuencias')).rows[0].proximo,1);
  const original=await allocate(db,request(20));
  await assert.rejects(allocate(db,request(20,{kind:'B01'})));
  await assert.rejects(lookup(db,request(20,{kind:'B01'})));
  assert.deepEqual(await lookup(db,request(20)),original);
 }finally{await db.close();}
});
test('NCF: NO_BLOCK does not fabricate fiscal configuration; unauthorized and revoked actors cannot recover',async()=>{
 const db=await setup();try{
  const no=await allocate(db,request(40,{kind:'B01'}));assert.equal(no.reason,'KIND_NOT_CONFIGURED');assert.equal(no.first,null);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(7)]);
  await admin(db,`insert into public.native_actor_sequences_v1 values('${tenant}','${installation}','${id(7)}',1)`);
  const seller=request(41,{actorId:id(7)});assert.equal((await allocate(db,seller)).status,'ALLOCATED');
  // Member cannot see another actor's ledger; no direct INSERT/UPDATE/DELETE.
  assert.equal((await db.query('select count(*) as n from public.native_fiscal_requests_v2')).rows[0].n,1);
  for(const sql of ['delete from public.native_fiscal_requests_v2','update public.native_fiscal_requests_v2 set payload_hash=payload_hash',`insert into public.native_fiscal_requests_v2 select * from public.native_fiscal_requests_v2`]) await assert.rejects(db.exec(sql));
  await admin(db,`update public.usuarios_negocio set activo=false where user_id='${id(7)}'`);
  await assert.rejects(lookup(db,seller));
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
  await admin(db,`update public.native_installations_v1 set status='REVOKED' where installation_id='${installation}'`);
  await assert.rejects(lookup(db,request(40,{kind:'B01'})));
 }finally{await db.close();}
});
test('NCF: receipt failure rolls back sequence; allocation failure never hides an applied block',async()=>{
 const db=await setup();try{
  await admin(db,`create function public.fail_receipt_fixture() returns trigger language plpgsql as $$begin raise exception 'synthetic storage failure';end$$;create trigger fail_receipt before insert on public.native_fiscal_requests_v2 for each row execute function public.fail_receipt_fixture()`);
  await assert.rejects(allocate(db,request(50)));
  assert.equal((await admin(db,'select proximo from public.ncf_secuencias')).rows[0].proximo,1);
  assert.equal((await admin(db,'select count(*) as n from public.native_fiscal_requests_v2')).rows[0].n,0);
 }finally{await db.close();}
});
