// Definitive Next pages, isolated Chromium storage and synthetic local fixture.
// Every non-loopback request is blocked. This does not verify real Auth/hosting.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
test('original settings and inventory preserve an offline shared operation after reopening',{skip:!process.env.VENTARD_SHARED_UI_URL,timeout:300000},async()=>{
 const origin=new URL(process.env.VENTARD_SHARED_UI_URL);assert.equal(origin.hostname,'127.0.0.1');
 const fixture=JSON.parse(await readFile(new URL('../../scratch/shared-web-ui-fixture.json',import.meta.url),'utf8'));
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1365,height:950}});
 try{
  await context.route(url=>url.origin!==origin.origin,route=>route.abort());
  await context.setExtraHTTPHeaders({'Accept-Encoding':'identity'});
  await context.addInitScript(f=>{
   const c=f.context;
   Object.defineProperty(navigator,'onLine',{get:()=>false});
   if(!localStorage.getItem('ventard-config')){
   const seed=indexedDB.open('VentaRD_Vault',240);seed.onupgradeneeded=()=>{for(const table of f.schema){const store=seed.result.createObjectStore(table.name,{keyPath:table.keyPath});for(const index of table.indexes)store.createIndex(index.name,index.keyPath,{unique:index.unique,multiEntry:index.multiEntry});for(const row of f.tables[table.name])store.put(row)}};seed.onsuccess=()=>seed.result.close();
   localStorage.setItem('ventard-config',JSON.stringify({state:{negocioId:c.tenantId,usuarioCacheId:c.actorId,sucursalId:c.branchId,negocioNombre:'COPIA SINTETICA ANTERIOR',nombreUsuario:'QA SINTETICO · prueba local',rolUsuario:'admin',pinAdmin:'03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4',planActivo:true,planTier:'pro',accesoHasta:Date.now()+864000000,ultimaConexionServidor:Date.now(),ultimaFechaVista:Date.now(),aperturasSinServidor:0,isOfflineUnlocked:true,isAdminMode:true,tema:'oscuro',colorMarca:'dorado'},version:0}));}
  },fixture);
  const page=await context.newPage();page.setDefaultNavigationTimeout(120000);const errors=[];page.on('pageerror',error=>errors.push(error.stack||error.message));
  await page.goto(origin.origin+'/configuracion',{waitUntil:'domcontentloaded'});
  await page.getByText('Web y aplicación · mismo negocio',{exact:true}).waitFor({timeout:15000});
  await page.getByText(/Al día · 0 por revisar/).waitFor();
  const news=page.getByRole('button',{name:/Entendido, a probar/});if(await news.isVisible())await news.click();
  assert.ok((await page.locator('body').innerText()).includes('PRO00 QA A - SINTETICO'));
  await mkdir(new URL('../../scratch/shared-ui/',import.meta.url),{recursive:true});
  await page.screenshot({path:new URL('../../scratch/shared-ui/settings-original.png',import.meta.url).pathname.replace(/^\/(.:\/)/,'$1'),fullPage:true});
  await page.getByRole('link',{name:/Inventario/}).first().click();
  await page.getByRole('button',{name:'Ajuste',exact:true}).first().click({timeout:45000});
  const form=page.locator('form').filter({hasText:'Tipo de Ajuste'});await form.locator('input[type=number]').fill('2');await form.getByRole('button',{name:'Aplicar',exact:true}).click();
  const read=()=>page.evaluate(async()=>{const db=await new Promise(ok=>{const r=indexedDB.open('VentaRD_Vault');r.onsuccess=()=>ok(r.result)});const result=await new Promise(ok=>{const tx=db.transaction(['shared_mutations','productos']);let mutations,products;const a=tx.objectStore('shared_mutations').getAll(),b=tx.objectStore('productos').getAll();a.onsuccess=()=>{mutations=a.result};b.onsuccess=()=>{products=b.result};tx.oncomplete=()=>ok({pending:mutations.filter(r=>r.state!=='APPLIED').length,stock:products.find(p=>p.nombre==='Producto sintético')?.stock_actual})});db.close();return result});
  assert.deepEqual(await read(),{pending:1,stock:101});
  await page.reload({waitUntil:'domcontentloaded'});await page.getByText('Modo offline — ingresa tu PIN',{exact:true}).waitFor();for(const digit of ['1','2','3','4'])await page.getByRole('button',{name:digit,exact:true}).click();await page.getByRole('button',{name:'Ajuste',exact:true}).first().waitFor();assert.deepEqual(await read(),{pending:1,stock:101});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:new URL('../../scratch/shared-ui/inventory-mobile-original.png',import.meta.url).pathname.replace(/^\/(.:\/)/,'$1'),fullPage:true});
  await page.setViewportSize({width:1365,height:950});await page.getByRole('link',{name:/Ajustes/}).first().click();await page.getByText(/1 pendientes · 0 por revisar/).waitFor({timeout:10000});
  assert.deepEqual(errors,[]);
 }finally{await context.close();await browser.close()}
});
