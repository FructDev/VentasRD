// Isolated PostgreSQL. No network, credentials, real accounts or publications.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inventorySetup,managementCommand,submitManagement,context,rpc,id,tenant,actor,product} from './sales-server.test.mjs';
const files=['20261012123311_native_returns_staging_v1.sql','20261012150846_native_service_plan_staging_v1.sql','20261012153049_native_repairs_staging_v1.sql','20261012201138_native_layaways_staging_v1.sql','20261012203519_native_warranty_staging_v1.sql','20261012222616_native_layaway_serial_state_compat_v1.sql','20261012230033_native_business_settings_staging_v1.sql','20261014140730_native_product_photos_staging_v1.sql','20261015011959_native_public_catalogue_staging_v1.sql'];
async function setup(){const db=await inventorySetup();await db.exec('reset role');await db.exec('create role service_role; alter table negocios add catalogo_publico boolean default false,add whatsapp_dueno text,add telefono text,add direccion text,add logo_url text,add color_marca text;');for(const f of files){const sql=await readFile(new URL('../../supabase/migrations/'+f,import.meta.url),'utf8');await db.exec(sql);await db.exec(sql)}await db.exec('set role authenticated');return db}
async function admin(db,sql,args=[]){await db.exec('reset role');try{await db.exec('begin');await db.query('insert into native_sales_write_context_v1 values(txid_current(),$1)',[tenant]);const rows=(await db.query(sql,args)).rows;await db.exec('commit');return rows}catch(e){await db.exec('rollback');throw e}finally{await db.exec('set role authenticated')}}
function publish(op,rev='0',before=false,enabled=true){return managementCommand(op,'CONFIG_PATCH',{kind:'CATALOGUE_PUBLISH',expectedRevision:rev,expectedEnabled:before,enabled},{cataloguePublication:{enabled,revision:String(BigInt(rev)+1n),publicPath:'/catalogo/'+tenant},amountCents:'0',method:null,concept:enabled?'Catálogo público activado':'Catálogo público desactivado'})}
test('catalogue: atomic publication, exact replay, legacy CAS, scoped roles and private helpers',async()=>{const db=await setup();try{
 const initial=await rpc(db,'native_catalogue_settings_v1',context);assert.equal(initial.enabled,false);assert.equal(initial.revision,'0');
 const v=publish(2100),bad=structuredClone(v);bad.payload.document.cataloguePublication.enabled=false;await assert.rejects(submitManagement(db,bad),/DOCUMENT_INVALID/);
 await admin(db,"create function fixture_catalogue_fail() returns trigger language plpgsql as $$begin raise exception 'fixture publication rollback';end;$$");await admin(db,'create trigger fixture_catalogue_fail before insert on native_catalogue_publications_v1 for each row execute function fixture_catalogue_fail()');
 await assert.rejects(submitManagement(db,v),/fixture publication rollback/);assert.equal((await rpc(db,'native_catalogue_settings_v1',context)).enabled,false);assert.equal((await admin(db,'select count(*) n from native_sales_ledger_v1'))[0].n,0);
 await admin(db,'drop trigger fixture_catalogue_fail on native_catalogue_publications_v1');
 const receipt=await submitManagement(db,v);assert.deepEqual(await submitManagement(db,v),receipt);assert.equal(receipt.status,'APPLIED');assert.deepEqual(receipt.stock,[]);assert.equal(receipt.totalCents,null);
 assert.equal((await rpc(db,'native_catalogue_settings_v1',context)).enabled,true);await assert.rejects(submitManagement(db,publish(2101)),/CATALOGUE_VERSION/);
 await admin(db,'update negocios set catalogo_publico=false where id=$1',[tenant]);await assert.rejects(submitManagement(db,publish(2102,'1',true,false)),/CATALOGUE_VERSION/);
 await submitManagement(db,publish(2103,'1',false,true));await submitManagement(db,publish(2104,'2',true,false));assert.equal((await rpc(db,'native_catalogue_settings_v1',context)).revision,'3');
 assert.equal((await admin(db,'select stock_actual from inventario_sucursales'))[0].stock_actual,100);
 await assert.rejects(db.query('select * from native_catalogue_publications_v1'),/permission denied/);await assert.rejects(rpc(db,'native_catalogue_submit_v1',['{}','x',null,null]),/permission denied/);await assert.rejects(rpc(db,'native_public_catalogue_page_v1',[tenant,null]),/permission denied/);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id(7)]);await assert.rejects(rpc(db,'native_catalogue_settings_v1',context),/CONTEXT|DENIED/);
 }finally{await db.close()}});
