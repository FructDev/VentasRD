// Recreates authorized production SCHEMA only in isolated PostgreSQL.
// Every user/business/product below is synthetic. Never contacts production.
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
import {productionOperations,productionOperationsFile} from './prepare-production-operations.mjs';
import {actor,device,installation,branch,product,customer,grant,id,command,canon,hash} from './sales-fixtures.mjs';
const tenant='864d08e5-2975-4b2d-a1e2-ba5a14f3d677',qa='96000000-0000-4000-8000-000000000001';
const schema=JSON.parse(await readFile(new URL('./fixtures/production-schema-20261017.json',import.meta.url),'utf8'));
const access=await readFile(new URL('../../supabase/migrations/20261017125853_native_production_access_v1.sql',import.meta.url),'utf8');
const operations=await readFile(new URL('../../supabase/migrations/'+productionOperationsFile,import.meta.url),'utf8');
const fingerprints=await readFile(new URL('../../supabase/migrations/20261018020840_native_web_fingerprint_linear_v1.sql',import.meta.url),'utf8');
const enrollment=await readFile(new URL('./production-pica-enroll.sql',import.meta.url),'utf8');
const quote=value=>'"'+value.replaceAll('"','""')+'"';
async function setup(){
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to authenticated;grant execute on function auth.uid() to authenticated;`);
 const tables=[...new Set(schema.columns.map(c=>c.table))];
 for(const table of tables){
  const columns=schema.columns.filter(c=>c.table===table).map(c=>{assert.ok(['uuid','text','jsonb','numeric','int8','int2','int4','bool','timestamptz'].includes(c.udt));assert.ok(!c.default||!/[;]|--|\/\*/.test(c.default));return quote(c.column)+' '+c.udt+(c.nullable==='NO'?' not null':'')+(c.default?' default '+c.default:'')});
  await db.exec('create table public.'+quote(table)+'('+columns.join(',')+')');
 }
 for(const c of [...schema.constraints].sort((a,b)=>Number(a.definition.startsWith("FOREIGN KEY"))-Number(b.definition.startsWith("FOREIGN KEY")))){assert.match(c.definition,/^(PRIMARY KEY|FOREIGN KEY|CHECK|UNIQUE) /);assert.ok(!/[;]|--|\/\*/.test(c.definition));await db.exec('alter table '+quote(c.table.replace(/^public\./,''))+' add constraint '+quote(c.name)+' '+c.definition)}
 await db.exec(`insert into auth.users values('${actor}');insert into negocios(id,nombre,"dueño_id",plan_activo,plan_tier,acceso_hasta) values('${tenant}','SYNTHETIC production-shape fixture','${actor}',true,'basico',1900000000000);insert into sucursales(id,negocio_id,nombre,fecha_creacion)values('${branch}','${tenant}','Fixture',1791712800000);insert into productos(id,negocio_id,nombre,codigo_barras,precio_venta,costo,stock_actual,tasa_itbis,fecha_actualizacion)values('${product}','${tenant}','Producto sintético','0001',100,60,100,.18,1791712800000);insert into inventario_sucursales(sucursal_id,producto_id,stock_actual,fecha_actualizacion)values('${branch}','${product}',100,1791712800000);insert into clientes(id,negocio_id,nombre,limite_credito,fecha_actualizacion)values('${customer}','${tenant}','Cliente sintético',5000,1791712800000);`);
 await db.exec(access);await db.exec(operations);await db.exec(operations);await db.exec(fingerprints);await db.exec(fingerprints);
 return db;
 }catch(e){await db.close();const position=Number(e.position)||0;throw Error(JSON.stringify({message:e.message,code:e.code,where:e.where,near:e.query?.slice(Math.max(0,position-150),position+200)}))}
}
test('approved enrollment is idempotent, preserves businesses and enables only Pica without operations',async()=>{
 const db=await setup();try{
  await db.exec(`insert into negocios(id,nombre,"dueño_id",plan_activo,plan_tier,acceso_hasta) values('${qa}','Other synthetic business','${actor}',true,'pro',1900000000000)`);
  const before=(await db.query('select to_jsonb(n) as business from negocios n order by id')).rows;
  await db.exec(enrollment);const first=(await db.query('select * from native_production_cohort_v1')).rows;await db.exec(enrollment);
  assert.deepEqual((await db.query('select * from native_production_cohort_v1')).rows,first);assert.equal(first.length,1);assert.equal(first[0].negocio_id,tenant);
  assert.deepEqual((await db.query('select to_jsonb(n) as business from negocios n order by id')).rows,before);
  for(const table of ['native_sales_mode_v1','native_sales_ledger_v1','native_installations_v1'])assert.equal((await db.query('select count(*) n from '+table)).rows[0].n,0);
  await db.exec(`insert into native_production_cohort_v1 values('${qa}',true,now())`);await assert.rejects(db.exec(enrollment),/PICA_ONLY_PRODUCTION_COHORT_REQUIRED/);await db.exec('rollback');
 }finally{await db.close()}
});

test('production operations match reviewed sources, deploy twice on real-schema shapes without activation, licence changes or fiscal objects',async()=>{
 assert.equal(operations,await productionOperations());
 const db=await setup();try{
 assert.equal((await db.query('select count(*) n from native_production_cohort_v1')).rows[0].n,0);
 assert.equal((await db.query('select count(*) n from native_sales_mode_v1')).rows[0].n,0);
 assert.equal((await db.query('select count(*) n from native_sales_ledger_v1')).rows[0].n,0);
 assert.equal((await db.query("select to_regclass('public.native_fiscal_requests_v2') as t")).rows[0].t,null);
 assert.deepEqual((await db.query(`select plan_activo,plan_tier from negocios where id='${tenant}'`)).rows,[{plan_activo:true,plan_tier:'basico'}]);
 await db.exec(`select set_config('request.jwt.claim.sub','${actor}',false);set role authenticated;`);
 await assert.rejects(db.query(`select native_registrar_instalacion_v1('${grant}','${tenant}','${installation}','${device}','BRANCH','${branch}')`),/TENANT_DENIED/);
 }finally{await db.close()}
});
test('production-shaped web and native sales share one journal, replay once, update stock and preserve original receipt/history',async()=>{
 const db=await setup();try{
 await db.exec(`insert into native_production_cohort_v1 values('${tenant}',true,now());select set_config('request.jwt.claim.sub','${actor}',false);set role authenticated;`);
 const args=[tenant,installation,device,'1','BRANCH',branch],rpc=async(name,values)=>(await db.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) v`,values)).rows[0].v;
 await rpc('native_registrar_instalacion_v1',[grant,tenant,installation,device,'BRANCH',branch]);
 // Fixture-only baseline as PostgreSQL owner; users must use the cutover RPC.
 await db.exec('reset role');await rpc('native_sales_activate_v1',[...args,'PRODUCTION_CLOUD_BASELINE_REVIEWED','0.18']);await db.exec('set role authenticated');
 const first=await rpc('native_sales_bootstrap_v1',[...args,id(4000)]);assert.equal(first.coverage,'CLOUD_ADOPTED_V1');
 const sale=JSON.parse(JSON.stringify(command(4001)).replaceAll(qa,tenant));
 const input=[canon(sale.intent),hash(sale.intent),canon(sale.snapshot),hash(sale.snapshot)];
 const receipt=await rpc('native_sales_submit_v1',input);assert.deepEqual(await rpc('native_sales_submit_v1',input),receipt);
 const receiver=[tenant,id(4020),id(4021),'1','BRANCH',branch];
 await rpc('native_registrar_instalacion_v1',[id(4022),tenant,receiver[1],receiver[2],'BRANCH',branch]);
 const downloaded=await rpc('native_sales_bootstrap_v1',[...receiver,id(4023)]);assert.equal(downloaded.historyCount,1);
 const rows=[];for(const p of downloaded.pages){const page=await rpc('native_sales_bootstrap_page_v1',[...receiver,id(4023),p.index]);rows.push(...JSON.parse(page.payload))}
 assert.equal(rows.find(row=>row.kind==='PRODUCT'&&row.id===product).stock.quantity,'99');
 const history=rows.find(row=>row.kind==='HISTORY_EVENT');assert.equal(history.event.receipt.operationId,receipt.operationId);assert.equal(history.event.receipt.snapshotHash,receipt.snapshotHash);
 const webContext={tenantId:tenant,actorId:actor,installationId:id(4050),deviceId:id(4051),permissionGrantId:id(4052),writerEpoch:'1',scopeType:'BRANCH',branchId:branch};
 await rpc('native_web_enroll_v1',[tenant,webContext.installationId,webContext.deviceId,branch,webContext.permissionGrantId]);
 const web=JSON.parse(JSON.stringify(command(4053)).replaceAll(qa,tenant));Object.assign(web.intent,{installationId:webContext.installationId,originDeviceId:webContext.deviceId,permissionGrantId:webContext.permissionGrantId});
 const document=web.intent.payload.sale;document.stockEvidence=[{productId:product,remoteBaseQty:'99',remoteSequence:'1',pending:[],effectiveQty:'99'}];document.inventory[0].expectedRevision=hash({quantity:'99',remoteSequence:'1',pending:[]});web.intent.payload.quoteHash=hash({...document,fiscal:null});web.snapshot.sale=structuredClone(document);web.snapshot.ticket='N'+webContext.installationId.replaceAll('-','')+'-004053';
 const webInput=[webContext,canon(web.intent),hash(web.intent),canon(web.snapshot),hash(web.snapshot)];
 const webReceipt=await rpc('native_web_submit_v1',webInput);assert.deepEqual(await rpc('native_web_submit_v1',webInput),webReceipt);
 await assert.rejects(rpc('native_sales_feed_v1',[...args,'0']),/SHARED_UPGRADE_REQUIRED/);
 await db.exec(`select set_config('request.headers','{"x-ventard-journal":"stock-merge-1"}',false)`);
 const feed=await rpc('native_sales_feed_v1',[...args,'0']);assert.equal(feed.events.length,2);assert.equal(feed.events.at(-1).receipt.operationId,webReceipt.operationId);
 const fiscal=structuredClone(sale);fiscal.intent.operationId=id(4002);fiscal.intent.payload.sale.fiscal={number:'fixture'};
 await assert.rejects(rpc('native_sales_submit_v1',[canon(fiscal.intent),hash(fiscal.intent),canon(fiscal.snapshot),hash(fiscal.snapshot)]),/FISCAL_DISABLED/);
 await db.exec('reset role');await db.exec(operations);await db.exec('set role authenticated');
 assert.deepEqual(await rpc('native_sales_submit_v1',input),receipt);
 assert.deepEqual(await rpc('native_web_submit_v1',webInput),webReceipt);
 await db.exec('reset role');assert.equal((await db.query('select count(*) n from native_sales_ledger_v1')).rows[0].n,2);assert.equal((await db.query(`select stock_actual from inventario_sucursales where producto_id='${product}'`)).rows[0].stock_actual,98);
 }finally{await db.close()}
});
test('production cutover uses the audited stock-journal shape and blocks missing schema/direct activation',async()=>{
 const db=await setup();try{
 await db.exec(`insert into native_production_cohort_v1 values('${tenant}',true,now());select set_config('request.jwt.claim.sub','${actor}',false);set role authenticated;`);
 const args=[tenant,installation,device,'1','BRANCH',branch],rpc=async(name,values)=>(await db.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) v`,values)).rows[0].v;
 await rpc('native_registrar_instalacion_v1',[grant,tenant,installation,device,'BRANCH',branch]);
 await assert.rejects(rpc('native_sales_activate_v1',[...args,'PRODUCTION_CLOUD_BASELINE_REVIEWED','0.18']),/permission denied/);
 // The separately authorized schema-only preflight supplies this table.
 // Removing it must still fail closed before any cutover.
 await db.exec(`reset role;alter table movimientos_stock rename to fixture_stock_journal_held;set role authenticated;`);
 await assert.rejects(rpc('native_web_capture_v1',[...args,id(4030)]),/WEB_OBSERVATION_UNAVAILABLE/);
 await db.exec(`reset role;alter table fixture_stock_journal_held rename to movimientos_stock;set role authenticated;`);
 const capture=await rpc('native_web_capture_v1',[...args,id(4030)]);
 const context={tenantId:tenant,actorId:actor,installationId:installation,deviceId:device,writerEpoch:'1',scopeType:'BRANCH',branchId:branch};
 await db.exec('reset role');const tables=await rpc('native_web_cutover_tables_v1',[capture]);await db.exec('set role authenticated');
 const v={protocol:'ventard.web.cutover.1',cutoverId:id(4031),runId:id(4032),revision:0,context,backupId:id(4033),backupHash:'a'.repeat(64),runHash:'b'.repeat(64),confirmation:'WEB_WRITERS_CLOSED_BALANCES_REVIEWED',freeTax:'0.18',sources:[{kind:'CLOUD',id:id(4030),sha256:'c'.repeat(64)}],tables};
 const receipt=await rpc('native_web_cutover_v1',[canon(v),hash(v)]);assert.deepEqual(await rpc('native_web_cutover_v1',[canon(v),hash(v)]),receipt);
 assert.equal((await rpc('native_sales_bootstrap_v1',[...args,id(4034)])).coverage,'CLOUD_ADOPTED_V1');
 }finally{await db.close()}
});
