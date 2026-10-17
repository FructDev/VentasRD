// Real isolated PostgreSQL only. No remote accounts, grants or data.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inventorySetup,rpc,id,tenant,actor,branch,command,canon,hash} from './sales-fixtures.mjs';
const pilot='96000000-0000-4000-8000-000000000003',foreign='96000000-0000-4000-8000-000000000004';
const migration=new URL('../../supabase/migrations/20261017015558_native_pilot_cohort_staging_v1.sql',import.meta.url);
async function setup(){
 const db=await inventorySetup();await db.exec('reset role');
 await db.exec("create role service_role;alter table usuarios_negocio add nombre text default 'Fixture',add email text default 'fixture@example.test',add created_at timestamptz default now(),add invite_token uuid default gen_random_uuid();alter table auth.users add email text,add email_confirmed_at timestamptz;");
 for(const table of ['apartados','cajas','cortes_caja','devoluciones','gastos','movimientos_stock','reparaciones','venta_detalles','ventas'])await db.exec(`create table ${table}(id uuid primary key,negocio_id uuid,sucursal_id uuid,estado text)`);
 for(const file of ['20261012150846_native_service_plan_staging_v1.sql','20261013163641_native_web_reconciliation_staging_v1.sql','20261013180055_native_web_observation_legacy_types_staging_v1.sql','20261013211219_native_web_full_capture_staging_v1.sql','20261014004611_native_web_cutover_staging_v1.sql','20261014151242_native_legacy_cash_archive_staging_v1.sql','20261015013926_native_team_staging_v1.sql','20261015115206_native_web_resolution_staging_v1.sql','20261016015201_native_resolution_stock_timestamp_staging_v1.sql','20261016165440_native_web_shared_journal_staging_v1.sql'])await db.exec(await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'));
 if(process.env.VENTARD_PILOT_RED!=='1'){const sql=await readFile(migration,'utf8');await db.exec(sql);await db.exec(sql);}
 return db;
}
test('bounded pilot: DDL replay changes no data; only exact cohort and real active membership can register',async()=>{
 const db=await setup();try{
  assert.equal((await db.query('select count(*) n from negocios')).rows[0].n,2);
  assert.equal((await db.query('select count(*) n from native_staging_licenses_v1')).rows[0].n,2);
  await db.query('insert into negocios values($1,$2,$3),($4,$5,$3)',[pilot,'Comercial La Esquina — PILOTO STAGING',actor,foreign,'Foreign']);
  await db.query('insert into sucursales values($1,$2,$3)',[id(9100),pilot,'Principal']);
  await db.query("insert into native_staging_licenses_v1(negocio_id,plan_active,plan_tier) values($1,true,'pro')",[pilot]);
  await assert.rejects(db.query('insert into native_staging_licenses_v1(negocio_id) values($1)',[foreign]),/check constraint/);
  await db.exec('set role authenticated');
  assert.equal(await rpc(db,'native_member_role_v1',[pilot]),'owner');
  assert.equal(await rpc(db,'native_member_role_v1',[foreign]),null);
  const args=[id(9101),pilot,id(9102),id(9103),'BRANCH',id(9100)];
  const receipt=await rpc(db,'native_registrar_instalacion_v1',args);
  assert.equal(receipt.role,'owner');assert.equal(receipt.license.planTier,'pro');
  assert.deepEqual(await rpc(db,'native_registrar_instalacion_v1',args),receipt);
  await assert.rejects(rpc(db,'native_registrar_instalacion_v1',[id(9104),pilot,id(9105),id(9106),'BRANCH',branch]),/NATIVE_BRANCH_DENIED/);
  await db.exec('reset role');await db.query("insert into usuarios_negocio(id,negocio_id,user_id,rol,activo) values($1,$2,$3,'cajero',true)",[id(9110),pilot,id(7)]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(7)]);await db.exec('set role authenticated');
  assert.equal(await rpc(db,'native_member_role_v1',[pilot]),'cajero');
  await assert.rejects(rpc(db,'native_registrar_instalacion_v1',[id(9111),pilot,id(9112),id(9113),'BRANCH',id(9100)]),/NATIVE_OWNER_SETUP_REQUIRED/);
  assert.equal((await rpc(db,'native_registrar_instalacion_v1',[id(9114),pilot,id(9102),id(9103),'BRANCH',id(9100)])).role,'cajero');
  await db.exec('reset role');await db.query('update usuarios_negocio set activo=false where id=$1',[id(9110)]);await db.exec('set role authenticated');
  assert.equal(await rpc(db,'native_member_role_v1',[pilot]),null);
  await assert.rejects(rpc(db,'native_registrar_instalacion_v1',[id(9114),pilot,id(9102),id(9103),'BRANCH',id(9100)]),/NATIVE_TENANT_DENIED/);
  await db.exec('reset role;set role anon');await assert.rejects(rpc(db,'native_member_role_v1',[pilot]),/permission denied/);
  await db.exec('reset role');
  assert.equal((await db.query('select count(*) n from native_sales_ledger_v1')).rows[0].n,0);
  assert.equal((await db.query('select count(*) n from native_web_channels_v1')).rows[0].n,0);
 }finally{await db.close()}
});
test('bounded pilot: web and native keep exact intentions, concurrent stock deltas and replay on their own ledger',async()=>{
 const db=await setup();try{
  const b=id(9200),p=id(9201),i=id(9202),d=id(9203),registration=id(9204);
  await db.query('insert into negocios values($1,$2,$3)',[pilot,'Comercial La Esquina — PILOTO STAGING',actor]);
  await db.query('insert into sucursales values($1,$2,$3)',[b,pilot,'Principal']);
  await db.query("insert into native_staging_licenses_v1(negocio_id,plan_active,plan_tier) values($1,true,'pro')",[pilot]);
  await db.query('insert into productos(id,negocio_id,nombre,codigo_barras,precio_venta,costo,stock_actual,tasa_itbis,tipo,serializable,eliminado) values($1,$2,$3,$4,100,60,4,.18,$5,false,false)',[p,pilot,'Producto sintético','PILOTO-01','simple']);
  await db.query('insert into inventario_sucursales(sucursal_id,producto_id,stock_actual) values($1,$2,4)',[b,p]);
  await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-ventard-journal':'stock-merge-1'})]);
  await db.exec('set role authenticated');await rpc(db,'native_registrar_instalacion_v1',[registration,pilot,i,d,'BRANCH',b]);
  await rpc(db,'native_sales_activate_v1',[pilot,i,d,'1','BRANCH',b,'QA_SYNTHETIC_QUIESCED','0.18']);
  const w=await rpc(db,'native_web_enroll_v1',[pilot,id(9205),id(9206),b,id(9207)]);
  const c={tenantId:pilot,actorId:actor,installationId:id(9205),deviceId:id(9206),writerEpoch:w.writerEpoch,scopeType:'BRANCH',branchId:b,permissionGrantId:id(9207)};
  const sale=(n,installationId,deviceId,permissionGrantId)=>{
   const v=command(n);Object.assign(v.intent,{negocioId:pilot,installationId,originDeviceId:deviceId,permissionGrantId,scope:{type:'BRANCH',sucursalId:b}});
   const s=v.intent.payload.sale;s.lines[0].productId=p;s.inventory[0].productId=p;
   s.stockEvidence=[{productId:p,remoteBaseQty:'4',remoteSequence:'0',pending:[],effectiveQty:'4'}];s.inventory[0].expectedRevision=hash({quantity:'4',remoteSequence:'0',pending:[]});v.intent.payload.quoteHash=hash(s);
   Object.assign(v.snapshot,{tenantId:pilot,scope:{type:'BRANCH',branchId:b},ticket:'N'+installationId.replaceAll('-','')+'-'+String(n).padStart(6,'0')});return v;
  };
  const a=sale(9210,i,d,registration),web=sale(9211,c.installationId,c.deviceId,c.permissionGrantId);
  const ar=await rpc(db,'native_sales_submit_v1',[canon(a.intent),hash(a.intent),canon(a.snapshot),hash(a.snapshot)]);
  const args=[c,canon(web.intent),hash(web.intent),canon(web.snapshot),hash(web.snapshot)];
  const wr=await rpc(db,'native_web_submit_v1',args);assert.deepEqual(await rpc(db,'native_web_submit_v1',args),wr);
  assert.equal(ar.status,'APPLIED');assert.equal(wr.status,'APPLIED');
  const feed=await rpc(db,'native_sales_feed_v1',[pilot,i,d,'1','BRANCH',b,'0']);assert.equal(feed.events.length,2);
  assert.equal(feed.events.find(e=>e.receipt.operationId===web.intent.operationId).intent,canon(web.intent));
  await db.exec('reset role');
  assert.equal((await db.query('select stock_actual from inventario_sucursales where producto_id=$1',[p])).rows[0].stock_actual,2);
  assert.equal((await db.query('select count(*) n from native_sales_ledger_v1 where negocio_id=$1',[tenant])).rows[0].n,0);
  assert.equal((await db.query('select count(*) n from native_sales_ledger_v1 where negocio_id=$1 and ncf is not null',[pilot])).rows[0].n,0);
 }finally{await db.close()}
});
test('new Staging business: exact starter data, one branch, replay never resets stock or later work',async()=>{
 const db=await setup();try{
  // Minimal real-column compatibility; these users exist only in this engine.
  await db.exec("alter table negocios add onboarding_completado boolean,add tipo_negocio text,add direccion text,add nota_operador text,add plan_activo boolean,add plan_tier text,add acceso_hasta bigint,add trial_hasta bigint,add mensaje_ticket text,add catalogo_publico boolean;alter table sucursales add direccion text,add fecha_creacion bigint;alter table clientes add sucursal_id uuid;update auth.users set email='pro00-admin-a@example.test' where false;");
  const owner='a1d0532d-df26-43bf-b8b2-5a99de7ab101';
  await db.query('insert into auth.users(id,email) values($1,$2)',[owner,'pro00-admin-a@example.test']);
  await db.query("insert into usuarios_negocio(id,negocio_id,user_id,rol,activo) values($1,$2,$3,'admin',true)",[id(9300),tenant,owner]);
  const sql=await readFile(new URL('./create-staging-pilot.sql',import.meta.url),'utf8');
  const before=(await db.query('select jsonb_agg(to_jsonb(p) order by id) v from productos p where negocio_id=$1',[tenant])).rows[0].v;
  await db.exec(sql);await db.exec(sql);
  assert.equal((await db.query('select count(*) n from productos where negocio_id=$1',[pilot])).rows[0].n,12);
  assert.equal((await db.query('select sum(stock_actual) n from productos where negocio_id=$1',[pilot])).rows[0].n,312);
  assert.equal((await db.query('select count(*) n from clientes where negocio_id=$1',[pilot])).rows[0].n,2);
  assert.equal((await db.query('select count(*) n from sucursales where negocio_id=$1',[pilot])).rows[0].n,1);
  assert.equal((await db.query('select count(*) n from native_installations_v1 where negocio_id=$1',[pilot])).rows[0].n,0);
  assert.equal((await db.query('select count(*) n from ncf_secuencias where negocio_id=$1',[pilot])).rows[0].n,0);
  await db.query('update productos set stock_actual=1 where negocio_id=$1',[pilot]);await db.exec(sql);
  assert.equal((await db.query('select sum(stock_actual) n from productos where negocio_id=$1',[pilot])).rows[0].n,12);
  assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(p) order by id) v from productos p where negocio_id=$1',[tenant])).rows[0].v,before);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await db.exec('set role authenticated');
  assert.equal(await rpc(db,'native_member_role_v1',[pilot]),'owner');
 }finally{await db.close()}
});
