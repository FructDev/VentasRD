// Isolated PostgreSQL fixture; no remote database or user data.
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {inventorySetup,productCommand,stockCommand,submitManagement,context,rpc,id,tenant} from './sales-server.test.mjs';
const migration=await readFile(new URL('../../supabase/migrations/20261014134601_native_serial_inventory_adjustments_staging_v1.sql',import.meta.url),'utf8');
async function admin(db,sql){await db.exec('reset role');try{return (await db.query(sql)).rows;}finally{await db.exec('set role authenticated');}}
test('inventory serialized: loss, physical count, identity, bootstrap, CAS, replay and rollback',async()=>{const db=await inventorySetup();try{
 await db.exec('reset role');await db.exec(migration);await db.exec(migration);await db.exec('set role authenticated');
 const create=productCommand(1100);create.payload.request.definition.serialRequired=true;create.payload.document.product.metadata.serialRequired=true;const first=await submitManagement(db,create);
 const pending=[{operationId:id(1100),effectId:first.effects[1].id,delta:'0'}];const add=stockCommand(1101,{pending,quantity:'2',serials:['QA-1','QA-2']});const added=await submitManagement(db,add);
 pending.push({operationId:id(1101),effectId:added.effects[1].id,delta:'2'});
 const change=(text,before,after)=>({productId:id(300),text,expectedRevision:before===null?null:'1',before,after});
 const loss=stockCommand(1102,{before:'2',pending,mode:'LOSS',quantity:'1',serials:['QA-1']});loss.payload.document.serialChanges=[change('QA-1','AVAILABLE','LOST')];
 const lost=await submitManagement(db,loss);assert.equal(lost.stock[0].after,'1');assert.equal(lost.effects[2].kind,'SERIAL');assert.deepEqual(await submitManagement(db,loss),lost);
 assert.equal((await admin(db,"select estado from seriales where numero_serial='QA-1'"))[0].estado,'merma');
 const snapshot=await rpc(db,'native_sales_bootstrap_v1',[...context,id(1190)]);const page=await rpc(db,'native_sales_bootstrap_page_v1',[...context,snapshot.snapshotId,'0']);assert.equal(JSON.parse(page.payload).find(v=>v.kind==='SERIAL'&&v.text==='QA-1').state,'LOST');
 pending.push({operationId:id(1102),effectId:lost.effects[1].id,delta:'-1'});
 const count=stockCommand(1103,{before:'1',pending,mode:'COUNT',quantity:'2',serials:['QA-1','QA-3']});count.payload.document.serialChanges=[change('QA-1','LOST','AVAILABLE'),change('QA-2','AVAILABLE','LOST'),change('QA-3',null,'AVAILABLE')];
 await db.exec('reset role');await db.exec("create function serial_fault() returns trigger language plpgsql as $$begin if NEW.numero_serial='QA-3' then raise exception 'owned-serial-fault';end if;return NEW;end$$;create trigger serial_fault before insert on seriales for each row execute function serial_fault();");await db.exec('set role authenticated');
 await assert.rejects(submitManagement(db,count),/owned-serial-fault/);assert.equal((await admin(db,`select stock_actual from productos where id='${id(300)}'`))[0].stock_actual,1);assert.equal((await admin(db,"select estado from seriales where numero_serial='QA-1'"))[0].estado,'merma');
 await db.exec('reset role');await db.exec('drop trigger serial_fault on seriales');await db.exec('set role authenticated');const counted=await submitManagement(db,count);assert.equal(counted.stock[0].after,'2');assert.deepEqual(await submitManagement(db,count),counted);
 assert.deepEqual(await admin(db,'select numero_serial,estado from seriales order by numero_serial'),[{numero_serial:'QA-1',estado:'disponible'},{numero_serial:'QA-2',estado:'merma'},{numero_serial:'QA-3',estado:'disponible'}]);
 const stale=structuredClone(count);stale.operationId=stale.payload.request.operationId=id(1104);await assert.rejects(submitManagement(db,stale),/STOCK_VERSION_CONFLICT/);
 assert.equal((await admin(db,`select count(*)::integer n from native_sales_ledger_v1 where operation_id='${id(1104)}'`))[0].n,0);
 await assert.rejects(rpc(db,'native_inventory_submit_v1',[null,null,null,null]),/permission denied/);
}finally{await db.close();}});
