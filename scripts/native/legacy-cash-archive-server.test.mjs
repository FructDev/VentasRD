// Real isolated PG. Archival consent never replays old sale/cash effects.
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {cutoverSetup,cutoverPlan,cutoverSubmit,cutoverContext as ctx} from './cutover-server.test.mjs';
import {legacyServicesSetup,legacyServicesPlan,legacySourceWrite} from './legacy-services-server.test.mjs';
const sql=await readFile(new URL('../../supabase/migrations/20261014151242_native_legacy_cash_archive_staging_v1.sql',import.meta.url),'utf8');
test('legacy cash archive: explicit exact consent, CAS, source preservation, no replay and closed cash guard',async()=>{const db=await cutoverSetup();try{
 await db.exec('reset role');await db.exec('alter table ventas add column caja_id uuid,add column metodo_pago text,add column total numeric,add column monto_efectivo numeric');await db.exec(sql);await db.exec(sql);
 await db.query('insert into ventas(id,negocio_id,sucursal_id,estado,caja_id,metodo_pago,total) values($1,$2,$3,$4,null,$5,10)',['96200000-0000-4000-8000-000000002001',ctx.tenantId,ctx.branchId,'cerrada','efectivo']);await db.exec('set role authenticated');
 const plan=await cutoverPlan(db);await assert.rejects(cutoverSubmit(db,plan),/CASH_HISTORY_CONFIRMATION_REQUIRED/);await assert.rejects(cutoverSubmit(db,{...plan,legacyCashHistoryConfirmed:false}),/CASH_HISTORY_CONFIRMATION_REQUIRED/);await assert.rejects(cutoverSubmit(db,{...plan,legacyCashHistoryConfirmed:'true'}),/CUTOVER_INVALID/);
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from native_sales_mode_v1')).rows[0].n,0);await db.exec('set role authenticated');
 const confirmed={...plan,legacyCashHistoryConfirmed:true};const receipt=await cutoverSubmit(db,confirmed);assert.equal(receipt.legacyReplay,false);assert.deepEqual(await cutoverSubmit(db,confirmed),receipt);await assert.rejects(cutoverSubmit(db,plan),/ID_CONFLICT/);
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from native_sales_ledger_v1')).rows[0].n,0);const sale=(await db.query('select caja_id,total,metodo_pago from ventas')).rows[0];assert.equal(sale.caja_id,null);assert.equal(String(sale.total),'10');assert.equal(sale.metodo_pago,'efectivo');
}finally{await db.close();}});
test('legacy cash archive: preserves the installed legacy-service wrapper and both confirmations',async()=>{const db=await legacyServicesSetup();try{
 await db.exec('reset role');await db.exec('alter table ventas add column caja_id uuid,add column metodo_pago text,add column total numeric,add column monto_efectivo numeric');await db.exec(sql);await db.exec(sql);await db.exec('set role authenticated');
 await legacySourceWrite(db,'insert into ventas(id,negocio_id,sucursal_id,estado,metodo_pago,total) values($1,$2,$3,$4,$5,10)',['96200000-0000-4000-8000-000000002021',ctx.tenantId,ctx.branchId,'cerrada','efectivo']);
 const plan=await legacyServicesPlan(db);await assert.rejects(cutoverSubmit(db,plan),/CASH_HISTORY_CONFIRMATION_REQUIRED/);
 const receipt=await cutoverSubmit(db,{...plan,legacyCashHistoryConfirmed:true});assert.equal(receipt.legacyReplay,false);assert.equal(receipt.status,'BASELINE_ADOPTED');
}finally{await db.close();}});
test('legacy cash archive: archival consent cannot authorize an open web cash drawer',async()=>{const db=await cutoverSetup();try{
 await db.exec('reset role');await db.exec(sql);await db.query('insert into cajas values($1,$2,$3,$4)',['96200000-0000-4000-8000-000000002010',ctx.tenantId,ctx.branchId,'abierta']);await db.exec('set role authenticated');const plan=await cutoverPlan(db);await assert.rejects(cutoverSubmit(db,{...plan,legacyCashHistoryConfirmed:true}),/CLOSE_WEB_CASH/);
}finally{await db.close();}});
