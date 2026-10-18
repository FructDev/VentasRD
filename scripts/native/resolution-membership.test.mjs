import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isolatedProductionShape} from './production-server-fixture.mjs';
const bulk=await readFile(new URL('../../supabase/migrations/20261018213133_native_resolution_bulk_execution_v1.sql',import.meta.url),'utf8');
const indexed=await readFile(new URL('../../supabase/migrations/20261018222701_native_resolution_indexed_membership_v1.sql',import.meta.url),'utf8');
const prior=`select array_agg(x->>'id') missing from jsonb_array_elements($1::jsonb) x where not exists(select 1 from jsonb_array_elements($2::jsonb) y where y->>'id'=x->>'id')`;
test('missing-parent membership preserves nulls, duplicates, original order and exact text IDs',async()=>{
 const db=await isolatedProductionShape();try{
  await db.exec(bulk);await db.exec(indexed);await db.exec(indexed);
  for(const [source,chosen] of [
   [[],[]],[[{id:'a'},{id:'b'},{id:'a'},{id:null},{}],[{id:'b'}]],
   [[{id:'01'},{id:'1'},{id:'á'},{id:'A'}],[{id:'1'},{id:'á'},{id:'1'}]],
   [[{id:'a'}],null],[null,[{id:'a'}]],
  ]){
   const args=[source===null?null:JSON.stringify(source),chosen===null?null:JSON.stringify(chosen)];
   assert.deepEqual((await db.query('select native_web_resolution_missing_ids_v1($1,$2) missing',args)).rows,(await db.query(prior,args)).rows);
  }
  await assert.rejects(db.query('select native_web_resolution_missing_ids_v1($1,$2)',[{},[]]));
  await db.exec('set role authenticated');await assert.rejects(db.query('select native_web_resolution_missing_ids_v1($1,$2)',[[],[]]),/permission denied/);
 }finally{await db.close()}
});
test('large membership performs a single relational join instead of repeatedly expanding every selected document',async(t)=>{
 const db=await isolatedProductionShape();try{
  await db.exec(bulk);await db.exec(indexed);
  const source=Array.from({length:7538},(_,i)=>({id:'row-'+i,retained:'SYNTHETIC '+i}));
  const chosen=source.filter((_,i)=>i%1000!==0),args=[JSON.stringify(source),JSON.stringify(chosen)];
  const start=performance.now(),actual=(await db.query('select native_web_resolution_missing_ids_v1($1,$2) missing',args)).rows[0].missing,elapsed=performance.now()-start;
  assert.deepEqual(actual,source.filter((_,i)=>i%1000===0).map(r=>r.id));
  assert.ok(elapsed<2000,'7538 document membership must complete within two seconds in isolated PostgreSQL');
  t.diagnostic(JSON.stringify({documents:source.length,missing:actual.length,elapsedMs:Math.round(elapsed),engine:'ISOLATED_POSTGRESQL_RAM'}));
  const body=(await db.query("select pg_get_functiondef('native_web_cutover_validated_v1(text,text,boolean)'::regprocedure) body")).rows[0].body;
  assert.ok(body.includes('native_web_resolution_missing_ids_v1'));
  assert.ok(!body.includes("where not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->table_name) y"));
 }finally{await db.close()}
});
