import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
const script=await readFile(new URL('./production-pica-abono-method-reconcile.sql',import.meta.url),'utf8');
const tenant='864d08e5-2975-4b2d-a1e2-ba5a14f3d677',payment='a64047b1-cc96-4af0-9f33-eaa518697d59';
async function fixture(){
 const db=new PGlite();
 await db.exec(`create table transacciones_fiado(id uuid primary key,negocio_id uuid,cliente_id uuid,venta_id uuid,tipo text,monto numeric,sucursal_id uuid,caja_id text,metodo_pago text,fecha_creacion timestamptz,fecha_actualizacion bigint);
 create table native_sales_mode_v1(negocio_id uuid);
 insert into transacciones_fiado values('${payment}','${tenant}','00000000-0000-4000-8000-000000000001',null,'abono',10,'09026e88-90f8-44d5-b8cb-9d87f715072f',null,null,'2026-10-02T01:48:29.427Z',1790905709427);
 insert into transacciones_fiado select '00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003',cliente_id,venta_id,tipo,monto,sucursal_id,caja_id,metodo_pago,fecha_creacion,fecha_actualizacion from transacciones_fiado;`);
 return db;
}
const rows=async db=>(await db.query('select to_jsonb(f) value from transacciones_fiado f order by id')).rows.map(r=>r.value);
test('classifies only the confirmed existing payment, preserves all other fields and replays without another payment',async()=>{
 const db=await fixture();try{
  const before=await rows(db);await db.exec(script);const after=await rows(db);
  assert.deepEqual(after,before.map(r=>r.id===payment?{...r,metodo_pago:'efectivo'}:r));
  await db.exec(script);assert.deepEqual(await rows(db),after);
 }finally{await db.close()}
});
test('refuses changed amount or an already classified conflicting payment atomically',async()=>{
 for(const change of ["monto=11","metodo_pago='tarjeta'","caja_id='another-turn'"]){const db=await fixture();try{
  await db.exec(`update transacciones_fiado set ${change} where id='${payment}'`);const before=await rows(db);
  await assert.rejects(db.exec(script),/PICA_ABONO_(SOURCE_CHANGED|METHOD_CONFLICT)/);await db.exec('rollback');assert.deepEqual(await rows(db),before);
 }finally{await db.close()}}
});
test('refuses use after cutover rather than bypassing the shared journal',async()=>{
 const db=await fixture();try{
  await db.exec(`insert into native_sales_mode_v1 values('${tenant}')`);const before=await rows(db);
  await assert.rejects(db.exec(script),/PICA_ABONO_REQUIRES_PRE_CUTOVER/);await db.exec('rollback');assert.deepEqual(await rows(db),before);
 }finally{await db.close()}
});
