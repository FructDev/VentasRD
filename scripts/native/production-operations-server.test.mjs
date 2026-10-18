// Recreates authorized production SCHEMA only in isolated PostgreSQL.
// Every user/business/product below is synthetic. Never contacts production.
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
import {productionOperations,productionOperationsFile} from './prepare-production-operations.mjs';
import {actor,device,installation,branch,product,customer,grant,id,command,canon,hash} from './sales-fixtures.mjs';
import {isolatedProductionShape} from './production-server-fixture.mjs';
const tenant='864d08e5-2975-4b2d-a1e2-ba5a14f3d677',qa='96000000-0000-4000-8000-000000000001';
const schema=JSON.parse(await readFile(new URL('./fixtures/production-schema-20261017.json',import.meta.url),'utf8'));
const access=await readFile(new URL('../../supabase/migrations/20261017125853_native_production_access_v1.sql',import.meta.url),'utf8');
const operations=await readFile(new URL('../../supabase/migrations/'+productionOperationsFile,import.meta.url),'utf8');
const fingerprints=await readFile(new URL('../../supabase/migrations/20261018020840_native_web_fingerprint_linear_v1.sql',import.meta.url),'utf8');
const bulk=await readFile(new URL('../../supabase/migrations/20261018213133_native_resolution_bulk_execution_v1.sql',import.meta.url),'utf8');
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

