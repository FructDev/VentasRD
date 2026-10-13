// Real Next Settings and browser IndexedDB/WebCrypto. Synthetic offline cache
// in a fresh Chromium profile; all remote requests are blocked before navigation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const url=process.env.VENTARD_WEB_FIXTURE_URL??'http://127.0.0.1:3116';
assert.match(url,/^http:\/\/127\.0\.0\.1:\d+$/);
test('Web original: copia y llave descargadas conservan venta pendiente sin PIN ni sesión',{timeout:120000},async()=>{
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({acceptDownloads:true,viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>route.request().url().startsWith(url+'/')?route.continue():route.abort());
 await page.addInitScript(()=>{
  Object.defineProperty(navigator,'onLine',{get:()=>false});
  const tenant='96000000-0000-4000-8000-000000000001';
  localStorage.setItem('ventard-config',JSON.stringify({version:0,state:{negocioId:tenant,usuarioCacheId:'96000000-0000-4000-8000-000000000003',sucursalId:'96000000-0000-4000-8000-000000000005',nombreUsuario:'QA OFFLINE · FIXTURE',rolUsuario:'admin',negocioNombre:'NEGOCIO SINTÉTICO QA',pinAdmin:'9876',planActivo:true,accesoHasta:Date.now()+86400000,ultimaFechaVista:Date.now(),ultimaConexionServidor:Date.now(),aperturasSinServidor:0,ultimoTicket:7,ncf:{negocioId:tenant,tipo:'B02',habilitado:false,desde:1,hasta:0,actual:8,bloques:[],proximoGlobal:8,sembrado:false}}}));
  localStorage.setItem('ventard-cart',JSON.stringify({version:0,state:{scope:{negocioId:tenant,sucursalId:null},items:[],enEspera:[]}}));
 });
 await page.goto(url+'/configuracion',{waitUntil:'domcontentloaded',timeout:90000});
 await page.getByText('Modo offline — ingresa tu PIN',{exact:true}).waitFor({timeout:90000});
 for(const digit of ['9','8','7','6'])await page.getByRole('button',{name:digit,exact:true}).click();
 await page.getByRole('button',{name:'Preparar traslado cifrado',exact:true}).waitFor();
 await page.getByRole('button',{name:'¡Entendido, a probar! →',exact:true}).click();
 await page.evaluate(async()=>{const db=await new Promise((ok,no)=>{const q=indexedDB.open('VentaRD_Vault');q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error)});await new Promise((ok,no)=>{const tx=db.transaction(['ventas','venta_detalles'],'readwrite');tx.objectStore('ventas').put({id:'sale-browser-qa',negocio_id:'96000000-0000-4000-8000-000000000001',numero_ticket:7,total:12.34,metodo_pago:'fiado',ncf:'B0200000007',estado_sincronizacion:0,fecha_creacion:1791849500000});tx.objectStore('venta_detalles').put({id:'line-browser-qa',negocio_id:'96000000-0000-4000-8000-000000000001',venta_id:'sale-browser-qa',producto_id:'legacy-product',cantidad:1,precio_unitario:12.34,subtotal:12.34,estado_sincronizacion:0,fecha_creacion:1791849500000});tx.oncomplete=ok;tx.onerror=()=>no(tx.error)});db.close();});
 await page.getByLabel('Nombre para reconocer este navegador').fill('Chrome QA · FIXTURE');
 await page.getByRole('button',{name:'Preparar traslado cifrado',exact:true}).click();await page.getByText('Copia preparada:',{exact:false}).waitFor();
 const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Descargar archivo cifrado',exact:true}).click();const file=await downloading;
 const downloadingKey=page.waitForEvent('download');await page.getByRole('button',{name:'Descargar llave del traslado',exact:true}).click();const keyFile=await downloadingKey;
 const encrypted=await readFile(await file.path()),key=await readFile(await keyFile.path());assert.equal(encrypted.subarray(0,8).toString(),'VRWEB001');assert.equal(key.subarray(0,8).toString(),'VRWKY001');
 const imported=await webcrypto.subtle.importKey('raw',key.subarray(8),'AES-GCM',false,['decrypt']);const plain=await webcrypto.subtle.decrypt({name:'AES-GCM',iv:encrypted.subarray(8,20),additionalData:encrypted.subarray(0,8)},imported,encrypted.subarray(20));
 const data=JSON.parse(Buffer.from(plain).toString());assert.equal(data.tables.length,18);const sales=JSON.parse(data.tables.find(t=>t.name==='ventas').rowsJson);assert.equal(sales[0].total,12.34);assert.equal(sales[0].id,'sale-browser-qa');assert.equal(sales[0].estado_sincronizacion,0);assert.equal(data.writersStopped,false);assert.doesNotMatch(data.storageJson,/pinAdmin|9876|firmaAcc|access_token/);
 assert.equal(await page.evaluate(async()=>{const db=await new Promise(ok=>{const q=indexedDB.open('VentaRD_Vault');q.onsuccess=()=>ok(q.result)});const value=await new Promise(ok=>{const q=db.transaction('ventas').objectStore('ventas').get('sale-browser-qa');q.onsuccess=()=>ok(q.result)});db.close();return value.estado_sincronizacion;}),0);
 await page.getByRole('heading',{name:'Traslado a VentaRD instalada',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:fileURLToPath(new URL('../../docs/native/evidence/web-migration-export-original.png',import.meta.url))});
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
