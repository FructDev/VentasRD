import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const original=await readFile(new URL('../../supabase/migrations/20261017130229_native_production_operations_v1.sql',import.meta.url),'utf8');
const migration=await readFile(new URL('../../supabase/migrations/20261018020840_native_web_fingerprint_linear_v1.sql',import.meta.url),'utf8');
function definition(name){const start=original.indexOf('create or replace function public.'+name+'(');assert.ok(start>=0);return original.slice(start,original.indexOf('end $f$;',start)+9)}
async function setup(){
 const db=new PGlite();
 await db.exec('create role anon;create role authenticated;');
 for(const name of ['native_sales_canonical_v1','native_web_cutover_normalize_v1','native_web_cutover_tables_v1'])await db.exec(definition(name));
 await db.exec("create function native_sales_hash_v1(v text) returns text language sql immutable as $$select encode(sha256(convert_to(v,'UTF8')),'hex')$$;");
 await db.exec(definition('native_web_cutover_tables_v1').replace('public.native_web_cutover_tables_v1(','public.fixture_previous_tables('));
 await db.exec(migration);await db.exec(migration);
 return db;
}
async function compare(db,capture){const r=(await db.query('select fixture_previous_tables($1) old,native_web_cutover_tables_v1($1) current',[capture])).rows[0];assert.deepEqual(r.current,r.old);return r.current}
test('fingerprints preserve exact normalized bytes, C ordering, ignored transport fields and 100-row boundaries',async()=>{
 const db=await setup();try{
 const rows=Array.from({length:207},(_,i)=>({id:String(207-i).padStart(4,'0'),name:'Pollo á 😀 \\ "\n',amount:{$number:i%2?'12.3400':'-0.000'},date:{$milliseconds:'1791712800000.00'},nested:[null,true,false,{$number:'-12.500'}, {estado_sincronizacion:{$number:'0'},keep:'x',sync_ignored:{deep:1}}],inventory_local:{$number:'99'},remote_receipt:{untrusted:123}}));
 const v=await compare(db,{tables:[{name:'ventas',rows},{name:'empty',rows:[]},{name:'productos',rows:[{id:'z',empty:{},list:[]}]}]});
 assert.equal(v[2].blocks.length,3);assert.equal(v[2].count,207);assert.deepEqual(v[0].blocks,[]);
 await db.exec('set role authenticated');await assert.rejects(db.query('select native_web_cutover_tables_v1($1)',[{tables:[]}]),/permission denied/);await assert.rejects(db.query('select native_web_cutover_canonical_v1($1)',[{}]),/permission denied/);
 }finally{await db.close()}
});
test('invalid numerics, reserved tags, keys and excessive depth remain rejected atomically',async()=>{
 const db=await setup();try{
 const deep=n=>{let v='end';for(let i=0;i<n;i++)v={child:v};return v};
 for(const row of [{id:'a',number:1},{id:'a',tag:{$number:'1',extra:'x'}},{id:'a',tag:{$number:'not a number'}},{id:'a','ñ':'value'},{id:'a',tag:{$milliseconds:'0',$number:'0'}}]){
  const capture={tables:[{name:'ventas',rows:[row]}]};
  await assert.rejects(db.query('select fixture_previous_tables($1)',[capture]));
  await assert.rejects(db.query('select native_web_cutover_tables_v1($1)',[capture]));
 }
 // Exercise the recursive depth guard directly: 65 nested PostgreSQL calls
 // can exhaust the WASM host stack before PostgreSQL raises its exception.
 await assert.rejects(db.query('select native_web_cutover_canonical_v1($1,65)',[{}]),/CUTOVER_INVALID/);
 await assert.rejects(db.query('select native_web_cutover_canonical_v1($1,64)',[{$number:'1'}]),/NATIVE_CANON_DEPTH/);
 for(const row of [deep(10),{id:'a',tag:{$number:null}}])await compare(db,{tables:[{name:'ventas',rows:[row]}]});
 }finally{await db.close()}
});
test('full-size synthetic legacy history keeps every fingerprint with linear block assembly',async(t)=>{
 const db=await setup();try{
 const numeric=n=>({$number:String(n)});
 const rows=(count,factory)=>Array.from({length:count},(_,i)=>({id:String(i).padStart(8,'0'),...factory(i)}));
 const capture={tables:[{name:'venta_detalles',rows:rows(7538,i=>({venta_id:String(i%3056).padStart(8,'0'),producto_id:'synthetic-product',cantidad:numeric(1),precio_unitario:numeric('100.50'),subtotal:numeric('100.50'),descuento:numeric(0),itbis:numeric('18.09'),fecha:{$milliseconds:'1791712800000.00'},negocio_id:'synthetic-tenant',sucursal_id:'synthetic-branch'}))},{name:'ventas',rows:rows(3056,i=>({total:numeric('118.59'),subtotal:numeric('100.50'),itbis:numeric('18.09'),descuento:numeric(0),fecha:{$milliseconds:'1791712800000.00'},tipo:'contado',metodo_pago:i%2?'tarjeta':'efectivo',negocio_id:'synthetic-tenant',sucursal_id:'synthetic-branch',pagos:[{metodo:'tarjeta',monto:numeric('118.59')}],cliente_id:null,notas:'SYNTHETIC volume fixture'}))}]};
 const start=performance.now();const old=(await db.query('select fixture_previous_tables($1) v',[capture])).rows[0].v;const previousMs=performance.now()-start;
 const optimizedStart=performance.now();const current=(await db.query('select native_web_cutover_tables_v1($1) v',[capture])).rows[0].v;const optimizedMs=performance.now()-optimizedStart;
 assert.deepEqual(current,old);assert.equal(current.reduce((n,t)=>n+t.count,0),10594);t.diagnostic(JSON.stringify({previousMs:Math.round(previousMs),optimizedMs:Math.round(optimizedMs),engine:'ISOLATED_POSTGRESQL',privateData:false}));
 }finally{await db.close()}
});
