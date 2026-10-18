// Isolated in-memory PostgreSQL only. No network, user credentials or real
// installations. A supplied restore callback runs before FK validation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {productionOperationsFile} from './prepare-production-operations.mjs';
import {actor,branch,product,customer} from './sales-fixtures.mjs';
const tenant='864d08e5-2975-4b2d-a1e2-ba5a14f3d677';
const quote=v=>'"'+v.replaceAll('"','""')+'"';
export async function isolatedProductionShape({restore=null}={}){
 const schema=JSON.parse(await readFile(new URL('./fixtures/production-schema-20261017.json',import.meta.url),'utf8'));
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  for(const table of new Set(schema.columns.map(c=>c.table))){
   const columns=schema.columns.filter(c=>c.table===table).map(c=>{assert.ok(['uuid','text','jsonb','numeric','int8','int2','int4','bool','timestamptz'].includes(c.udt));assert.ok(!c.default||!/[;]|--|\/\*/.test(c.default));return quote(c.column)+' '+c.udt+(c.nullable==='NO'?' not null':'')+(c.default?' default '+c.default:'')});
   await db.exec('create table public.'+quote(table)+'('+columns.join(',')+')');
  }
  if(restore)await restore(db);
  for(const c of [...schema.constraints].sort((a,b)=>Number(a.definition.startsWith('FOREIGN KEY'))-Number(b.definition.startsWith('FOREIGN KEY')))){
   assert.match(c.definition,/^(PRIMARY KEY|FOREIGN KEY|CHECK|UNIQUE) /);assert.ok(!/[;]|--|\/\*/.test(c.definition));await db.exec('alter table '+quote(c.table.replace(/^public\./,''))+' add constraint '+quote(c.name)+' '+c.definition);
  }
  if(!restore)await db.exec(`insert into auth.users values('${actor}');insert into negocios(id,nombre,"dueño_id",plan_activo,plan_tier,acceso_hasta) values('${tenant}','SYNTHETIC production-shape fixture','${actor}',true,'basico',1900000000000);insert into sucursales(id,negocio_id,nombre,fecha_creacion)values('${branch}','${tenant}','Fixture',1791712800000);insert into productos(id,negocio_id,nombre,codigo_barras,precio_venta,costo,stock_actual,tasa_itbis,fecha_actualizacion)values('${product}','${tenant}','Producto sintético','0001',100,60,100,.18,1791712800000);insert into inventario_sucursales(sucursal_id,producto_id,stock_actual,fecha_actualizacion)values('${branch}','${product}',100,1791712800000);insert into clientes(id,negocio_id,nombre,limite_credito,fecha_actualizacion)values('${customer}','${tenant}','Cliente sintético',5000,1791712800000);`);
  for(const name of ['20261017125853_native_production_access_v1.sql',productionOperationsFile,'20261018020840_native_web_fingerprint_linear_v1.sql'])await db.exec(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
  return db;
 }catch(e){await db.close();throw e}
}
