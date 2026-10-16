// Isolated PostgreSQL engine, synthetic fixtures; no Supabase connection.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {readdir} from 'node:fs/promises';
import {id,tenant,other,importWire,importIdentity,actor,device,installation,branch,product,customer,grant,canon,hash,setup,rpc,context,managementSetup,managementCommand,submitManagement,inventorySetup,productCommand,stockCommand,activate,admin,command,submit,openTurn} from './sales-fixtures.mjs';
export {setup,inventorySetup,productCommand,stockCommand,command,managementCommand,submitManagement,openTurn,context,rpc,hash,canon,id,product,tenant,actor,installation,device,branch} from './sales-fixtures.mjs';

test('inventory: native import wire is accepted unchanged and replayed without duplicate stock',{skip:!importWire},async()=>{const db=await inventorySetup();try{
 assert.equal(importWire.length,2);assert.equal(importIdentity.negocioId,tenant);const receipts=[];
 for(const packet of importWire){assert.equal(createHash('sha256').update(packet.bytes).digest('hex'),packet.hash);const r=await rpc(db,'native_sales_submit_v1',[packet.bytes,packet.hash,null,null]);receipts.push(r);assert.deepEqual(await rpc(db,'native_sales_submit_v1',[packet.bytes,packet.hash,null,null]),r)}
 const pid=importIdentity.payload.request.productId;const row=(await admin(db,`select stock_actual,precio_venta,codigo_barras from productos where id='${pid}'`))[0];assert.equal(row.stock_actual,7);assert.equal(Number(row.precio_venta),1500.01);assert.equal(row.codigo_barras,'000000000000001');
 const manifest=await rpc(db,'native_sales_bootstrap_v1',[...context,id(999)]),page=await rpc(db,'native_sales_bootstrap_page_v1',[...context,manifest.snapshotId,'0']);const found=JSON.parse(page.payload).find(p=>p.id===pid);assert.equal(found.stock.quantity,'7');assert.equal(found.priceTiers.retailCents,'150001');assert.equal(receipts[1].stock[0].after,'7');
}finally{await db.close()}});

