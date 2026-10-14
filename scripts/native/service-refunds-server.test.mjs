// Real isolated PostgreSQL engine, synthetic fixtures only.
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
export {refund};
import {repairSetup,base,envelope,action,stock,proGrant,repairId} from './repairs-server.test.mjs';
import {managementCommand,submitManagement,openTurn,context,rpc,id,tenant,actor} from './sales-server.test.mjs';
import {layawaySetup,layawayCreate,layawayEnvelope,layawayAction,layawayStock} from './layaways-server.test.mjs';
const sql=await readFile(new URL('../../supabase/migrations/20261014143238_native_service_refunds_staging_v1.sql',import.meta.url),'utf8');
async function admin(db,sql){await db.exec('reset role');try{return (await db.query(sql)).rows;}finally{await db.exec('set role authenticated');}}
const refund=(op,service,revision,before,amount,method='EFECTIVO',family='repair')=>{const turnId=method==='EFECTIVO'?id(90):null,reason='Devolución de depósito QA',pending=BigInt(service.paidCents)-BigInt(before),after=BigInt(before)+BigInt(amount),request={kind:'SERVICE_REFUND',family,serviceId:service.id,expectedServiceRevision:service.revision,expectedRefundRevision:revision,amountCents:amount,method,turnId,reason};
 const document={service:{family,id:service.id,revision:service.revision,folio:service.folio,basisCents:service.paidCents},refund:{operationId:id(op),revision:String(BigInt(revision)+1n),amountCents:amount,method,turnId,dateMs:'1791712800000',reason},refundedBeforeCents:before,refundedAfterCents:String(after),pendingBeforeCents:String(pending),pendingAfterCents:String(pending-BigInt(amount)),amountCents:amount,method,concept:`Devolución de depósito ${service.folio}`,business:null};if(turnId)document.cashDeltaCents=String(-BigInt(amount));const v=managementCommand(op,'SERVICE_REFUND',request,document,turnId);v.permissionGrantId=proGrant;return v;};
test('service refunds: exact deposit refunds, stale/overpay rejection, ACL, rollback, bootstrap and replay',async()=>{const db=await repairSetup();try{
 await db.exec('reset role');await db.exec(sql);await db.exec(sql);await db.exec('set role authenticated');await openTurn(db);
 const initial=base(1500);await submitManagement(db,envelope(1500,initial.request,initial.repair,await stock(db,-2),'100'));const cancel=action(1501,initial.repair,'CANCEL');cancel.payload.request.warrantyDays='0';cancel.payload.document.stock=await stock(db,2);await submitManagement(db,cancel);const service=cancel.payload.document.repair;
 const first=refund(1502,service,'0','0','40');
 await db.exec('reset role');await db.exec("create function refund_fault() returns trigger language plpgsql as $$begin if NEW.kind='SERVICE_REFUND' then raise exception 'owned-refund-fault';end if;return NEW;end$$;create trigger refund_fault before insert on native_management_records_v1 for each row execute function refund_fault();");await db.exec('set role authenticated');
 await assert.rejects(submitManagement(db,first),/owned-refund-fault/);assert.equal((await admin(db,'select count(*)::int n from native_service_refunds_v1'))[0].n,0);assert.equal((await rpc(db,'native_sales_feed_v1',[...context,'0'])).cashBase.netCents,'100');
 await db.exec('reset role');await db.exec('drop trigger refund_fault on native_management_records_v1');await db.exec('set role authenticated');
 const applied=await submitManagement(db,first);assert.deepEqual(await submitManagement(db,first),applied);assert.equal((await rpc(db,'native_sales_feed_v1',[...context,'0'])).cashBase.netCents,'60');
 await assert.rejects(submitManagement(db,refund(1503,service,'0','0','60')),/SERVICE_VERSION/);await assert.rejects(submitManagement(db,refund(1504,service,'1','40','61')),/REFUND_EXCESS/);
 const second=refund(1505,service,'1','40','60','TARJETA');await submitManagement(db,second);assert.equal((await rpc(db,'native_sales_feed_v1',[...context,'0'])).cashBase.netCents,'60');
 const m=await rpc(db,'native_sales_bootstrap_v1',[...context,id(1590)]);assert.equal(m.serviceRefunds.length,2);assert.equal(m.serviceRefunds[0].receipt.operationId,id(1502));
 assert.equal((await admin(db,`select stock_actual from productos where id='${initial.repair.definition.parts[0].productId}'`))[0].stock_actual,100);
 const records=await admin(db,`select document->'repair'->'payments' payments from native_management_records_v1 where operation_id='${id(1501)}'`);assert.equal(records[0].payments.length,1);assert.equal(records[0].payments[0].amountCents,'100');
 await assert.rejects(db.query('select * from native_service_refunds_v1'),/permission denied/);await assert.rejects(rpc(db,'native_service_refund_submit_v1',[null,null,null,null]),/permission denied/);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(7)]);await assert.rejects(submitManagement(db,{...first,actorId:id(7)}),/NATIVE_.*(PRO|CONTEXT)/);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
 await admin(db,`update native_staging_licenses_v1 set plan_tier='basico' where negocio_id='${tenant}'`);await assert.rejects(submitManagement(db,refund(1506,service,'2','100','1')),/PRO_REQUIRED/);
}finally{await db.close();}});
test('service refunds: cancelled layaway returns its deposit without another stock release',async()=>{const db=await layawaySetup();try{
 await db.exec('reset role');await db.exec(sql);await db.exec(sql);await db.exec('set role authenticated');await openTurn(db);
 const c=layawayCreate();const v=layawayEnvelope(901,c.request,c.layaway,await layawayStock(db,-2),[],'100');await submitManagement(db,v);const cancelled=layawayAction(1601,c.layaway,'CANCEL');const e=layawayEnvelope(1601,cancelled.req,cancelled.a,await layawayStock(db,2));await submitManagement(db,e);
 const command=refund(1602,cancelled.a,'0','0','100','EFECTIVO','layaway');const applied=await submitManagement(db,command);assert.deepEqual(await submitManagement(db,command),applied);
 assert.equal((await rpc(db,'native_sales_feed_v1',[...context,'0'])).cashBase.netCents,'0');assert.equal((await admin(db,`select stock_actual from productos where id='${c.layaway.definition.items[0].productId}'`))[0].stock_actual,100);
 await assert.rejects(submitManagement(db,refund(1603,cancelled.a,'1','100','1','EFECTIVO','layaway')),/REFUND_EXCESS/);
}finally{await db.close();}});
