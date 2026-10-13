// PostgreSQL isolated engine. Never connects to a remote project.
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';
import {inventorySetup,managementCommand,submitManagement,context,rpc,canon,id,tenant,actor,installation,device,branch,command,hash} from './sales-server.test.mjs';
const migration='20261012230033_native_business_settings_staging_v1.sql';
async function setup(){const db=await inventorySetup();await db.exec('reset role');for(const file of ['20261012123311_native_returns_staging_v1.sql','20261012150846_native_service_plan_staging_v1.sql','20261012153049_native_repairs_staging_v1.sql','20261012201138_native_layaways_staging_v1.sql','20261012203519_native_warranty_staging_v1.sql','20261012222616_native_layaway_serial_state_compat_v1.sql',migration]){const sql=await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8');await db.exec(sql);await db.exec(sql)}await db.exec('set role authenticated');return db}
async function adminExec(db,sql){await db.exec('reset role');try{await db.exec(sql)}finally{await db.exec('set role authenticated')}}
async function admin(db,sql,args=[]){await db.exec('reset role');try{return(await db.query(sql,args)).rows}finally{await db.exec('set role authenticated')}}
function definition(name='Tienda QA'){return{name,whatsapp:'8095550100',phone:'8095550101',rnc:'131000001',address:'Calle QA',footer:'Gracias por su compra',logo:null,color:'dorado',font:'syne',bank:{name:'Banco QA',account:'001-123',holder:'Tienda QA'}}}
function event(op,rev='0',name){const d=definition(name),revision=String(BigInt(rev)+1n),profile={name:d.name,rnc:d.rnc,address:d.address,phone:d.phone,footer:d.footer,whatsapp:d.whatsapp,logo:d.logo,color:d.color,font:d.font,bank:d.bank,settingsRevision:revision,settingsOperationId:id(op)};return managementCommand(op,'CONFIG_PATCH',{kind:'BUSINESS_SAVE',expectedRevision:rev,definition:d},{operationId:id(op),businessSettings:{revision,definition:d},business:profile,amountCents:'0',method:null,concept:'Configuración del negocio'})}
test('settings: basic owner, atomic rollback, exact replay, stale revision and immutable header captures',async()=>{const db=await setup();try{
 const before=await rpc(db,'native_sales_bootstrap_v1',[...context,id(1100)]);const v=event(1101),bad=structuredClone(v);bad.payload.document.business.name='forged';await assert.rejects(submitManagement(db,bad),/DOCUMENT_INVALID/);
 await adminExec(db,"create function fixture_fail_settings() returns trigger language plpgsql as $$begin if NEW.kind='CONFIG_PATCH' then raise exception 'fixture settings rollback';end if;return NEW;end;$$;create trigger fixture_fail_settings before insert on native_management_records_v1 for each row execute function fixture_fail_settings();");
 await assert.rejects(submitManagement(db,v),/fixture settings rollback/);assert.equal((await admin(db,'select count(*) n from native_business_settings_v1'))[0].n,0);
 await adminExec(db,'drop trigger fixture_fail_settings on native_management_records_v1;drop function fixture_fail_settings();');
 const receipt=await submitManagement(db,v);assert.deepEqual(await submitManagement(db,v),receipt);assert.deepEqual(receipt.stock,[]);assert.equal(receipt.effects.length,1);assert.equal(receipt.effects[0].kind,'CONFIG_PATCH');assert.equal((await admin(db,'select stock_actual from inventario_sucursales'))[0].stock_actual,100);
 assert.equal((await admin(db,'select nombre from negocios where id=$1',[tenant]))[0].nombre,'PRO00 QA A - SINTETICO');
 await assert.rejects(submitManagement(db,event(1102)),/SETTINGS_VERSION/);assert.deepEqual(await rpc(db,'native_sales_bootstrap_v1',[...context,id(1100)]),before);
 const after=await rpc(db,'native_sales_bootstrap_v1',[...context,id(1103)]);assert.equal(after.business.name,'Tienda QA');assert.equal(after.businessSettings.receipt.operationId,id(1101));
 const v2=event(1104,'1','Nombre nuevo');await submitManagement(db,v2);assert.deepEqual(await rpc(db,'native_sales_bootstrap_v1',[...context,id(1103)]),after);
 const c=command(1105);c.snapshot.business=after.business;await rpc(db,'native_sales_submit_v1',[canon(c.intent),hash(c.intent),canon(c.snapshot),hash(c.snapshot)]);
 const forged=command(1106);forged.snapshot.business={...after.business,name:'Fake business'};await assert.rejects(rpc(db,'native_sales_submit_v1',[canon(forged.intent),hash(forged.intent),canon(forged.snapshot),hash(forged.snapshot)]),/HEADER_INVALID/);
 }finally{await db.close()}});
test('settings: seller and raw helper denied; malformed/remote logos rejected',async()=>{const db=await setup();try{
 for(const key of ['color','font']){const v=event(1110);v.payload.request.definition[key]=null;await assert.rejects(submitManagement(db,v),/SETTINGS_INVALID/)}
 for(const logo of ['https://example.test/logo.png','data:image/svg+xml;base64,PHN2Zy8+','data:image/png;base64,AAAA']){const v=event(1110);v.payload.request.definition.logo=logo;await assert.rejects(submitManagement(db,v),/LOGO_INVALID/)}
 await assert.rejects(rpc(db,'native_settings_profile_v1',[definition(),1,id(1110)]),/permission denied/);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(7)]);await rpc(db,'native_registrar_instalacion_v1',[id(1111),tenant,installation,device,'BRANCH',branch]);const v=event(1112);v.actorId=id(7);v.permissionGrantId=id(1111);await assert.rejects(submitManagement(db,v),/SETTINGS_DENIED/);assert.equal((await admin(db,'select count(*) n from native_business_settings_v1'))[0].n,0);
 }finally{await db.close()}});
test('settings: current metadata reaches independent installation without replaying money',async()=>{const db=await setup();try{
 const v=event(1120),receipt=await submitManagement(db,v),i=id(1122),d=id(1123);
 await rpc(db,'native_registrar_instalacion_v1',[id(1124),tenant,i,d,'BRANCH',branch]);const other=[tenant,i,d,'1','BRANCH',branch];
 const snapshot=await rpc(db,'native_sales_bootstrap_v1',[...other,id(1125)]);
 assert.equal(snapshot.businessSettingsProtocol,'ventard.business.settings.1');assert.equal(snapshot.businessSettings.receipt.operationId,id(1120));
 const feed=await rpc(db,'native_sales_feed_v1',[...other,receipt.remoteSequence]);assert.equal(feed.events.length,0);assert.equal(feed.businessSettings.receipt.operationId,id(1120));
 assert.equal(feed.business.name,'Tienda QA');assert.equal(feed.businessSettings.receipt.intentHash,hash(v));
 if(process.env.VENTARD_SETTINGS_EVENT_FIXTURE)await writeFile(process.env.VENTARD_SETTINGS_EVENT_FIXTURE,JSON.stringify({event:feed.businessSettings,watermark:feed.scannedThrough,receipt}));
 }finally{await db.close()}});