test('bulk cutover preserves full-size history, balances, exact canonical hashes, atomic rejection and replay',async(t)=>{
 const db=await setup();try{
  await db.exec(bulk);await db.exec(bulk);
  for(const v of [{z:'á 😀 \\"\n',a:[null,true,false,0,9007199254740991,{$number:'-0.00'}]},[],{},'text']){
   const r=(await db.query('select native_sales_canonical_v1($1) old,native_web_resolution_canonical_v1($1) current',[JSON.stringify(v)])).rows[0];assert.equal(r.current,r.old);
  }
  for(const raw of ['-1','1.2','9007199254740992','{"ñ":1}'])await assert.rejects(db.query('select native_web_resolution_canonical_v1($1::jsonb)',[raw]));
  for(const v of [{nested:[{$number:'-12.3400'},{$milliseconds:'1791712800000'},null,true,false,{name:'á 😀'}]},[],{},{$number:null}]){
   const r=(await db.query('select native_web_resolution_decode_v1($1) old,native_web_resolution_bulk_decode_v1($1) current',[JSON.stringify(v)])).rows[0];assert.deepEqual(r.current,r.old);
  }
  await assert.rejects(db.query('select native_web_resolution_bulk_decode_v1($1)',[{$number:'x'}]));
  await assert.rejects(db.query('select native_web_resolution_bulk_decode_v1($1)',[{$number:'1',extra:'x'}]),/RESOLUTION_INVALID/);
  await assert.rejects(db.query('select native_web_resolution_bulk_decode_v1($1,65)',[{}]),/RESOLUTION_INVALID/);
  await assert.rejects(db.query('select native_web_resolution_canonical_v1($1,65)',[{}]),/NATIVE_CANON_DEPTH/);
  await assert.rejects(db.query('select native_web_resolution_canonical_v1($1,64)',[{x:'leaf'}]),/NATIVE_CANON_DEPTH/);
  assert.equal((await db.query("select proconfig from pg_proc where oid='native_web_resolution_commit_v1(jsonb,uuid,text,integer)'::regprocedure")).rows[0].proconfig.includes('statement_timeout=60s'),true);
  await db.exec(`insert into ventas(id,negocio_id,sucursal_id,total,metodo_pago,fecha_creacion,vendedor_nombre) select md5('synthetic-bulk-sale-'||s)::uuid,'${tenant}','${branch}',3,'tarjeta',1791712800000,repeat('SYNTHETIC volume ',12) from generate_series(1,3056) s;
  insert into venta_detalles(id,venta_id,producto_id,negocio_id,sucursal_id,cantidad,precio_unitario,subtotal,fecha_creacion,nombre) select md5('synthetic-bulk-line-'||s||'-'||l)::uuid,md5('synthetic-bulk-sale-'||s)::uuid,null,'${tenant}','${branch}',1,1,1,1791712800000,'SYNTHETIC bulk line' from generate_series(1,3056) s cross join generate_series(1,3) l;
  insert into native_production_cohort_v1 values('${tenant}',true,now());select set_config('request.jwt.claim.sub','${actor}',false);set role authenticated;`);
  const args=[tenant,installation,device,'1','BRANCH',branch],rpc=async(name,values)=>(await db.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) v`,values)).rows[0].v;
  await rpc('native_registrar_instalacion_v1',[grant,tenant,installation,device,'BRANCH',branch]);
  await assert.rejects(rpc('native_web_resolution_canonical_v1',[{}]),/permission denied/);
  const c={tenantId:tenant,actorId:actor,installationId:installation,deviceId:device,writerEpoch:'1',scopeType:'BRANCH',branchId:branch};
  const basis=await rpc('native_web_resolution_basis_v1',[c,id(5100)]),capture=await rpc('native_web_capture_v1',[...args,id(5100)]);
  const rows=capture.tables.map(({name,rows})=>({name,rows}));
  const sales=rows.find(t=>t.name==='ventas').rows;
  const p={protocol:'ventard.web.cutover.1',cutoverId:id(5101),runId:id(5102),revision:2,context:c,backupId:id(5103),backupHash:'a'.repeat(64),runHash:'b'.repeat(64),confirmation:'WEB_WRITERS_CLOSED_BALANCES_REVIEWED',freeTax:'0.18',sources:[{kind:'CLOUD',id:id(5100),sha256:'c'.repeat(64)}],tables:basis.tables,legacyCashHistoryConfirmed:true,reconciliation:{protocol:'ventard.web.resolution.1',reason:'SYNTHETIC full-size reviewed baseline; retain original history without replay',basis,rows,stockCounts:[{productId:product,quantity:'100'}],debtBalances:[{customerId:customer,balanceCents:'0'}],decisions:[],history:{protocol:'ventard.web.resolution.history.1',tables:rows,tickets:sales.map(s=>({id:s.id,totalCents:'300',lines:[],coverage:'PRESERVED_LEGACY_FIELDS',effectStatus:'UNKNOWN_LEGACY'}))}}};
  const raw=canon(p),h=hash(p);assert.ok(Buffer.byteLength(raw)>10*1024*1024);
  await db.exec('reset role');
  const digest=async()=>JSON.stringify((await db.query(`select (select encode(sha256(convert_to(jsonb_agg(to_jsonb(v) order by id)::text,'UTF8')),'hex') from ventas v) sales,(select encode(sha256(convert_to(jsonb_agg(to_jsonb(d) order by id)::text,'UTF8')),'hex') from venta_detalles d) details`)).rows);
  const before=await digest();const encoded=(await db.query('select native_web_resolution_canonical_v1($1::jsonb) raw',[raw])).rows[0].raw;assert.equal(encoded,raw);
  await db.exec('set role authenticated');
  const parts=[];let start=0;while(start<raw.length){let end=Math.min(start+120000,raw.length);if(/[\uD800-\uDBFF]/.test(raw[end-1]))end--;parts.push(raw.slice(start,end));start=end;}
  const params=[c,p.cutoverId,h,parts.length];assert.equal((await rpc('native_web_resolution_commit_v1',params)).status,'UPLOAD_REQUIRED');
  for(let index=0;index<parts.length;index++)await rpc('native_web_resolution_stage_v1',[...params,index,parts[index],hash(parts[index])]);
  const started=performance.now();const receipt=await rpc('native_web_resolution_commit_v1',params);const ms=Math.round(performance.now()-started);t.diagnostic(JSON.stringify({bytes:Buffer.byteLength(raw),sales:3056,details:9168,commitMs:ms,engine:'ISOLATED_POSTGRESQL',privateData:false}));
  assert.equal(receipt.status,'BASELINE_ADOPTED');assert.equal(receipt.planHash,h);assert.equal(receipt.legacyReplay,false);
  assert.deepEqual(await rpc('native_web_resolution_commit_v1',params),receipt);
  await db.exec('reset role');assert.equal(await digest(),before);
  assert.deepEqual((await db.query('select (select count(*) from native_sales_ledger_v1) operations,(select stock_actual from inventario_sucursales) stock,(select balance_cents from native_sales_credit_v1) balance')).rows[0],{operations:0,stock:100,balance:0});
  const saved=(await db.query('select history,history_hash from native_web_resolutions_v1')).rows[0];assert.deepEqual(saved.history,p.reconciliation.history);assert.equal(saved.history_hash,hash(saved.history));
 }finally{await db.close()}
});

test('reviewed Pica archives invalid branch stock atomically, preserves every original and leaves another business unchanged',async()=>{
 const db=await isolatedProductionShape();try{
  await db.exec(bulk);await db.exec(bulk);
  const other=id(5300),foreignBranch=id(5301),retiredBranch=id(5302),otherProduct=id(5303);
  await db.exec(`insert into negocios(id,nombre,"dueño_id",plan_activo,plan_tier,acceso_hasta) values('${other}','SYNTHETIC other business','${actor}',true,'basico',1900000000000);
  insert into sucursales(id,negocio_id,nombre,fecha_creacion)values('${foreignBranch}','${other}','Other',1791712800000);
  insert into productos(id,negocio_id,nombre,precio_venta,costo,stock_actual,tasa_itbis,fecha_actualizacion)values('${otherProduct}','${other}','SYNTHETIC other product',10,5,20,.18,1791712800000);
  insert into inventario_sucursales(sucursal_id,producto_id,stock_actual,fecha_actualizacion)values('${foreignBranch}','${otherProduct}',20,1791712800000),('${foreignBranch}','${product}',-2,1791712800000),('${retiredBranch}','${product}',3,1791712800000);
  insert into seriales(id,negocio_id,producto_id,numero_serial,estado,fecha_actualizacion)values('${id(5304)}','${tenant}','${id(5399)}','SYNTHETIC-ORPHAN','disponible',1791712800000);
  insert into native_production_cohort_v1 values('${tenant}',true,now());select set_config('request.jwt.claim.sub','${actor}',false);`);
  const otherRows=async()=>JSON.stringify((await db.query(`select (select to_jsonb(n) from negocios n where id='${other}') business,(select to_jsonb(p) from productos p where id='${otherProduct}') product,(select to_jsonb(i) from inventario_sucursales i where producto_id='${otherProduct}') stock,(select to_jsonb(s) from sucursales s where id='${foreignBranch}') branch`)).rows);
  const beforeOther=await otherRows();const orphanBefore=(await db.query(`select to_jsonb(s) v from seriales s where id='${id(5304)}'`)).rows[0].v;
  const originals=(await db.query(`select to_jsonb(i) v from inventario_sucursales i where producto_id='${product}' and sucursal_id<>'${branch}' order by sucursal_id`)).rows.map(r=>r.v);
  await db.exec('set role authenticated');const args=[tenant,installation,device,'1','BRANCH',branch],rpc=async(name,values)=>(await db.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) v`,values)).rows[0].v;
  await rpc('native_registrar_instalacion_v1',[grant,tenant,installation,device,'BRANCH',branch]);
  const c={tenantId:tenant,actorId:actor,installationId:installation,deviceId:device,writerEpoch:'1',scopeType:'BRANCH',branchId:branch};
  const basis=await rpc('native_web_resolution_basis_v1',[c,id(5310)]),capture=await rpc('native_web_capture_v1',[...args,id(5310)]),rows=capture.tables.map(({name,rows})=>({name,rows}));
  const p={protocol:'ventard.web.cutover.1',cutoverId:id(5311),runId:id(5312),revision:2,context:c,backupId:id(5313),backupHash:'a'.repeat(64),runHash:'b'.repeat(64),confirmation:'WEB_WRITERS_CLOSED_BALANCES_REVIEWED',freeTax:'0.18',sources:[{kind:'CLOUD',id:id(5310),sha256:'c'.repeat(64)}],tables:basis.tables,legacyCashHistoryConfirmed:true,reconciliation:{protocol:'ventard.web.resolution.1',reason:'SYNTHETIC reviewed Principal count; retain invalid old branch references in archive',basis,rows,stockCounts:[{productId:product,quantity:'100'}],debtBalances:[{customerId:customer,balanceCents:'0'}],decisions:[],history:{protocol:'ventard.web.resolution.history.1',tables:rows,tickets:[]}}};
  await assert.rejects(rpc('native_web_cutover_validated_v1',[canon(p),hash(p),true]),/permission denied/);
  const noncanonical=canon(p)+' ';await assert.rejects(rpc('native_web_cutover_v1',[noncanonical,hash(noncanonical)]),/RESOLUTION_INVALID/);
  const bad=structuredClone(p);bad.cutoverId=id(5314);bad.reconciliation.debtBalances=[];
  await assert.rejects(rpc('native_web_cutover_v1',[canon(bad),hash(bad)]),/RESOLUTION_DEBT_COVERAGE/);
  await db.exec('reset role');assert.equal((await db.query('select count(*) n from native_web_legacy_branch_stock_v1')).rows[0].n,0);assert.equal((await db.query(`select count(*) n from inventario_sucursales where producto_id='${product}'`)).rows[0].n,3);assert.equal(await otherRows(),beforeOther);
  await db.exec('set role authenticated');const receipt=await rpc('native_web_cutover_v1',[canon(p),hash(p)]);assert.deepEqual(await rpc('native_web_cutover_v1',[canon(p),hash(p)]),receipt);
  const manifest=await rpc('native_sales_bootstrap_v1',[...args,id(5315)]);const received=[];for(const page of manifest.pages)received.push(...JSON.parse((await rpc('native_sales_bootstrap_page_v1',[...args,id(5315),page.index])).payload));
  const operative=received.find(r=>r.kind==='PRODUCT'&&r.id===product);assert.equal(operative.stock.authority,'VERIFIED');assert.equal(operative.stock.quantity,'100');
  assert.equal(received.filter(r=>r.kind==='SERIAL').length,0);
  await assert.rejects(db.query('select * from native_web_legacy_branch_stock_v1'),/permission denied/);
  await db.exec('reset role');const archived=(await db.query('select source_row v,source_hash=native_sales_hash_v1(source_row::text) valid from native_web_legacy_branch_stock_v1 order by sucursal_id')).rows;assert.deepEqual(archived.map(r=>r.v),originals);assert.ok(archived.every(r=>r.valid));assert.equal(await otherRows(),beforeOther);
  assert.deepEqual((await db.query(`select to_jsonb(s) v from seriales s where id='${id(5304)}'`)).rows[0].v,orphanBefore);
  assert.deepEqual((await db.query('select source_row v from native_web_legacy_catalogue_rows_v1')).rows[0].v,orphanBefore);
  assert.deepEqual((await db.query(`select (select count(*) from native_sales_ledger_v1) operations,(select stock_actual from productos where id='${product}') global_stock,(select stock_actual from inventario_sucursales where producto_id='${product}') branch_stock`)).rows[0],{operations:0,global_stock:100,branch_stock:100});
  await db.exec(await readFile(new URL('./production-cutover-bulk-readonly-verify.sql',import.meta.url),'utf8'));
 }finally{await db.close()}
});