test('catalogue: published projection excludes private data, paginates and respects photo removal and disable',async()=>{const db=await setup();try{
 await assert.rejects(admin(db,'select native_public_catalogue_page_v1($1,null)',[tenant]),/CATALOGUE_UNAVAILABLE/);
 await submitManagement(db,publish(2110));await admin(db,"update productos set imagen_url='https://example.test/old.jpg' where id=$1",[product]);
 const d={name:'Marca nativa',whatsapp:'8095550100',phone:'',rnc:'',address:'Calle QA',footer:'',logo:null,color:'cielo',font:'syne',bank:{name:'Banco privado',account:'PRIVATE-ACCOUNT',holder:'Titular'}};
 const business={name:d.name,rnc:null,address:d.address,phone:null,footer:null,whatsapp:d.whatsapp,logo:null,color:d.color,font:d.font,bank:d.bank,settingsRevision:'1',settingsOperationId:id(2115)};
 await submitManagement(db,managementCommand(2115,'CONFIG_PATCH',{kind:'BUSINESS_SAVE',expectedRevision:'0',definition:d},{operationId:id(2115),businessSettings:{revision:'1',definition:d},business,amountCents:'0',method:null,concept:'Configuración del negocio'}));
 let page=(await admin(db,'select native_public_catalogue_page_v1($1,null) page',[tenant]))[0].page;assert.equal(page.productos.length,1);assert.equal(page.negocio.nombre,'Marca nativa');assert.equal(page.negocio.color_marca,'cielo');assert.ok(!JSON.stringify(page).includes('PRIVATE-ACCOUNT'));assert.deepEqual(Object.keys(page.productos[0]).sort(),['id','imagen_url','nombre','precio_venta']);assert.equal(page.productos[0].imagen_url,'https://example.test/old.jpg');
 await admin(db,"insert into native_product_metadata_v1(producto_id,negocio_id,revision,location,minimum,photo) values($1,$2,1,'',0,'{\"data\":null}') on conflict(negocio_id,producto_id) do update set photo=excluded.photo",[product,tenant]);
 page=(await admin(db,'select native_public_catalogue_page_v1($1,null) page',[tenant]))[0].page;assert.equal(page.productos[0].imagen_url,null);
 await admin(db,"insert into productos(id,negocio_id,nombre,precio_venta,eliminado) select ('96200000-0000-4000-8000-'||lpad(x::text,12,'0'))::uuid,$1,'Producto '||x,1,false from generate_series(3000,3200) x",[tenant]);
 page=(await admin(db,'select native_public_catalogue_page_v1($1,null) page',[tenant]))[0].page;assert.equal(page.productos.length,200);assert.ok(page.nextId);
 const next=(await admin(db,'select native_public_catalogue_page_v1($1,$2) page',[tenant,page.nextId]))[0].page;assert.equal(next.productos.length,2);assert.equal(next.nextId,null);assert.equal(new Set([...page.productos,...next.productos].map(p=>p.id)).size,202);
 await submitManagement(db,publish(2111,'1',true,false));await assert.rejects(admin(db,'select native_public_catalogue_page_v1($1,$2)',[tenant,page.nextId]),/CATALOGUE_UNAVAILABLE/);
 }finally{await db.close()}});
