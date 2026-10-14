import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {inventorySetup,productCommand,submitManagement,context,rpc,id} from './sales-server.test.mjs';
const migration=await readFile(new URL('../../supabase/migrations/20261014140730_native_product_photos_staging_v1.sql',import.meta.url),'utf8');
const photo={data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='};
test('inventory photos: bounded photo, preservation, removal, bootstrap and canonical replay',async()=>{const db=await inventorySetup();try{
 await db.exec('reset role');await db.exec(migration);await db.exec(migration);await db.exec('set role authenticated');
 const create=productCommand(1200);create.payload.request.definition.photo=photo;create.payload.document.product.metadata.photo=photo;const applied=await submitManagement(db,create);assert.deepEqual(await submitManagement(db,create),applied);
 const patch=productCommand(1201,'1');patch.payload.document.product.metadata.photo=photo;await submitManagement(db,patch);
 const snapshot=await rpc(db,'native_sales_bootstrap_v1',[...context,id(1290)]),page=await rpc(db,'native_sales_bootstrap_page_v1',[...context,snapshot.snapshotId,'0']);assert.deepEqual(JSON.parse(page.payload).find(p=>p.id===id(300)).metadata.photo,photo);
 const bad=productCommand(1202,'2');bad.payload.request.definition.photo={data:'data:image/svg+xml,<svg onload="bad"/>'};bad.payload.document.product.metadata.photo=bad.payload.request.definition.photo;await assert.rejects(submitManagement(db,bad),/PHOTO_INVALID/);
 const remove=productCommand(1203,'2');remove.payload.request.definition.photo={data:null};remove.payload.document.product.metadata.photo={data:null};await submitManagement(db,remove);
 await db.exec('reset role');assert.equal((await db.query('select imagen_url from productos where id=$1',[id(300)])).rows[0].imagen_url,null);await db.exec('set role authenticated');
 await assert.rejects(rpc(db,'native_product_photo_metadata_v1',[context[0],id(300)]),/permission denied/);
}finally{await db.close();}});
