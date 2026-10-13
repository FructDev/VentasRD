// Isolated PostgreSQL + the ORIGINAL web canonicalizer. No remote credentials.
import {readFile,writeFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {canonicalizeInventoryPayload,hashInventoryPayload} from '../../src/lib/sync/inventory/canonical-payload.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const tenant='96000000-0000-4000-8000-000000000001',other='96000000-0000-4000-8000-000000000002';
const id=n=>'96400000-0000-4000-8000-'+String(n).padStart(12,'0'),actor=id(1),branch=id(2),product=id(3);
test('inventory proof: original web hashes and immutable real PostgreSQL effects with exact bigint, RLS and read-only lookup',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create table negocios(id uuid primary key,"dueño_id" uuid);create table usuarios_negocio(negocio_id uuid,user_id uuid,activo boolean);
   create table sucursales(id uuid primary key,negocio_id uuid);create table productos(id uuid primary key,negocio_id uuid,stock_actual integer);
   create table inventario_sucursales(sucursal_id uuid,producto_id uuid,stock_actual integer,primary key(sucursal_id,producto_id));
   create table movimientos_stock(id uuid primary key,negocio_id uuid);
   insert into negocios values('${tenant}','${actor}'),('${other}','${id(4)}');insert into sucursales values('${branch}','${tenant}');
   insert into productos values('${product}','${tenant}',10);insert into inventario_sucursales values('${branch}','${product}',10);
   grant usage on schema public,auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  const sql=await readFile(new URL('../../supabase/migrations/20260924214900_inventario_sync_v2.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);
  await db.exec(`insert into inventario_secuencias_v2(negocio_id,authority_kind,sucursal_id,last_remote_sequence) values('${tenant}','BRANCH','${branch}',9007199254740992);`);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);await db.exec('set role authenticated');
  const fixtures=[];
  for(const [index,kind,value,expected] of [[10,'DELTA','-2',null],[11,'ABSOLUTE','5','9007199254740993']]){
   const payload={version:2,operationId:id(index),negocioId:tenant,sucursalId:branch,productoId:product,effect:{kind,value},tipo:kind==='DELTA'?'venta':'conteo',referenciaId:kind==='DELTA'?id(20):null,fechaOrigen:1791914400123,expectedRemoteSequence:expected};
   const canonical=canonicalizeInventoryPayload(payload),hash=hashInventoryPayload(payload);
   const receipt=(await db.query('select public.aplicar_movimiento_stock_v2(2,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) value',[payload.operationId,tenant,branch,product,kind,value,payload.tipo,payload.referenciaId,payload.fechaOrigen,expected,hash,id(30)])).rows[0].value;
   assert.equal(receipt.outcome,'APPLIED');
   const local={id:payload.operationId,negocio_id:tenant,sucursal_id:branch,producto_id:product,delta:kind==='DELTA'?-2:0,...(kind==='ABSOLUTE'?{valor_absoluto:5,expected_remote_sequence:expected}:{}),tipo:payload.tipo,...(payload.referenciaId?{referencia_id:payload.referenciaId}:{}),fecha_creacion:payload.fechaOrigen,estado_sincronizacion:0,sync_protocol_version:2,payload_hash:hash};
   fixtures.push({local,canonical});
  }
  await assert.rejects(db.query('update inventario_operaciones_v2 set stock_after=1'),/permission denied/);
  await db.exec('reset role');await assert.rejects(db.query('delete from inventario_operaciones_v2'),/INVENTORY_V2_LEDGER_IMMUTABLE/);await db.exec('set role authenticated');
  await db.exec('begin transaction isolation level repeatable read read only');
  const rawLedgerRows=(await db.query("select jsonb_agg(to_jsonb(t) order by operacion_id)::text value from inventario_operaciones_v2 t where negocio_id=$1 and sucursal_id=$2",[tenant,branch])).rows[0].value;
  assert.match(rawLedgerRows,/9007199254740993/);await db.exec('rollback');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(4)]);assert.equal((await db.query('select count(*) n from inventario_operaciones_v2')).rows[0].n,0);
  await db.exec('reset role;set role anon');await assert.rejects(db.query('select * from inventario_operaciones_v2'),/permission denied/);
  await writeFile(new URL('../../crates/ventard-core/tests/fixtures/legacy-inventory-proof.json',import.meta.url),JSON.stringify({tenant,branch,fixtures,rawLedgerRows},null,2)+'\n');
 }finally{await db.close();}
});
