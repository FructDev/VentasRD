// Local PostgreSQL only; no Supabase sessions, remote enrollment or business data.
import {createHash} from 'node:crypto';
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {inventorySetup,command,context,rpc,hash,canon,id,tenant,actor,branch,product,installation,device,stockCommand,submitManagement} from './sales-fixtures.mjs';
import {writeFile} from 'node:fs/promises';
function effectId(op,part){const h=createHash('sha256').update('ventard.local-effect.v1/'+op+'/'+part).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-${((parseInt(h[16],16)&3)|8).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`}
const migration=new URL('../../supabase/migrations/20261016165440_native_web_shared_journal_staging_v1.sql',import.meta.url);
async function setup(){const db=await inventorySetup();if(process.env.VENTARD_WEB_SHARED_RED==='1')return db;await db.exec('reset role');const sql=await readFile(migration,'utf8');await db.exec(sql);await db.exec(sql);await db.exec('set role authenticated');await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-ventard-journal':'stock-merge-1'})]);return db}
async function enroll(db){const r=await rpc(db,'native_web_enroll_v1',[tenant,id(8100),id(8101),branch,id(8102)]);return{tenantId:tenant,actorId:actor,installationId:id(8100),deviceId:id(8101),writerEpoch:r.writerEpoch,scopeType:'BRANCH',branchId:branch,permissionGrantId:id(8102)}}
function webSale(c,n,base,sequence){const wire=command(n),v=wire.intent,s=wire.snapshot;
 Object.assign(v,{installationId:c.installationId,originDeviceId:c.deviceId,permissionGrantId:c.permissionGrantId,writerEpoch:c.writerEpoch});
 const proof={productId:product,remoteBaseQty:base,remoteSequence:sequence,pending:[],effectiveQty:base};v.payload.sale.stockEvidence=[proof];v.payload.sale.inventory[0].expectedRevision=hash({quantity:base,remoteSequence:sequence,pending:[]});v.payload.quoteHash=hash(v.payload.sale);
 s.ticket='N'+c.installationId.replaceAll('-','')+'-'+String(n).padStart(6,'0');return wire}
const send=(db,c,w)=>rpc(db,'native_web_submit_v1',[c,canon(w.intent),hash(w.intent),canon(w.snapshot),hash(w.snapshot)]);
test('real browser checkout bytes are accepted unchanged and visible in the native feed',{skip:!process.env.VENTARD_SHARED_WEB_WIRE},async()=>{const db=await setup();try{
 const generated=JSON.parse(await readFile(process.env.VENTARD_SHARED_WEB_WIRE,'utf8')),c=await enroll(db);assert.deepEqual(generated.context,c);
 const first=command(8103);await rpc(db,'native_sales_submit_v1',[canon(first.intent),hash(first.intent),canon(first.snapshot),hash(first.snapshot)]);
 const w=generated.wire,r=await rpc(db,'native_web_submit_v1',[c,w.intent,w.intentHash,w.snapshot,w.snapshotHash]);assert.equal(r.stock[0].after,'98');assert.equal(r.totalCents,'11800');
 assert.deepEqual(await rpc(db,'native_web_submit_v1',[c,w.intent,w.intentHash,w.snapshot,w.snapshotHash]),r);
 const page=await rpc(db,'native_sales_feed_v1',[...context,'0']);assert.equal(page.events.length,2);assert.equal(page.events[1].intent,w.intent);assert.equal(page.events[1].snapshot,w.snapshot);
 await writeFile(new URL('../../scratch/shared-web-sale-server-evidence.json',import.meta.url),JSON.stringify({context:c,page}));
 }finally{await db.close()}});
test('actual browser product form bytes create metadata and stock once through the native journal',{skip:!process.env.VENTARD_SHARED_INVENTORY_WIRE},async()=>{const db=await setup();try{
 const generated=JSON.parse(await readFile(process.env.VENTARD_SHARED_INVENTORY_WIRE,'utf8')),c=await enroll(db);assert.deepEqual(c,generated.context);
 for(const wire of generated.packets){const receipt=await rpc(db,'native_web_submit_v1',[c,wire.intent,wire.intentHash,wire.snapshot,wire.snapshotHash]);assert.deepEqual(await rpc(db,'native_web_submit_v1',[c,wire.intent,wire.intentHash,wire.snapshot,wire.snapshotHash]),receipt)}
 const manifest=await rpc(db,'native_sales_bootstrap_v1',[...context,id(8190)]),page=await rpc(db,'native_sales_bootstrap_page_v1',[...context,manifest.snapshotId,0]);const p=JSON.parse(page.payload).find(p=>p.id===id(8180));assert.equal(p.stock.quantity,'5');assert.equal(p.priceTiers.retailCents,'2000');assert.equal(p.code,'00008180');
 assert.equal((await rpc(db,'native_web_feed_v1',[c,'0'])).events.length,2);
 }finally{await db.close()}});
test('web and native share one ledger, stock revision and exact receipt after lost response',async()=>{const db=await setup();try{
 const c=await enroll(db);assert.deepEqual(await enroll(db),c);
 const native=command(8103);const a=await rpc(db,'native_sales_submit_v1',[canon(native.intent),hash(native.intent),canon(native.snapshot),hash(native.snapshot)]);
 const web=webSale(c,8104,'99',a.remoteSequence);const r=await send(db,c,web);assert.equal(r.status,'APPLIED');assert.equal(r.stock[0].after,'98');
 assert.deepEqual(await send(db,c,web),r);assert.deepEqual(await rpc(db,'native_web_lookup_v1',[c,id(8104),hash(web.intent)]),r);
 const nativeFeed=await rpc(db,'native_sales_feed_v1',[...context,'0']),webFeed=await rpc(db,'native_web_feed_v1',[c,'0']);assert.deepEqual(nativeFeed,webFeed);assert.equal(webFeed.events.length,2);
 assert.equal((await rpc(db,'native_web_mode_v1',[tenant,branch])).mode,'SHARED_JOURNAL');
 await assert.rejects(db.exec('update productos set stock_actual=999'),/NATIVE_LEGACY_WRITER_FENCED/);
 const forged=webSale(c,8105,'101','0');await assert.rejects(send(db,c,forged),/STOCK|VERSION/);
 assert.equal((await rpc(db,'native_web_feed_v1',[c,'0'])).watermark,'2');
 const changed=structuredClone(web);changed.intent.originAtUtcMs='1791712800001';await assert.rejects(send(db,c,changed),/CONFLICT/);
 }finally{await db.close()}});
test('browser enrollment cannot clone a desktop writer and renewed grant keeps original pending bytes valid',async()=>{const db=await setup();try{
 await assert.rejects(rpc(db,'native_web_enroll_v1',[tenant,installation,device,branch,id(8120)]),/INSTALLATION_ALREADY_NATIVE/);
 assert.equal((await rpc(db,'native_web_mode_v1',[tenant,id(8129)])).mode,'SCOPE_BLOCKED');
 const c=await enroll(db),wire=webSale(c,8121,'100','0');
 await rpc(db,'native_web_enroll_v1',[tenant,c.installationId,c.deviceId,branch,id(8122)]);
 assert.equal((await send(db,c,wire)).status,'APPLIED');
 await db.exec('reset role');await db.query('update native_installations_v1 set status=$1 where installation_id=$2',['REVOKED',c.installationId]);await db.exec('set role authenticated');
 await assert.rejects(send(db,c,webSale(c,8123,'99','1')),/CONTEXT_DENIED/);
 }finally{await db.close()}});

test('a seller can join the prepared browser with its own session, but cannot register a different device or manage inventory',async()=>{const db=await setup();try{
 const owner=await enroll(db);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(7)]);
 const registration=id(8140),r=await rpc(db,'native_web_enroll_v1',[tenant,owner.installationId,owner.deviceId,branch,registration]);assert.equal(r.role,'vendedor');
 const seller={...owner,actorId:id(7),permissionGrantId:registration},sale=webSale(seller,8141,'100','0');sale.intent.actorId=id(7);sale.snapshot.actorId=id(7);assert.equal((await send(db,seller,sale)).status,'APPLIED');
 await assert.rejects(rpc(db,'native_web_enroll_v1',[tenant,owner.installationId,id(8142),branch,id(8143)]),/ALREADY_NATIVE|CONTEXT_MISMATCH|IDENTITY_CONFLICT/);
 await assert.rejects(rpc(db,'native_web_enroll_v1',[tenant,id(8144),id(8145),branch,id(8146)]),/OWNER_SETUP_REQUIRED/);
 assert.equal((await rpc(db,'native_web_feed_v1',[seller,'0'])).events.length,1);
 }finally{await db.close()}});
test('web channel rejects forged contexts, direct table grants, fiscal and other actor without effects',async()=>{const db=await setup();try{
 const c=await enroll(db),w=webSale(c,8110,'100','0');
 await assert.rejects(send(db,{...c,deviceId:id(8199)},w),/CONTEXT_DENIED/);
 const forged=structuredClone(w);forged.intent.installationId=id(8198);await assert.rejects(send(db,c,forged),/INTENT_CONTEXT_DENIED/);
 const fiscal=structuredClone(w);fiscal.snapshot.ncf='B0200000001';await assert.rejects(send(db,c,fiscal),/FISCAL_DEFERRED/);
 await assert.rejects(db.query('select * from native_web_channels_v1'),/permission denied/);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(8)]);await assert.rejects(send(db,c,w),/CONTEXT_DENIED/);await assert.rejects(rpc(db,'native_web_mode_v1',[tenant,branch]),/ACCESS_DENIED/);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);assert.equal((await rpc(db,'native_web_feed_v1',[c,'0'])).watermark,'0');
 }finally{await db.close()}});

test('simultaneous sales commute with exact original bytes; a physical count, forged base and outdated client do not',async()=>{const db=await setup();try{
 const c=await enroll(db),first=command(8160),web=webSale(c,8161,'100','0'),intent=canon(web.intent),snapshot=canon(web.snapshot);
 await rpc(db,'native_sales_submit_v1',[canon(first.intent),hash(first.intent),canon(first.snapshot),hash(first.snapshot)]);
 const receipt=await send(db,c,web);assert.equal(receipt.stock[0].after,'98');assert.equal(receipt.stock[0].merge.quotedBefore,'100');assert.equal(receipt.stock[0].merge.appliedBefore,'99');assert.equal(receipt.stock[0].merge.concurrent.length,1);assert.equal(receipt.stock[0].merge.concurrent[0].operationId,id(8160));assert.deepEqual(await send(db,c,web),receipt);
 const page=await rpc(db,'native_web_feed_v1',[c,'0']);assert.equal(page.events[1].intent,intent);assert.equal(page.events[1].snapshot,snapshot);assert.equal(page.events[1].receipt.totalCents,'11800');
 await assert.rejects(send(db,c,webSale(c,8162,'101','0')),/STOCK_COVERAGE_INVALID/);assert.equal((await rpc(db,'native_web_feed_v1',[c,'0'])).watermark,'2');
 await db.query("select set_config('request.headers',$1,false)",['{}']);await assert.rejects(rpc(db,'native_sales_feed_v1',[...context,'0']),/SHARED_UPGRADE_REQUIRED/);const old=command(8163);await assert.rejects(rpc(db,'native_sales_submit_v1',[canon(old.intent),hash(old.intent),canon(old.snapshot),hash(old.snapshot)]),/SHARED_UPGRADE_REQUIRED/);assert.equal((await rpc(db,'native_web_feed_v1',[c,'0'])).events.length,2);
 }finally{await db.close()}
 const db2=await setup();try{const c=await enroll(db2);await submitManagement(db2,stockCommand(8164,{pid:product,before:'100',base:'100',sequence:'0',mode:'COUNT',quantity:'100'}));await assert.rejects(send(db2,c,webSale(c,8165,'100','0')),/STOCK_COUNT_REVIEW_REQUIRED/);assert.equal((await rpc(db2,'native_web_feed_v1',[c,'0'])).events.length,1)}finally{await db2.close()}
});

test('two pending browser sales and another native sale preserve own coverage and original availability',async()=>{const db=await setup();try{
 const c=await enroll(db),native=command(8170),first=webSale(c,8171,'100','0'),second=webSale(c,8172,'99','0');
 const proof={productId:product,remoteBaseQty:'100',remoteSequence:'0',pending:[{operationId:id(8171),effectId:effectId(id(8171),'stock/'+product),delta:'-1'}],effectiveQty:'99'};
 second.intent.payload.sale.stockEvidence=[proof];second.intent.payload.sale.inventory[0].expectedRevision=hash({quantity:'99',remoteSequence:'0',pending:proof.pending});second.intent.payload.quoteHash=hash(second.intent.payload.sale);
 await rpc(db,'native_sales_submit_v1',[canon(native.intent),hash(native.intent),canon(native.snapshot),hash(native.snapshot)]);await send(db,c,first);
 const result=await send(db,c,second);assert.equal(result.stock[0].after,'97');assert.equal(result.stock[0].merge.concurrent.length,1);assert.equal(result.stock[0].merge.concurrent[0].operationId,id(8170));assert.deepEqual(await send(db,c,second),result);
 }finally{await db.close()}
 const empty=await setup();try{const c=await enroll(empty);await submitManagement(empty,stockCommand(8173,{pid:product,before:'100',base:'100',mode:'COUNT',quantity:'0'}));await submitManagement(empty,stockCommand(8174,{pid:product,before:'0',base:'0',sequence:'1',mode:'IN',quantity:'1'}));await assert.rejects(send(empty,c,webSale(c,8175,'0','1')),/STOCK_UNAVAILABLE/);assert.equal((await rpc(empty,'native_web_feed_v1',[c,'0'])).watermark,'2')}finally{await empty.close()}
});

test('deployment verification uses existing contexts in a read-only transaction without enrollment or effects',async()=>{const db=await setup();try{
 await db.exec('reset role');const before=(await db.query('select count(*)::text as n from native_web_channels_v1')).rows[0].n;
 const result=await db.exec(await readFile(new URL('./staging-shared-journal-readonly-verify.sql',import.meta.url),'utf8'));assert.match(JSON.stringify(result),/SHARED_JOURNAL_READONLY_PASS/);
 assert.equal((await db.query('select count(*)::text as n from native_web_channels_v1')).rows[0].n,before);assert.equal((await db.query('select count(*)::text as n from native_sales_ledger_v1')).rows[0].n,'0');
 }finally{await db.close()}});