test('fiscal settings: central CAS, retained cursor, exact replay and abandonment tombstone',async()=>{const db=await inventorySetup();try{
 await db.exec('reset role');const sql=await readFile(new URL('../../supabase/migrations/20261013041548_native_fiscal_settings_staging_v1.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);await db.exec('set role authenticated');
 const read=()=>rpc(db,'native_fiscal_settings_read_v1',context);const current=await read();
 const request={protocol:'ventard.fiscal.settings.request.1',version:'1',requestId:id(970),actorId:actor,tenantId:tenant,installationId:installation,deviceId:device,writerEpoch:'1',scopeType:'BRANCH',branchId:branch,permissionGrantId:grant,expectedRevision:current.configuration.revision,type:'B02',first:'1',last:'2000',enabled:true};
 const submit=v=>rpc(db,'native_fiscal_settings_submit_v1',[canon(v),hash(v)]),lookup=v=>rpc(db,'native_fiscal_settings_lookup_v1',[canon(v),hash(v)]),abandon=v=>rpc(db,'native_fiscal_settings_abandon_v1',[canon(v),hash(v)]);
 assert.equal((await lookup(request)).status,'NOT_FOUND');const applied=await submit(request);assert.equal(applied.status,'APPLIED');assert.equal(applied.configuration.next,'1');assert.deepEqual(await submit(request),applied);
 await admin(db,`insert into native_sales_write_context_v1 values(txid_current(),'${tenant}');update ncf_secuencias set proximo=21 where negocio_id='${tenant}';delete from native_sales_write_context_v1 where transaction_id=txid_current();`);
 const fresh=await read();const second={...request,requestId:id(971),expectedRevision:fresh.configuration.revision,enabled:false};const disabled=await submit(second);assert.equal(disabled.configuration.next,'21');assert.equal(disabled.configuration.enabled,false);
 await assert.rejects(submit({...second,requestId:id(972),last:'10'}),/FISCAL_SETTINGS_VERSION_CONFLICT/);
 const third={...second,requestId:id(973),expectedRevision:(await read()).configuration.revision,enabled:true};const cancelled=await abandon(third);assert.equal(cancelled.status,'ABANDONED');assert.deepEqual(await submit(third),cancelled);assert.equal((await read()).configuration.enabled,false);assert.deepEqual(await abandon(request),applied);
 await assert.rejects(submit({...third,requestId:id(975),last:'10'}),/FISCAL_SETTINGS_ALLOCATED_RANGE_CONFLICT/);
 await assert.rejects(submit({...third,requestId:id(976),url:'https://invalid.test'}),/FISCAL_SETTINGS_REQUEST_INVALID/);
 await assert.rejects(submit({...request,last:'3000'}),/FISCAL_SETTINGS_ID_CONFLICT/);
 const wrong={...third,requestId:id(974),type:'B01'};await assert.rejects(submit(wrong),/FISCAL_SETTINGS_KIND_TRANSITION_REQUIRED/);
 assert.equal((await admin(db,`select proximo from ncf_secuencias where negocio_id='${tenant}'`))[0].proximo,21);
 await assert.rejects(submit({...third,actorId:id(7)}),/FISCAL_SETTINGS_CONTEXT_DENIED/);
 await assert.rejects(db.query('select * from native_fiscal_settings_ledger_v1'),/permission denied/);
 await admin(db,`insert into native_sales_write_context_v1 values(txid_current(),'${tenant}');update ncf_secuencias set tipo=null where negocio_id='${tenant}';delete from native_sales_write_context_v1 where transaction_id=txid_current();`);await assert.rejects(read(),/FISCAL_SETTINGS_SOURCE_UNVERIFIABLE/);
 await admin(db,`update native_staging_licenses_v1 set access_until_ms=1 where negocio_id='${tenant}'`);await assert.rejects(read(),/NATIVE_LICENSE_DENIED|FISCAL_SETTINGS_CONTEXT_DENIED/);
}finally{await db.close()}});

test('inventory: versioned creation, metadata patch, exact pending stock coverage and count conflict',async()=>{const db=await inventorySetup();try{
 const create=productCommand(500),r=await submitManagement(db,create);assert.equal(r.stock[0].after,'0');assert.deepEqual(await submitManagement(db,create),r);
 const createPending=[{operationId:id(500),effectId:r.effects[1].id,delta:'0'}],entry=stockCommand(501,{pending:createPending});const sr=await submitManagement(db,entry);assert.equal(sr.stock[0].after,'7');assert.deepEqual(await submitManagement(db,entry),sr);
 const patch=productCommand(502,'1');await submitManagement(db,patch);assert.equal((await admin(db,`select stock_actual from productos where id='${id(300)}'`))[0].stock_actual,7);await assert.rejects(submitManagement(db,productCommand(503,'1')),/VERSION_CONFLICT/);
 const pending=[...createPending,{operationId:id(501),effectId:sr.effects[1].id,delta:'7'}],count=stockCommand(504,{before:'7',pending,mode:'COUNT',quantity:'4',productRevision:'2'});const cr=await submitManagement(db,count);assert.equal(cr.stock[0].after,'4');assert.deepEqual(await submitManagement(db,count),cr);
 await assert.rejects(submitManagement(db,stockCommand(505,{before:'7',pending,mode:'COUNT',quantity:'20',productRevision:'2'})),/STOCK_VERSION_CONFLICT/);
 assert.equal((await admin(db,`select stock_actual from productos where id='${id(300)}'`))[0].stock_actual,4);
 const manifest=await rpc(db,'native_sales_bootstrap_v1',[...context,id(590)]),page=await rpc(db,'native_sales_bootstrap_page_v1',[...context,manifest.snapshotId,'0']),p=JSON.parse(page.payload).find(x=>x.id===id(300));assert.equal(p.revision,'2');assert.equal(p.metadata.location,'A-2');assert.equal(p.metadata.minimum,'3');
 await assert.rejects(rpc(db,'native_inventory_submit_v1',[canon(create),hash(create),null,null]),/permission denied/);
}finally{await db.close();}});

test('inventory: recipe valuation, serial uniqueness and rollback under the same fence',async()=>{const db=await inventorySetup();try{
 await submitManagement(db,productCommand(600));const combo=productCommand(601);combo.payload.request.productId=id(610);const def=combo.payload.request.definition;Object.assign(def,{code:'COMBO-QA',productType:'combo',costCents:'840',recipe:[{productId:id(300),numerator:'7',denominator:'50'}]});const p=combo.payload.document.product;p.id=id(610);p.code=def.code;Object.assign(p.metadata,{productType:'combo',costCents:'840',recipeCostPolicy:'NATIVE_EXACT',recipe:[{productId:id(300),perUnit:{numerator:'7',denominator:'50'},revision:'1'}]});await submitManagement(db,combo);
 assert.equal(String((await admin(db,`select native_product_cost_v1('${tenant}','${id(610)}')::bigint::text as cost`))[0].cost),'840');const patch=productCommand(602,'1');patch.payload.request.definition.costCents='5000';patch.payload.document.product.metadata.costCents='5000';await submitManagement(db,patch);assert.equal(String((await admin(db,`select native_product_cost_v1('${tenant}','${id(610)}')::bigint::text as cost`))[0].cost),'700');
 const wrong=productCommand(603);wrong.payload.request.productId=id(611);wrong.payload.document.product.id=id(611);wrong.payload.request.definition.code='WRONG';wrong.payload.document.product.code='WRONG';wrong.payload.document.product.metadata.taxRate={numerator:'0',denominator:'1'};await assert.rejects(submitManagement(db,wrong),/DOCUMENT_INVALID/);assert.equal((await admin(db,`select count(*) n from productos where id='${id(611)}'`))[0].n,0);
 const serial=productCommand(604);serial.payload.request.productId=id(612);serial.payload.document.product.id=id(612);serial.payload.request.definition.code='IMEI';serial.payload.document.product.code='IMEI';serial.payload.request.definition.serialRequired=true;serial.payload.document.product.metadata.serialRequired=true;const r=await submitManagement(db,serial);
 const pending=[{operationId:id(604),effectId:r.effects[1].id,delta:'0'}],entry=stockCommand(605,{pid:id(612),pending,quantity:'2',serials:['IMEI-1','IMEI-1']});await assert.rejects(submitManagement(db,entry),/SERIAL_INVALID/);assert.equal((await admin(db,`select stock_actual from productos where id='${id(612)}'`))[0].stock_actual,0);entry.payload.request.serials=['IMEI-1','IMEI-2'];entry.payload.document.serials=['IMEI-1','IMEI-2'];const sr=await submitManagement(db,entry);assert.equal(sr.stock[0].after,'2');assert.deepEqual(await submitManagement(db,entry),sr);assert.equal((await admin(db,'select count(*) n from seriales'))[0].n,2);
}finally{await db.close();}});

test('inventory: metadata revisions invalidate stale sale lines and never increment stock versions',async()=>{const db=await inventorySetup();try{
 const patch=productCommand(620,'1'),d=patch.payload.request.definition,p=patch.payload.document.product;patch.payload.request.productId=product;p.id=product;Object.assign(d,{name:'Producto sintético',code:'0001',priceCents:'10000',tier2Cents:'9000',tier3Cents:'8000',location:'',minimum:'0'});Object.assign(p,{name:d.name,code:d.code,priceTiers:{retailCents:'10000',tier2Cents:'9000',tier3Cents:'8000'}});Object.assign(p.metadata,{location:'',minimum:'0'});await submitManagement(db,patch);await assert.rejects(submit(db,command(621)),/PRODUCT_VERSION_CONFLICT/);const sale=command(622);sale.intent.payload.sale.lines[0].productRevision='2';sale.snapshot.sale=sale.intent.payload.sale;sale.intent.payload.quoteHash=hash(sale.intent.payload.sale);const r=await submit(db,sale);assert.equal(r.stock[0].after,'99');await assert.rejects(db.exec('update native_product_metadata_v1 set revision=99'),/permission denied/);
}finally{await db.close();}});

test('management: metadata revisions, deleted debt preservation, role isolation and exact replay',async()=>{const db=await managementSetup();try{
 const cid=id(31),cu={id:cid,name:'Ana QA',phone:'8095550100',limitCents:'50000',priceTier:2,wholesale:true,active:true,revision:'1'};
 const v=managementCommand(400,'CUSTOMER_CREATE',{kind:'CUSTOMER_SAVE',customerId:cid,expectedRevision:'0',name:cu.name,phone:cu.phone,limitCents:cu.limitCents,priceTier:cu.priceTier,wholesale:cu.wholesale},{customer:cu});
 const r=await submitManagement(db,v);assert.equal(r.status,'APPLIED');assert.deepEqual(await submitManagement(db,v),r);assert.equal(r.effects[0].payload.customer.name,cu.name);
 const nullName=structuredClone(v);nullName.operationId=nullName.payload.request.operationId=id(403);nullName.payload.request.customerId=nullName.payload.document.customer.id=id(33);nullName.payload.request.name=nullName.payload.document.customer.name=null;await assert.rejects(submitManagement(db,nullName),/CUSTOMER_INVALID/);
 const bad=structuredClone(v);bad.payload.request.name='Otra';await assert.rejects(submitManagement(db,bad),/CONFLICT/);
 const patch=managementCommand(401,'CUSTOMER_PATCH',{...v.payload.request,expectedRevision:'1',name:'Ana actualizada'},{customer:{...cu,name:'Ana actualizada',revision:'2'}});await submitManagement(db,patch);
 const m=await rpc(db,'native_sales_bootstrap_v1',[...context,id(450)]);const page=await rpc(db,'native_sales_bootstrap_page_v1',[...context,id(450),0]);const row=JSON.parse(page.payload).find(x=>x.id===cid);assert.equal(row.metadataRevision,'2');assert.equal(row.phone,cu.phone);assert.equal(m.business.name,'PRO00 QA A - SINTETICO');
 const b=structuredClone(patch);b.operationId=id(402);b.payload.request.operationId=id(402);await assert.rejects(submitManagement(db,b),/VERSION/);
 assert.equal((await admin(db,'select count(*) as n from native_sales_ledger_v1'))[0].n,2);
 await assert.rejects(db.query('select * from native_customer_metadata_v1'),/permission denied/);await assert.rejects(rpc(db,'native_sales_submit_base_v1',[canon(command(460).intent),hash(command(460).intent),null,null]),/permission denied/);
 }finally{await db.close();}});

test('management: abonos, expense cash separation, count and closed-turn rejection',async()=>{const db=await managementSetup();try{
 await openTurn(db);await admin(db,'update native_sales_credit_v1 set balance_cents=12345');
 const v=managementCommand(410,'CREDIT_PAYMENT',{kind:'CREDIT_PAYMENT',customerId:customer,expectedRevision:'1',amountCents:'2345',method:'TARJETA',concept:'Abono',turnId:id(90)},{customerId:customer,balanceBeforeCents:'12345',balanceAfterCents:'10000',balanceRevision:'2',amountCents:'2345',method:'TARJETA',concept:'Abono',cashDeltaCents:'0'},id(90));
 const r=await submitManagement(db,v);assert.deepEqual(await submitManagement(db,v),r);assert.equal((await admin(db,'select balance_cents from native_sales_credit_v1'))[0].balance_cents,10000);
 const expense=managementCommand(411,'EXPENSE_RECORD',{kind:'EXPENSE_RECORD',amountCents:'1000',method:'EFECTIVO',concept:'Transporte',category:'transporte',turnId:id(90)},{amountCents:'1000',method:'EFECTIVO',concept:'Transporte',category:'transporte',cashDeltaCents:'-1000'},id(90));await submitManagement(db,expense);
 const feed=await rpc(db,'native_sales_feed_v1',[...context,'0']);assert.equal(feed.cashBase.netCents,'-1000');assert.equal(feed.cashBase.sequence,'3');
 const close=managementCommand(412,'TURN_CLOSE',{kind:'TURN_CLOSE',turnId:id(90),countedCents:'50000',denominations:[{valueCents:'10000',count:'5'}]},{drawer:{turnId:id(90),status:'OPEN',openingCents:'50000',openedAtMs:'1791712800000',netCashCents:'-1000',expectedCents:'49000'},countedCents:'50000',differenceCents:'1000',denominations:[{valueCents:'10000',count:'5'}],notes:null},id(90));const bad=structuredClone(close);bad.payload.document.drawer.expectedCents='50000';await assert.rejects(submitManagement(db,bad),/CASH_VERSION/);assert.equal((await admin(db,'select status from native_sales_turns_v1'))[0].status,'OPEN');await submitManagement(db,close);assert.deepEqual(await submitManagement(db,close),(await submitManagement(db,close)));assert.equal((await admin(db,'select status from native_sales_turns_v1'))[0].status,'CLOSED');const late=structuredClone(expense);late.operationId=late.payload.request.operationId=id(413);await assert.rejects(submitManagement(db,late),/TURN_REQUIRED/);
 }finally{await db.close();}});

test('management: seller cannot mutate customer metadata and remote count validation rolls back',async()=>{const db=await managementSetup();try{
 const opening=command(420).intent;opening.kind='TURN_OPEN';opening.payload={openingCents:'50000',denominations:[{valueCents:'10000',count:'4'}]};opening.expectedVersions={drawer:'0'};await assert.rejects(submitManagement(db,opening),/COUNT_INVALID/);assert.equal((await admin(db,'select count(*) as n from native_sales_ledger_v1'))[0].n,0);opening.payload.denominations[0].count='5';await submitManagement(db,opening);assert.deepEqual(await submitManagement(db,opening),await submitManagement(db,opening));
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(7)]);await rpc(db,'native_registrar_instalacion_v1',[id(470),tenant,installation,device,'BRANCH',branch]);
 const cu={id:id(34),name:'No permitido',phone:null,limitCents:'0',priceTier:1,wholesale:false,active:true,revision:'1'},v=managementCommand(421,'CUSTOMER_CREATE',{kind:'CUSTOMER_SAVE',customerId:cu.id,expectedRevision:'0',name:cu.name,phone:null,limitCents:'0',priceTier:1,wholesale:false},{customer:cu});v.actorId=id(7);v.permissionGrantId=id(470);await assert.rejects(submitManagement(db,v),/CONTEXT_INVALID/);assert.equal((await admin(db,'select count(*) as n from native_sales_ledger_v1'))[0].n,1);
 }finally{await db.close();}});

