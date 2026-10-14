// PostgreSQL engine, synthetic records; no remote service or business data.
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';
import {setup,command,context,rpc,canon,hash,id,tenant,actor,product} from './sales-server.test.mjs';
import {repairSetup,base,envelope,action,stock} from './repairs-server.test.mjs';
import {refund} from './service-refunds-server.test.mjs';
import {openTurn,submitManagement} from './sales-server.test.mjs';
const sql=await readFile(new URL('../../supabase/migrations/20261014190051_native_history_bootstrap_staging_v1.sql',import.meta.url),'utf8');
const submit=(db,c)=>rpc(db,'native_sales_submit_v1',[canon(c.intent),hash(c.intent),canon(c.snapshot),hash(c.snapshot)]);
test('history bootstrap: frozen historical sales with original bytes, bounded pages, replay and ACL',async()=>{const db=await setup();try{
 await db.exec('reset role');await db.exec(sql);await db.exec(sql);await db.exec('set role authenticated');
 await rpc(db,'native_sales_activate_v1',[...context,'QA_SYNTHETIC_QUIESCED','0.18']);
 const c=command(1900);await submit(db,c);const snapshot=id(1990),m=await rpc(db,'native_sales_bootstrap_v1',[...context,snapshot]);
 assert.equal(m.historyCoverage,'NATIVE_LEDGER_THROUGH_WATERMARK');assert.equal(m.historyCount,1);
 const rows=[];for(const p of m.pages){const result=await rpc(db,'native_sales_bootstrap_page_v1',[...context,snapshot,p.index]);assert.equal(Buffer.byteLength(result.payload),p.byteLength);assert.equal(hash(result.payload),p.sha256);rows.push(...JSON.parse(result.payload));}
 const history=rows.filter(r=>r.kind==='HISTORY_EVENT');assert.equal(history.length,1);assert.equal(history[0].event.intent,canon(c.intent));assert.equal(history[0].event.snapshot,canon(c.snapshot));assert.equal(history[0].event.receipt.intentHash,hash(c.intent));assert.equal(rows.find(r=>r.id===product).stock.quantity,'99');
 await db.exec('reset role');const before=(await db.query(`select count(*)::int n from native_sales_ledger_v1 where negocio_id='${tenant}'`)).rows[0].n;await db.exec('set role authenticated');
 assert.deepEqual(await rpc(db,'native_sales_bootstrap_v1',[...context,snapshot]),m);
 const later=command(1901);later.intent.payload.sale.stockEvidence[0]={productId:product,remoteBaseQty:'99',remoteSequence:'1',pending:[],effectiveQty:'99'};later.intent.payload.sale.inventory[0].expectedRevision=hash({quantity:'99',remoteSequence:'1',pending:[]});later.snapshot.sale=later.intent.payload.sale;later.intent.payload.quoteHash=hash(later.intent.payload.sale);await submit(db,later);
 assert.deepEqual(await rpc(db,'native_sales_bootstrap_v1',[...context,snapshot]),m);
 const current=await rpc(db,'native_sales_bootstrap_v1',[...context,id(1991)]);assert.equal(current.historyCount,2);
 await assert.rejects(rpc(db,'native_sales_bootstrap_history_base_v1',[...context,id(1992)]),/permission denied/);
 await assert.rejects(rpc(db,'native_sales_bootstrap_v1',[...context.slice(0,1),id(88),...context.slice(2),id(1993)]),/CONTEXT/);
 await db.exec('reset role');assert.equal((await db.query(`select count(*)::int n from native_sales_ledger_v1 where negocio_id='${tenant}'`)).rows[0].n,before+1);await db.exec('set role authenticated');
 if(process.env.VENTARD_HISTORY_CAPTURE_FIXTURE){
  const fresh=[tenant,id(1997),id(1998),'1',context[4],context[5]];
  await rpc(db,'native_registrar_instalacion_v1',[id(1999),tenant,fresh[1],fresh[2],fresh[4],fresh[5]]);
  const manifest=await rpc(db,'native_sales_bootstrap_v1',[...fresh,id(1996)]),pages=[];
  for(const p of manifest.pages)pages.push((await rpc(db,'native_sales_bootstrap_page_v1',[...fresh,manifest.snapshotId,p.index])).payload);
  await writeFile(process.env.VENTARD_HISTORY_CAPTURE_FIXTURE,JSON.stringify({manifest,pages}));
 }
}finally{await db.close();}});
test('history bootstrap: latest service capture and refunds survive full history without replay',async()=>{const db=await repairSetup();try{
 await db.exec('reset role');await db.exec(await readFile(new URL('../../supabase/migrations/20261014143238_native_service_refunds_staging_v1.sql',import.meta.url),'utf8'));await db.exec(sql);await db.exec(sql);await db.exec('set role authenticated');await openTurn(db);
 const original=base(1950);await submitManagement(db,envelope(1950,original.request,original.repair,await stock(db,-2),'100'));
 const cancelled=action(1951,original.repair,'CANCEL');cancelled.payload.request.warrantyDays='0';cancelled.payload.document.stock=await stock(db,2);await submitManagement(db,cancelled);
 await submitManagement(db,refund(1952,cancelled.payload.document.repair,'0','0','40'));
 const fresh=[tenant,id(1987),id(1988),'1',context[4],context[5]];await rpc(db,'native_registrar_instalacion_v1',[id(1989),tenant,fresh[1],fresh[2],fresh[4],fresh[5]]);
 const manifest=await rpc(db,'native_sales_bootstrap_v1',[...fresh,id(1986)]),pages=[];for(const p of manifest.pages)pages.push((await rpc(db,'native_sales_bootstrap_page_v1',[...fresh,manifest.snapshotId,p.index])).payload);
 const rows=pages.flatMap(p=>JSON.parse(p));assert.equal(rows.filter(r=>r.kind==='HISTORY_EVENT').length,4);assert.equal(manifest.serviceRefunds.length,1);assert.equal(rows.find(r=>r.kind==='REPAIR').event.receipt.operationId,id(1951));assert.equal(manifest.cashBase.netCents,'60');
 assert.deepEqual(await rpc(db,'native_sales_bootstrap_v1',[...fresh,id(1986)]),manifest);
 if(process.env.VENTARD_HISTORY_SERVICE_FIXTURE)await writeFile(process.env.VENTARD_HISTORY_SERVICE_FIXTURE,JSON.stringify({manifest,pages}));
}finally{await db.close();}});
