import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {isolatedProductionShape} from './production-server-fixture.mjs';
import {actor,installation,device,branch,grant,id} from './sales-fixtures.mjs';
const tenant='864d08e5-2975-4b2d-a1e2-ba5a14f3d677';
const migration=await readFile(new URL('../../supabase/migrations/20261021211744_native_business_admin_v1.sql',import.meta.url),'utf8');
test('business admin: isolated real schema, authorization, exact replay, duplicate rejection, PIN privacy and no activation',async()=>{
 const db=await isolatedProductionShape();try{
 await db.exec(migration);await db.exec(migration);
 assert.equal((await db.query('select count(*) n from native_production_cohort_v1')).rows[0].n,0);
 await db.exec(`insert into native_production_cohort_v1 values('${tenant}',true,now());select set_config('request.jwt.claim.sub','${actor}',false);set role authenticated;`);
 await db.query('select native_registrar_instalacion_v1($1,$2,$3,$4,$5,$6)',[grant,tenant,installation,device,'BRANCH',branch]);
 const ctx={tenantId:tenant,actorId:actor,installationId:installation,deviceId:device,writerEpoch:'1',scopeType:'BRANCH',branchId:branch};
 const call=async(action,op=null,payload={},context=ctx)=>(await db.query('select native_business_admin_v1($1,$2,$3,$4) v',[context,action,op,payload])).rows[0].v;
 assert.equal((await call('READ')).branches.length,1);
 const payload={id:id(9901),name:'Nueva sucursal sintética',address:'Dirección de prueba'},op=id(9902);
 const first=await call('CREATE_BRANCH',op,payload);assert.equal(first.status,'APPLIED');assert.deepEqual(await call('CREATE_BRANCH',op,payload),first);
 assert.equal((await call('READ')).branches.length,2);
 await assert.rejects(call('CREATE_BRANCH',op,{...payload,name:'Otra'}),/ADMIN_ID_CONFLICT/);
 await assert.rejects(call('CREATE_BRANCH',id(9903),{...payload,id:id(9904)}),/ADMIN_BRANCH_EXISTS/);
 await assert.rejects(call('READ',null,{}, {...ctx,actorId:id(9905)}),/DENIED/);
 await assert.rejects(db.query('select * from native_admin_operations_v1'),/permission denied/);
 const pin=await call('SET_ADMIN_PIN',id(9906),{pinHash:'a'.repeat(64)});assert.deepEqual(await call('SET_ADMIN_PIN',id(9906),{pinHash:'a'.repeat(64)}),pin);
 assert.equal((await call('READ')).pinConfigured,true);assert.ok(!JSON.stringify(await call('READ')).includes('a'.repeat(64)));
 await db.exec('reset role');assert.equal((await db.query('select count(*) n from native_sales_mode_v1')).rows[0].n,0);assert.equal((await db.query('select count(*) n from native_sales_ledger_v1')).rows[0].n,0);
 assert.equal((await db.query('select count(*) n from native_sales_write_context_v1')).rows[0].n,0);
 await db.query('select native_sales_activate_v1($1,$2,$3,$4,$5,$6,$7,$8)',[tenant,installation,device,'1','BRANCH',branch,'PRODUCTION_CLOUD_BASELINE_REVIEWED','0.18']);
 await db.exec('set role authenticated');
 assert.equal((await call('CREATE_BRANCH',id(9910),{id:id(9911),name:'Sucursal con negocio activo',address:''})).status,'APPLIED');
 await assert.rejects(call('READ',null,{}, {...ctx,tenantId:id(9999)}),/DENIED/);
 await db.exec('reset role;set role anon');await assert.rejects(call('READ'),/permission denied/);
 }finally{await db.close()}
});