test('real source columns: cantidad_necesaria drives combo effects and eliminado rejects deleted recipients',async()=>{
 const db=await setup();try{
 await admin(db,`insert into productos values('${id(21)}','${tenant}','Combo QA','COMBO',120,80,0,.18,'combo',false,false,null,null);insert into inventario_sucursales values('${branch}','${id(21)}',0);insert into composiciones values('${id(22)}','${tenant}','${id(21)}','${product}',2)`);
 await activate(db);
 const manifest=await rpc(db,'native_sales_bootstrap_v1',[...context,id(330)]);
 const page=await rpc(db,'native_sales_bootstrap_page_v1',[...context,id(330),0]);
 const rows=JSON.parse(page.payload);assert.equal(manifest.totalCount,3);assert.deepEqual(rows.find(r=>r.id===id(21)).metadata.recipe[0].perUnit,{numerator:'2000',denominator:'1000'});assert.equal(rows.find(r=>r.id===customer).active,true);
 const c=command(101),sale=c.intent.payload.sale;
 Object.assign(sale.lines[0],{productId:id(21),name:'Combo QA',unitPriceCents:'12000',costCents:'8000',recipe:[{productId:product,perUnit:{numerator:'2',denominator:'1'},revision:'1'}]});
 sale.inventory[0].delta='-2';sale.totals={subtotalCents:'12000',itbisCents:'2160',discountCents:'0',totalCents:'14160'};sale.payment.cardCents=sale.payment.paidCents='14160';c.intent.payload.quoteHash=hash(sale);c.snapshot.sale=sale;
 const receipt=await submit(db,c);assert.equal(receipt.stock[0].after,'98');assert.deepEqual(await submit(db,c),receipt);
 }finally{await db.close();}
 const db2=await setup();try{
 await admin(db2,'update clientes set eliminado=true');await activate(db2);
 const page=await rpc(db2,'native_sales_bootstrap_v1',[...context,id(331)]);assert.equal(page.totalCount,2);
 const data=await rpc(db2,'native_sales_bootstrap_page_v1',[...context,id(331),0]);assert.equal(JSON.parse(data.payload).find(r=>r.id===customer).active,false);
 const c=command(102);c.intent.payload.sale.customer={id:customer,name:'Cliente sintético',revision:'1'};c.intent.payload.quoteHash=hash(c.intent.payload.sale);c.snapshot.customerName='Cliente sintético';c.snapshot.sale=c.intent.payload.sale;
 await assert.rejects(submit(db2,c));assert.equal((await admin(db2,'select count(*) as n from native_sales_ledger_v1'))[0].n,0);assert.equal((await admin(db2,'select stock_actual from inventario_sucursales'))[0].stock_actual,100);
 }finally{await db2.close();}
});

