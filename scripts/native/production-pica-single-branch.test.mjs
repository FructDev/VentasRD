import {readFile} from 'node:fs/promises';import {test} from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';
const sql=(await readFile(new URL('./production-pica-single-branch.sql',import.meta.url),'utf8')).replace('__PICA_TRANSFER_GUARD__','');
const n='864d08e5-2975-4b2d-a1e2-ba5a14f3d677',b='09026e88-90f8-44d5-b8cb-9d87f715072f',other='00000000-0000-4000-8000-000000000003',old='cf3d42b8-4f9f-4fae-9cd3-d650395f716b';
async function setup(){const db=new PGlite();await db.exec(`create table sucursales(id uuid primary key,negocio_id uuid);insert into sucursales values('${b}','${n}');
create table native_sales_mode_v1(negocio_id uuid);create table native_sales_ledger_v1(negocio_id uuid);
create table productos(id uuid primary key,negocio_id uuid,stock_actual integer,stock_minimo integer,precio_venta numeric);insert into productos values('${b}','${n}',23,2,12.34),('${other}','${other}',17,1,15);
create table inventario_sucursales(id uuid primary key,sucursal_id uuid,producto_id uuid,stock_actual integer,stock_minimo integer,estado_sincronizacion smallint not null,fecha_actualizacion bigint not null,unique(sucursal_id,producto_id));
insert into inventario_sucursales values('${b}','${b}','${b}',-3,0,1,1);
create table cajas(id text primary key,negocio_id text,sucursal_id text,estado text,monto_apertura numeric,monto_cierre numeric,monto_esperado numeric,diferencia numeric,fecha_cierre bigint);
insert into cajas values('old','${n}','${old}','abierta',500,null,null,null,null),('foreign','${other}','${old}','abierta',100,null,null,null,null);
create table ventas(id uuid primary key,negocio_id uuid,sucursal_id uuid,total numeric);insert into ventas values('${b}','${n}','${old}',442.96000000000004),('${other}','${other}','${old}',1.001);
create table transacciones_fiado(id uuid primary key,negocio_id uuid,sucursal_id uuid,tipo text,monto numeric,metodo_pago text);insert into transacciones_fiado values('${b}','${n}',null,'cargo',3568.3199999999997,null);`);return db;}
async function snapshot(db){const out={};for(const t of ['productos','inventario_sucursales','cajas','ventas','transacciones_fiado'])out[t]=(await db.query('select to_jsonb(t) r from '+t+' t order by id')).rows;return out;}
test('single test branch preserves identities, adopts reviewed web stock, normalizes only IEEE noise, closes test cash and replays once',async()=>{const db=await setup();try{
 const before=await snapshot(db);await db.exec(sql);const after=await snapshot(db);
 assert.equal(after.ventas.find(r=>r.r.negocio_id===n).r.sucursal_id,b);assert.equal(after.ventas.find(r=>r.r.negocio_id===n).r.total,442.96);
 assert.deepEqual(after.ventas.find(r=>r.r.negocio_id===other),before.ventas.find(r=>r.r.negocio_id===other));
 assert.equal(after.transacciones_fiado[0].r.monto,3568.32);assert.equal(after.transacciones_fiado[0].r.metodo_pago,null);
 assert.equal(after.cajas.find(r=>r.r.id==='old').r.monto_cierre,0);assert.equal(after.cajas.find(r=>r.r.id==='old').r.monto_esperado,null);
 assert.deepEqual(after.cajas.find(r=>r.r.id==='foreign'),before.cajas.find(r=>r.r.id==='foreign'));
 assert.equal(after.inventario_sucursales[0].r.id,b);assert.equal(after.inventario_sucursales[0].r.stock_actual,23);
 await db.exec(sql);assert.deepEqual(await snapshot(db),after);
}finally{await db.close()}});
test('genuine fractional cents roll back every scope/stock/cash change',async()=>{const db=await setup();try{await db.exec(`update ventas set total=1.001 where negocio_id='${n}'`);const before=await snapshot(db);await assert.rejects(db.exec(sql),/PICA_GENUINE_FRACTIONAL_CENT/);await db.exec('rollback');assert.deepEqual(await snapshot(db),before);}finally{await db.close()}});
test('multiple branches or already active journal refuse the repair',async()=>{for(const setupSql of [`insert into sucursales values('${old}','${n}')`,`insert into native_sales_mode_v1 values('${n}')`]){const db=await setup();try{await db.exec(setupSql);const before=await snapshot(db);await assert.rejects(db.exec(sql),/PICA_(SINGLE_BRANCH_REQUIRED|REPAIR_REQUIRES_PRE_CUTOVER)/);await db.exec('rollback');assert.deepEqual(await snapshot(db),before);}finally{await db.close()}}});
