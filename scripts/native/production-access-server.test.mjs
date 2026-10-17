// Isolated PostgreSQL only; production is never contacted.
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
const owner='97000000-0000-4000-8000-000000000001',outsider='97000000-0000-4000-8000-000000000002',tenant='864d08e5-2975-4b2d-a1e2-ba5a14f3d677',other='97000000-0000-4000-8000-000000000004',installation='97000000-0000-4000-8000-000000000005',device='97000000-0000-4000-8000-000000000006',request='97000000-0000-4000-8000-000000000007';
const sql=await readFile(new URL('../../supabase/migrations/20261017125853_native_production_access_v1.sql',import.meta.url),'utf8');
async function setup(){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create table negocios(id uuid primary key,nombre text,"dueño_id" uuid,plan_activo boolean,plan_tier text,acceso_hasta bigint,trial_hasta bigint);create table sucursales(id uuid primary key,negocio_id uuid);create table usuarios_negocio(id uuid primary key,negocio_id uuid,user_id uuid,rol text,activo boolean);
insert into auth.users values('${owner}'),('${outsider}');insert into negocios values('${tenant}','Synthetic production-shape fixture','${owner}',true,'basico',1900000000000,null),('${other}','Other synthetic tenant','${outsider}',true,'pro',1900000000000,null);grant usage on schema public,auth to authenticated;grant execute on function auth.uid() to authenticated;`);await db.exec(sql);await db.exec(sql);return db}
const register=db=>db.query(`select public.native_registrar_instalacion_v1('${request}','${tenant}','${installation}','${device}','GLOBAL',null) as receipt`);
test('production access schema enables nobody, seeds no licence and reads real Basic entitlement only after explicit cohort approval',async()=>{const db=await setup();try{
 assert.equal((await db.query('select count(*) n from native_production_cohort_v1')).rows[0].n,0);
 assert.equal((await db.query("select to_regclass('public.native_staging_licenses_v1') as t")).rows[0].t,null);
 await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false);set role authenticated;`);
 await assert.rejects(register(db),/TENANT_DENIED/);
 assert.equal((await db.query('select * from native_entitlements_v1')).rows.length,0);
 await assert.rejects(db.exec(`insert into native_production_cohort_v1 values('${tenant}',true,now())`),/permission denied/);
 await db.exec(`reset role;insert into native_production_cohort_v1 values('${tenant}',true,now());set role authenticated;`);
 const first=(await register(db)).rows[0].receipt;assert.equal(first.license.planTier,'basico');assert.equal(first.license.accessUntilMs,'1900000000000');assert.deepEqual((await register(db)).rows[0].receipt,first);
 await db.exec(`reset role;update negocios set plan_tier='pro' where id='${tenant}';set role authenticated;`);
 await assert.rejects(register(db),/POLICY_CHANGED/);
 }finally{await db.close()}});
test('production access cannot borrow another tenant or another actor and never modifies the business licence',async()=>{const db=await setup();try{
 await db.exec(`insert into native_production_cohort_v1 values('${tenant}',true,now()),('${other}',true,now());select set_config('request.jwt.claim.sub','${outsider}',false);set role authenticated;`);
 await assert.rejects(register(db),/TENANT_DENIED/);
 assert.deepEqual((await db.query('select negocio_id from native_entitlements_v1')).rows,[{negocio_id:other}]);
 await db.exec('reset role');assert.deepEqual((await db.query(`select plan_activo,plan_tier,acceso_hasta from negocios where id='${tenant}'`)).rows,[{plan_activo:true,plan_tier:'basico',acceso_hasta:1900000000000}]);
 assert.equal((await db.query('select count(*) n from native_installations_v1')).rows[0].n,0);
 }finally{await db.close()}});