test('all five payment methods, credit/cash separation and late rollback',async()=>{
 for(const method of ['EFECTIVO','TARJETA','TRANSFERENCIA','MIXTO','FIADO']){const db=await setup();try{await activate(db);await openTurn(db);
 const p=command(100).intent.payload.sale.payment;Object.assign(p,{method,cardCents:'0',paidCents:method==='FIADO'?'0':'11800',turnId:id(90)});
 if(method==='EFECTIVO')Object.assign(p,{cashNetCents:'11800',tenderCents:'20000',changeCents:'8200',turnId:id(90)});
 if(method==='MIXTO')Object.assign(p,{cashNetCents:'1800',transferCents:'10000',tenderCents:'2000',changeCents:'200',turnId:id(90)});
 if(method==='TRANSFERENCIA')p.transferCents='11800';if(method==='TARJETA')p.cardCents='11800';if(method==='FIADO')Object.assign(p,{creditChargeCents:'11800',customerId:customer});
 const c=command(100,{payment:p});if(method==='FIADO')c.snapshot.customerName='Cliente sintético';const r=await submit(db,c);assert.equal(r.status,'APPLIED');assert.deepEqual(await submit(db,c),r);
 assert.equal(r.effects.filter(x=>x.kind==='CASH').length,['EFECTIVO','MIXTO'].includes(method)?1:0);assert.equal(r.effects.filter(x=>x.kind==='CREDIT').length,method==='FIADO'?1:0);
 assert.equal((await admin(db,'select balance_cents from native_sales_credit_v1'))[0].balance_cents,method==='FIADO'?11800:0);
 }finally{await db.close();}}
 const db=await setup();try{await activate(db);const c=command(100);c.intent.payload.sale.payment.cardCents='11799';c.snapshot.sale=c.intent.payload.sale;await assert.rejects(submit(db,c));assert.equal((await admin(db,'select stock_actual from inventario_sucursales'))[0].stock_actual,100);assert.equal((await admin(db,'select last_sequence from native_sales_counter_v1'))[0].last_sequence,0);}finally{await db.close();}
});

test('non-cash may retain a scoped turn, but an unknown turn never changes money or stock',async()=>{const db=await setup();try{
 await activate(db);await openTurn(db);
 const c=command(180);c.intent.payload.sale.payment.turnId=id(999);c.intent.originalTurnId=id(999);c.snapshot.sale=c.intent.payload.sale;c.intent.payload.quoteHash=hash(c.intent.payload.sale);
 await assert.rejects(submit(db,c));assert.equal((await admin(db,'select stock_actual from inventario_sucursales'))[0].stock_actual,100);assert.equal((await admin(db,'select count(*) as n from native_sales_ledger_v1'))[0].n,1);
 c.intent.payload.sale.payment.turnId=id(90);c.intent.originalTurnId=id(90);c.intent.payload.quoteHash=hash(c.intent.payload.sale);c.snapshot.sale=c.intent.payload.sale;
 const r=await submit(db,c);assert.equal(r.status,'APPLIED');assert.equal(r.effects.filter(e=>e.kind==='CASH').length,0);assert.deepEqual(await submit(db,c),r);
 }finally{await db.close();}});

test('serial plus allocated NCF apply together once; stale fiscal or serial proof rolls back everything',async()=>{const db=await setup();try{
 await admin(db,`update productos set serializable=true; insert into seriales values('${id(50)}','${tenant}','${product}','000000000000001','disponible',null,null,null)`);await activate(db);
 const req={version:'2',requestId:id(51),tenantId:tenant,actorId:actor,deviceId:device,installationId:installation,writerEpoch:'1',scopeType:'BRANCH',branchId:branch,kind:'B02',quantity:'20'};
 await assert.rejects(rpc(db,'native_fiscal_allocate_v2',[req,hash(req)]),/FENCED/);
 const allocation=await rpc(db,'native_sales_fiscal_allocate_v1',[req,hash(req)]);assert.equal(allocation.status,'ALLOCATED');assert.deepEqual(await rpc(db,'native_sales_fiscal_allocate_v1',[req,hash(req)]),allocation);
 const c=command(100);c.intent.payload.sale.lines[0].serial='000000000000001';c.intent.payload.sale.serials=[{productId:product,text:'000000000000001',expectedRevision:'1'}];c.intent.payload.sale.fiscal={reservationId:id(100),blockId:id(51),type:'B02',number:'1',ncf:'B0200000001'};c.snapshot.ncf='B0200000001';c.snapshot.sale=c.intent.payload.sale;c.intent.payload.quoteHash=hash({...c.intent.payload.sale,fiscal:null});
 const bad=structuredClone(c);bad.intent.payload.sale.fiscal.blockId=id(52);bad.snapshot.sale=bad.intent.payload.sale;await assert.rejects(submit(db,bad));assert.equal((await admin(db,'select stock_actual from inventario_sucursales'))[0].stock_actual,100);assert.equal((await admin(db,'select estado from seriales'))[0].estado,'disponible');
 const receipt=await submit(db,c);assert.equal(receipt.ncf,'B0200000001');assert.equal(receipt.effects.filter(x=>x.kind==='SERIAL').length,1);assert.deepEqual(await submit(db,c),receipt);assert.equal((await admin(db,'select estado from seriales'))[0].estado,'vendido');
 }finally{await db.close();}});

test('percentage and verified customer tiers cannot become arbitrary prices',async()=>{const db=await setup();try{
 await admin(db,'update clientes set tipo_precio=2');await activate(db);const c=command(100);const sale=c.intent.payload.sale;sale.customer={id:customer,name:'Cliente sintético',revision:'1'};sale.lines[0].unitPriceCents='9000';sale.lines[0].pricePolicy={source:'CUSTOMER',customerId:customer,tier:'2'};sale.discount={type:'PERCENT',ratio:{numerator:'10',denominator:'1'}};sale.totals={subtotalCents:'9000',itbisCents:'1620',discountCents:'1062',totalCents:'9558'};sale.payment.cardCents=sale.payment.paidCents='9558';c.snapshot.customerName='Cliente sintético';c.snapshot.sale=sale;c.intent.payload.quoteHash=hash(sale);const bad=structuredClone(c);bad.intent.payload.sale.lines[0].pricePolicy.tier='3';bad.snapshot.sale=bad.intent.payload.sale;bad.intent.payload.quoteHash=hash(bad.intent.payload.sale);await assert.rejects(submit(db,bad));assert.equal((await submit(db,c)).totalCents,'9558');
 }finally{await db.close();}});

test('GLOBAL authority, divergence without repair and old/new product fence',async()=>{const db=await setup();try{
 await admin(db,`update inventario_sucursales set stock_actual=99`);await activate(db);const divergent=command(100);Object.assign(divergent.intent.payload.sale.stockEvidence[0],{remoteBaseQty:'99',effectiveQty:'99'});divergent.intent.payload.sale.inventory[0].expectedRevision=hash({quantity:'99',remoteSequence:'0',pending:[]});divergent.intent.payload.quoteHash=hash(divergent.intent.payload.sale);divergent.snapshot.sale=divergent.intent.payload.sale;await assert.rejects(submit(db,divergent),/AUTHORITY_PROJECTION_DIVERGED/);assert.equal((await admin(db,'select stock_actual from productos'))[0].stock_actual,100);
 await admin(db,`insert into productos(id,negocio_id,nombre,stock_actual) values('${id(21)}','${other}','Ajeno',0)`);await assert.rejects(db.exec(`update inventario_sucursales set producto_id='${id(21)}'`),/FENCED/);
 }finally{await db.close();}
 const g=await setup();try{await admin(g,'delete from native_registration_requests_v1; delete from native_actor_sequences_v1; delete from native_installations_v1');await rpc(g,'native_registrar_instalacion_v1',[grant,tenant,installation,device,'GLOBAL',null]);await rpc(g,'native_sales_activate_v1',[tenant,installation,device,'1','GLOBAL',null,'QA_SYNTHETIC_QUIESCED','0.18']);const c=command(100);c.intent.scope={type:'GLOBAL',sucursalId:null};c.snapshot.scope={type:'GLOBAL',branchId:null};assert.equal((await submit(g,c)).stock[0].after,'99');assert.equal((await admin(g,'select stock_actual from inventario_sucursales'))[0].stock_actual,100);}finally{await g.close();}
});

test('frozen paginated operational bootstrap has native watermark and full sale facts',async()=>{const db=await setup();try{
 await activate(db);const m=await rpc(db,'native_sales_bootstrap_v1',[...context,id(300)]);assert.equal(m.version,'ventard.native.operational.1');assert.equal(m.watermark,'0');assert.equal(m.namespace,'NATIVE1');assert.deepEqual(await rpc(db,'native_sales_bootstrap_v1',[...context,id(300)]),m);
 await submit(db,command(100));const page=await rpc(db,'native_sales_bootstrap_page_v1',[...context,id(300),0]);assert.equal(hash(page.payload),m.pages[0].sha256);const rows=JSON.parse(page.payload);assert.equal(rows.find(x=>x.kind==='PRODUCT').stock.quantity,'100');assert.equal(rows.find(x=>x.kind==='CUSTOMER').balanceCents,'0');
 assert.equal((await rpc(db,'native_sales_bootstrap_v1',[...context,id(301)])).watermark,'1');
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(8)]);await assert.rejects(rpc(db,'native_sales_bootstrap_page_v1',[...context,id(300),0]));
 }finally{await db.close();}});

test('missing/null facts, extra serials, forged recipient and duplicate evidence never apply',async()=>{const db=await setup();try{
 await activate(db);
 const invalid=[];
 for(const path of ['intent.protocol','intent.actorId','intent.originAtUtcMs','snapshot.ticket','snapshot.version','snapshot.sale.payment.method','snapshot.sale.payment.paidCents','snapshot.sale.lines.0.quantity.denominator','snapshot.sale.lines.0.taxRate.denominator','snapshot.sale.totals.totalCents','snapshot.sale.inventory','snapshot.sale.stockEvidence'])for(const nullable of [false,true]){
  const c=command(100);const parts=path.split('.');let o=c;for(const p of parts.slice(0,-1))o=o[p];if(nullable)o[parts.at(-1)]=null;else delete o[parts.at(-1)];if(path.startsWith('snapshot.sale.'))c.intent.payload.sale=structuredClone(c.snapshot.sale);invalid.push(c);
 }
 const duplicate=command(100);duplicate.intent.payload.sale.stockEvidence.push(structuredClone(duplicate.intent.payload.sale.stockEvidence[0]));duplicate.snapshot.sale=duplicate.intent.payload.sale;invalid.push(duplicate);
 invalid.push(command(100,{serials:[{productId:product,text:'unrelated',expectedRevision:'1'}]}));
 const fake=command(100,{customer:{id:customer,name:'Nombre falso',revision:'1'}});fake.snapshot.customerName='Nombre falso';invalid.push(fake);
 for(const c of invalid)await assert.rejects(submit(db,c),undefined,canon(c));
 assert.equal((await admin(db,'select stock_actual from inventario_sucursales'))[0].stock_actual,100);
 assert.equal((await admin(db,'select count(*) n from native_sales_ledger_v1'))[0].n,0);
 }finally{await db.close();}});

test('whole sale: exact receipt, one stock/money effect, replay/lost response, durable feed and lookup',async()=>{const db=await setup();try{
 await activate(db);const c=command(100),r=await submit(db,c);assert.equal(r.status,'APPLIED');assert.equal(r.intentHash,hash(c.intent));assert.equal(r.snapshotHash,hash(c.snapshot));assert.equal(r.stock[0].after,'99');assert.deepEqual(await submit(db,c),r);
 assert.deepEqual(await rpc(db,'native_sales_lookup_v1',[...context,id(100),hash(c.intent)]),r);
 assert.equal((await admin(db,'select stock_actual from inventario_sucursales'))[0].stock_actual,99);
 assert.equal((await admin(db,'select count(*) n from native_sales_ledger_v1'))[0].n,1);
 const feed=await rpc(db,'native_sales_feed_v1',[...context,'0']);assert.equal(feed.events.length,1);assert.equal(feed.scannedThrough,r.remoteSequence);assert.equal(feed.events[0].receipt.intentHash,hash(c.intent));
 }finally{await db.close();}});

test('no activation, forged/partial/hash-changed sale, stale stock and invalid tenant cause zero effects',async()=>{const db=await setup();try{
 await assert.rejects(submit(db,command(100)));await activate(db);
 for(const c of [command(100,{totals:{subtotalCents:'10000',itbisCents:'0',discountCents:'0',totalCents:'10000'}}),command(100,{inventory:[]}),command(100,{stockEvidence:[]})])await assert.rejects(submit(db,c));
 const c=command(100);await assert.rejects(rpc(db,'native_sales_submit_v1',[canon(c.intent),'0'.repeat(64),canon(c.snapshot),hash(c.snapshot)]));
 assert.equal((await admin(db,'select stock_actual from inventario_sucursales'))[0].stock_actual,100);assert.equal((await admin(db,'select count(*) n from native_sales_ledger_v1'))[0].n,0);
 const r=await submit(db,c);await assert.rejects(submit(db,command(101)));await assert.rejects(submit(db,command(100,{discount:{type:'AMOUNT',amountCents:'1'}})));assert.deepEqual(await rpc(db,'native_sales_lookup_v1',[...context,id(100),hash(c.intent)]),r);
 }finally{await db.close();}});

test('cutover fence, tenant isolation, read-only lookup/feed and disabled direct ledger grants',async()=>{const db=await setup();try{
 await activate(db);await assert.rejects(db.exec('update productos set stock_actual=0'));await assert.rejects(db.exec('delete from inventario_sucursales'));await assert.rejects(db.exec('delete from native_sales_ledger_v1'));
 await submit(db,command(100));await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(8)]);await assert.rejects(rpc(db,'native_sales_feed_v1',context.concat('0')));await assert.rejects(submit(db,command(101)));
 assert.equal((await admin(db,'select stock_actual from inventario_sucursales'))[0].stock_actual,99);
 }finally{await db.close();}});

test('real Rust checkout bytes are accepted unchanged by PostgreSQL and emit matching receipt',async()=>{
 const wire=JSON.parse(await readFile(new URL('../../scratch/native-sale-wire.json',import.meta.url),'utf8'));const v=JSON.parse(wire.intent),s=JSON.parse(wire.snapshot),p=v.payload.sale.lines[0],x=wire.context;const db=await setup();try{
 await db.exec('reset role');await db.query('insert into auth.users values($1)',[x.actorId]);await db.query(`update negocios set "dueño_id"=$2 where id=$1`,[x.tenantId,x.actorId]);await db.query(`insert into sucursales values($1,$2,'QA Rust')`,[x.branchId,x.tenantId]);
 await db.query(`insert into native_staging_licenses_v1(negocio_id,plan_active) values($1,true) on conflict do nothing`,[x.tenantId]);await db.query(`insert into productos(id,negocio_id,nombre,precio_venta,costo,stock_actual,tasa_itbis,tipo,serializable,eliminado) values($1,$2,$3,100,null,5,.18,'simple',false,false)`,[p.productId,x.tenantId,p.name]);await db.query('insert into inventario_sucursales values($1,$2,5)',[x.branchId,p.productId]);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[x.actorId]);await db.exec('set role authenticated');await rpc(db,'native_registrar_instalacion_v1',[v.permissionGrantId,x.tenantId,x.installationId,x.deviceId,'BRANCH',x.branchId]);await rpc(db,'native_sales_activate_v1',[x.tenantId,x.installationId,x.deviceId,'1','BRANCH',x.branchId,'QA_SYNTHETIC_QUIESCED','0.18']);
 const receipt=await rpc(db,'native_sales_submit_v1',[wire.intent,hash(wire.intent),wire.snapshot,hash(wire.snapshot)]);assert.equal(receipt.status,'APPLIED');assert.equal(receipt.stock[0].after,'4');assert.equal(receipt.snapshotHash,hash(wire.snapshot));assert.deepEqual(await rpc(db,'native_sales_submit_v1',[wire.intent,hash(wire.intent),wire.snapshot,hash(wire.snapshot)]),receipt);
 await writeFile(new URL('../../scratch/native-sale-roundtrip.json',import.meta.url),JSON.stringify({...wire,receipt}));assert.deepEqual(s.sale,v.payload.sale);
 }finally{await db.close();}
});
