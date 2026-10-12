// UI REAL de nuestro proceso Tauri/WebView2, sin mock de IPC/Dexie/Supabase.
// DEBUG qa-spike + CDP sólo loopback. Fixture cifrado/credencial QA retenidos
// para diagnóstico; no borrar DB/credenciales del usuario ni enumerarlas.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../../',import.meta.url));
// Alternate artifact of the SAME app when Windows holds the previous exe.
// No arbitrary executable/path accepted from env.
const candidates={standard:'target/debug/ventard-pos.exe',catalogue:'target/debug/ventard-pos-catalogue.exe','account-drafts':'target/debug/ventard-pos-account-drafts.exe'};
const candidate=process.env.VENTARD_QA_CANDIDATE??'standard';
assert.ok(Object.hasOwn(candidates,candidate),'only known compiled candidates');
const binary=join(root,candidates[candidate]);
test('Historial definitivo: cliente de contado, ticket congelado, filtros, readonly y reapertura',{timeout:90000},async()=>{
 const fixture=mkdtempSync(join(tmpdir(),'ventard-native-spike-'));let session=await launch(fixture);
 try {
  const page=session.page;await page.getByRole('button',{name:'Crear datos sintéticos'}).click();
  async function begin(){await page.getByRole('button',{name:'Añadir Producto QA 01',exact:true}).click();await page.locator('[data-cart-total]').getByText('RD$ 118.00',{exact:true}).waitFor();await page.getByRole('button',{name:/Cobrar Venta/}).click();}
  async function finish(){await page.getByRole('button',{name:'Confirmar venta de prueba',exact:true}).click();await page.getByRole('heading',{name:'Venta confirmada localmente',exact:true}).waitFor();await page.getByRole('button',{name:'Nueva Venta →',exact:true}).click();}
  await begin();await page.getByLabel('Monto recibido (RD$)',{exact:true}).fill('200');await page.getByLabel('Cliente de la venta',{exact:true}).selectOption({label:'Cliente sintético contado/fiado'});await finish();
  await begin();await page.getByRole('button',{name:'Tarjeta',exact:true}).click();await page.getByLabel('Nombre para el ticket',{exact:true}).fill('Cliente sin registro QA');await finish();
  await begin();await page.getByRole('button',{name:'Fiado',exact:true}).click();await page.getByLabel('Cliente para fiado').selectOption({label:'Cliente sintético contado/fiado · saldo RD$ 0.00 · límite RD$ 5,000.00'});await finish();
  const before=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('qa_read',{ipcVersion:'ventard.qa.ipc.1',requestId:crypto.randomUUID()}));
  assert.equal(before.catalogue.confirmedSales,'3');assert.equal(before.catalogue.cashCents,'11800');assert.equal(before.catalogue.customers.find(c=>c.name==='Cliente sintético contado/fiado').balanceCents,'11800');
  await page.getByRole('button',{name:'Añadir Producto QA 02',exact:true}).click();
  await page.getByRole('link',{name:'Historial',exact:true}).click();await page.getByRole('columnheader',{name:'Ticket',exact:true}).waitFor({timeout:3000});
  assert.equal(await page.locator('[data-history-sale]').count(),3);
  await page.getByRole('button',{name:'Tarjeta',exact:true}).click();await page.getByRole('button',{name:'Ver ticket QAN-000002',exact:true}).waitFor();assert.equal(await page.locator('[data-history-sale]').count(),1);
  await page.getByRole('button',{name:'Ver ticket QAN-000002',exact:true}).click();await page.getByText('Cliente: Cliente sin registro QA',{exact:true}).waitFor();await page.getByRole('button',{name:'Cerrar ticket',exact:true}).click();
  await page.getByRole('button',{name:'Todos',exact:true}).click();await page.getByRole('textbox',{name:'Buscar venta',exact:true}).fill('%');await page.getByText('No hay coincidencias en el historial nativo local.',{exact:true}).waitFor();
  await page.getByRole('textbox',{name:'Buscar venta',exact:true}).fill('Cliente sin registro QA');await page.getByRole('button',{name:'Ver ticket QAN-000002',exact:true}).waitFor();assert.equal(await page.locator('[data-history-sale]').count(),1);
  assert.equal(await page.getByRole('button',{name:'Devolución',exact:true}).isDisabled(),true);
  await page.getByRole('textbox',{name:'Buscar venta',exact:true}).fill('');await page.locator('[data-history-sale]').first().waitFor();
  await page.screenshot({path:join(root,'docs/native/evidence/native-sales-history.png'),fullPage:true});
  const after=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('qa_read',{ipcVersion:'ventard.qa.ipc.1',requestId:crypto.randomUUID()}));assert.equal(after.catalogue.confirmedSales,before.catalogue.confirmedSales);assert.equal(after.catalogue.cashCents,before.catalogue.cashCents);assert.deepEqual(after.catalogue.products,before.catalogue.products);
  await page.getByRole('link',{name:'Ventas',exact:true}).click();await page.getByRole('button',{name:'Aumentar cantidad de Producto QA 02',exact:true}).waitFor();
 }catch(error){console.log('Own synthetic History failure',await session.page.locator('label').allTextContents(),await session.page.locator('[role="alert"]').allTextContents());await session.page.screenshot({path:join(root,'docs/native/evidence/native-history-failure.png'),fullPage:true});throw error;}finally{await session.stop();}
 session=await launch(fixture);
 try {await session.page.getByRole('link',{name:'Historial',exact:true}).click();await session.page.getByRole('button',{name:'Ver ticket QAN-000001',exact:true}).click();await session.page.getByText('Cliente: Cliente sintético contado/fiado',{exact:true}).waitFor();assert.equal(await session.page.getByText('RD$ 118.00',{exact:true}).count()>0,true);}finally{await session.stop();}
});
test('Ventas completas en WebView2: cinco pagos, fiado, descuento, libre, serial/NCF, ticket y respuesta perdida', {timeout:120000},async()=>{
 const fixture=mkdtempSync(join(tmpdir(),'ventard-native-spike-'));let session=await launch(fixture);
 try{
  let page=session.page;await page.getByRole('button',{name:'Crear datos sintéticos'}).click();
  async function start(){await page.getByRole('button',{name:'Añadir Producto QA 01',exact:true}).click();await page.locator('[data-cart-total]').getByText('RD$ 118.00',{exact:true}).waitFor();await page.getByRole('button',{name:/Cobrar Venta/}).click();await page.getByRole('dialog',{name:'Completar Pago'}).waitFor();}
  async function finish(method){await page.getByRole('button',{name:'Confirmar venta de prueba',exact:true}).click();await page.getByRole('heading',{name:'Venta confirmada localmente',exact:true}).waitFor();await page.getByText(`Método: ${method}`,{exact:true}).waitFor();await page.getByRole('button',{name:'Ver ticket guardado'}).click();await page.getByRole('dialog',{name:/Ticket guardado/}).waitFor();await page.getByRole('button',{name:'Cerrar ticket',exact:true}).click();await page.getByRole('button',{name:'Nueva Venta →',exact:true}).click();}
  await start();assert.equal(await page.getByRole('button',{name:'Tarjeta',exact:true}).isEnabled(),true);await page.getByLabel('Monto recibido (RD$)',{exact:true}).fill('200');await finish('EFECTIVO');
  await start();await page.getByRole('button',{name:'Tarjeta',exact:true}).click();assert.equal(await page.getByLabel('Monto recibido (RD$)',{exact:true}).count(),0);await finish('TARJETA');
  await start();await page.getByRole('button',{name:'Transferencia',exact:true}).click();await finish('TRANSFERENCIA');
  await start();await page.getByRole('button',{name:'Mixto',exact:true}).click();await page.getByLabel('Parte efectivo (RD$)',{exact:true}).fill('18');await page.getByLabel('Parte transferencia (RD$)',{exact:true}).fill('100');await page.getByLabel('Monto recibido (RD$)',{exact:true}).fill('20');await finish('MIXTO');
  await start();await page.getByRole('button',{name:'Fiado',exact:true}).click();await page.getByLabel('Cliente para fiado').selectOption({label:'Cliente sintético límite bajo · saldo RD$ 0.00 · límite RD$ 1.00'});await page.getByText('El fiado supera el límite de crédito del cliente.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Confirmar venta de prueba',exact:true}).isEnabled(),false);await page.getByLabel('Cliente para fiado').selectOption({label:'Cliente sintético contado/fiado · saldo RD$ 0.00 · límite RD$ 5,000.00'});await finish('FIADO');
  await page.getByRole('button',{name:/Libre/}).click();await page.getByLabel('Descripción',{exact:true}).fill('Servicio libre sintético');await page.getByLabel('Precio libre (RD$)',{exact:true}).fill('100');await page.getByRole('button',{name:'Agregar línea libre'}).click();await page.getByRole('button',{name:/Cobrar Venta/}).click();await page.getByRole('button',{name:'Tarjeta',exact:true}).click();await page.getByLabel('Descuento (RD$)',{exact:true}).fill('10');await finish('TARJETA');
  await page.getByRole('button',{name:'Añadir Producto QA 10',exact:true}).click();await page.getByRole('button',{name:/Cobrar Venta/}).click();await page.getByRole('button',{name:'Tarjeta',exact:true}).click();await page.getByLabel('Serial / IMEI de Producto QA 10').selectOption('000000000000001');await page.getByLabel('Comprobante de prueba').selectOption('B02');await page.getByRole('button',{name:'Confirmar venta de prueba',exact:true}).click();await page.getByText('NCF de prueba: B0200000001',{exact:true}).waitFor();await page.getByRole('button',{name:'Ver ticket guardado'}).click();await page.getByText('Serial / IMEI: 000000000000001',{exact:true}).waitFor();await page.getByRole('button',{name:'Cerrar ticket',exact:true}).click();await page.getByRole('button',{name:'Nueva Venta →',exact:true}).click();
  await session.stop();session=await launch(fixture,{loseSaleResponseOnce:true});page=session.page;
  await start();await page.getByRole('button',{name:'Tarjeta',exact:true}).click();
  await page.getByRole('button',{name:'Confirmar venta de prueba',exact:true}).click();await page.getByText('No se pudo completar la operación (QA_RESPONSE_LOST). Los datos se conservaron.',{exact:true}).first().waitFor();
  await page.getByRole('button',{name:'Confirmar venta de prueba',exact:true}).click();await page.getByRole('heading',{name:'Venta confirmada localmente',exact:true}).waitFor();
  const ticket=(await page.locator('[data-sale-result]').innerText()).match(/Ticket (QAN-[0-9]+)/)[1];assert.equal(ticket,'QAN-000008');
  const state=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('qa_read',{ipcVersion:'ventard.qa.ipc.1',requestId:crypto.randomUUID()}));
  assert.equal(state.catalogue.confirmedSales,'8');assert.equal(state.catalogue.products.find(p=>p.id==='qa-product-01').stock,'94');assert.equal(state.catalogue.products.find(p=>p.id==='qa-product-10').stock,'99');assert.equal(state.catalogue.cashCents,'13600');
  await session.stop();session=await launch(fixture);await session.page.getByRole('button',{name:new RegExp('Recuperar venta · '+ticket)}).click();await session.page.getByRole('heading',{name:'Venta confirmada localmente',exact:true}).waitFor();
  await session.page.screenshot({path:join(root,'docs/native/evidence/native-sales-complete.png'),fullPage:true});
 }catch(error){
  console.log('Synthetic Sales failure',await session.page.evaluate(()=>({alerts:[...document.querySelectorAll('[role="alert"]')].map(n=>n.textContent),confirmed:!!document.querySelector('[data-sale-result]'),invokeWritable:Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__,'invoke')?.writable,invokeConfigurable:Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__,'invoke')?.configurable})));
  await session.page.screenshot({path:join(root,'docs/native/evidence/native-sales-failure.png'),fullPage:true});throw error;
 }finally{await session.stop();}
});
async function freePort(){
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port;await new Promise(r=>server.close(r));return port;
}
async function launch(fixture,{loseSaleResponseOnce=false}={}){
 const port=await freePort();
 const child=spawn(binary,[],{cwd:root,windowsHide:true,env:{...process.env,VENTARD_QA_SHELL_SMOKE:'1',VENTARD_QA_FIXTURE_ROOT:fixture,VENTARD_QA_CDP_PORT:String(port),VENTARD_QA_LOSE_SALE_RESPONSE_ONCE:loseSaleResponseOnce?'1':'0'},stdio:['ignore','pipe','pipe']});
 let browser;
 try {
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
   if(child.exitCode!==null)throw Error('OWN_QA_PROCESS_EXITED');
   try {const res=await fetch(`http://127.0.0.1:${port}/json/version`);if(res.ok)break;} catch {}
   await new Promise(r=>setTimeout(r,100));
  }
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context=browser.contexts()[0];let page;
  const pageDeadline=Date.now()+10000;
  do {page=context.pages().find(p=>/^https?:\/\/tauri\.localhost/.test(p.url()));if(page)break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<pageDeadline);
  assert.ok(page,'only our packaged main WebView is in scope');
  await page.goto('http://tauri.localhost/#/?source=synthetic');
  await page.getByRole('heading',{name:'Ventas',exact:true}).waitFor();
  return {page,context,async stop(){child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await browser.close().catch(()=>{});}};
 } catch(e){child.kill();await browser?.close().catch(()=>{});throw e;}
}
test('WebView2: seed → carrito → venta SQLite → matar/reabrir → recuperar mismo resultado', {timeout:90000},async()=>{
 assert.ok(existsSync(binary),'build QA required');
 const fixture=mkdtempSync(join(tmpdir(),'ventard-native-spike-'));
 let session=await launch(fixture);
 try {
  await session.page.getByRole('button',{name:'Crear datos sintéticos'}).click();
  const stock=session.page.locator('[data-product="qa-product-01"] [data-stock]');
  await stock.getByText('100',{exact:true}).waitFor();
  const forbidden=[];
  session.page.on('request',r=>{if(/^https?:/.test(r.url())&&!/^https?:\/\/(?:tauri|ipc)\.localhost\//.test(r.url()))forbidden.push(r.url());});
  await session.page.getByRole('button',{name:'Añadir Producto QA 01',exact:true}).click();
  await session.page.locator('[data-cart-total]').getByText('RD$ 118.00',{exact:true}).waitFor();
  await session.page.getByRole('button',{name:/Cobrar Venta/}).click();
  await session.page.getByRole('dialog',{name:'Completar Pago'}).waitFor();
  await session.page.getByLabel('Monto recibido (RD$)').fill('200');
  await session.page.getByText('RD$ 82.00',{exact:true}).waitFor();
  await session.page.screenshot({path:join(root,'docs/native/evidence/native-pos-checkout.png'),fullPage:true});
  await session.page.getByRole('button',{name:'Confirmar venta de prueba',exact:true}).click();
  await session.page.getByRole('heading',{name:'Venta confirmada localmente',exact:true}).waitFor();
  assert.match(await session.page.locator('[data-sale-result]').textContent(),/RD\$ 118\.00.*RD\$ 18\.00/);
  const nativeState=await session.page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('qa_read',{ipcVersion:'ventard.qa.ipc.1',requestId:crypto.randomUUID()}));
  assert.equal(nativeState.catalogue.confirmedSales,'1');assert.equal(nativeState.catalogue.cashCents,'11800');assert.equal(nativeState.catalogue.products[0].stock,'99');
  assert.deepEqual(forbidden,[]);
  // Matriz deny del comando nativo real, no sólo ocultar controles en React.
  const denied=await session.page.evaluate(async()=>{
    try {await window.__TAURI_INTERNALS__.invoke('qa_read',{ipcVersion:'wrong',requestId:crypto.randomUUID()});return 'ACCEPTED';}catch(e){return e.code;}
  });
  assert.equal(denied,'QA_CONTRACT_INVALID');
  await session.page.screenshot({path:join(root,'docs/native/evidence/native-pos-payment.png'),fullPage:true});
  await session.page.getByRole('button',{name:'Nueva Venta →',exact:true}).click();
  assert.equal(await stock.textContent(),'99');
  await session.page.screenshot({path:join(root,'docs/native/evidence/native-pos-sales.png'),fullPage:true});
  await session.page.getByRole('link',{name:'Inventario',exact:true}).click();
  await session.page.getByRole('heading',{name:'Inventario',exact:true}).waitFor();
  assert.equal(await session.page.locator('[data-inventory-product]').count(),10);
  // La muestra tiene exactamente una página de 10 filas (decisión del usuario).
  assert.equal(await session.page.getByRole('button',{name:'Sig ›'}).isDisabled(),true);
  await session.page.getByText('Producto QA 10',{exact:true}).waitFor();
  await session.page.getByRole('textbox',{name:'Buscar producto',exact:true}).fill('000010');
  await session.page.getByText('Producto QA 10',{exact:true}).waitFor();
  assert.equal(await session.page.locator('[data-inventory-product]').count(),1);
 } finally {await session.stop();}
 session=await launch(fixture);
 try {
  await session.page.getByRole('button',{name:'Recuperar venta · QAN-000001',exact:true}).waitFor();
  assert.equal(await session.page.locator('[data-product="qa-product-01"] [data-stock]').textContent(),'99');
  await session.page.getByRole('button',{name:'Recuperar venta · QAN-000001',exact:true}).click();
  await session.page.getByRole('heading',{name:'Venta confirmada localmente',exact:true}).waitFor();
  const persisted=await session.page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('qa_read',{ipcVersion:'ventard.qa.ipc.1',requestId:crypto.randomUUID()}));
  assert.equal(persisted.catalogue.confirmedSales,'1');assert.equal(persisted.catalogue.cashCents,'11800');
  await session.page.getByRole('button',{name:'Nueva Venta →',exact:true}).click();
  // CDP viewport emulation does not resize the native WebView2 host window.
  // Responsive drawer coverage is separate in pos-interaction.test.mjs.
  assert.equal(await session.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await session.page.evaluate(()=>localStorage.length),0);
  assert.deepEqual(await session.page.evaluate(async()=>(await indexedDB.databases()).map(d=>d.name)),[]);
  console.log('PASS WebView2 native IPC + SQLCipher + Windows key; stock100→99; cash11800; same result after own-process kill; no remote confirmation');
 } finally {await session.stop();}
});

test('Ventas definitiva: guardar, pausar, intercambiar y reabrir carritos sin movimientos hasta cobrar',{timeout:90000},async()=>{
 const fixture=mkdtempSync(join(tmpdir(),'ventard-native-spike-'));let session=await launch(fixture);
 try{
  await session.page.getByRole('button',{name:'Crear datos sintéticos'}).click();await session.page.getByRole('button',{name:'Añadir Producto QA 01',exact:true}).click();await session.page.locator('[data-ticket-line]').waitFor();await session.page.getByRole('button',{name:'Aumentar cantidad de Producto QA 01'}).click();await session.page.locator('[data-cart-total]').getByText('RD$ 236.00',{exact:true}).waitFor();
  await session.page.getByRole('button',{name:/En espera/}).click({timeout:3000});const dialog=session.page.getByRole('dialog',{name:'Ventas en espera',exact:true});await dialog.getByRole('button',{name:'Pausar venta actual',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.equal(await session.page.locator('[data-ticket-line]').count(),0);await session.page.getByRole('button',{name:'Añadir Producto QA 02',exact:true}).click();await session.page.locator('[data-ticket-line]').waitFor();
  await session.page.getByRole('button',{name:/En espera/}).click();await session.page.getByRole('button',{name:'Retomar Venta en espera 1',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await session.page.getByRole('button',{name:'Aumentar cantidad de Producto QA 01'}).waitFor();assert.equal(await session.page.locator('[data-ticket-line]').count(),1);
  const state=await session.page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('qa_read',{ipcVersion:'ventard.qa.ipc.1',requestId:crypto.randomUUID()}));assert.equal(state.catalogue.carts.active.lines[0].quantity,'2');assert.equal(state.catalogue.carts.paused.length,1);assert.equal(state.catalogue.confirmedSales,'0');assert.equal(state.catalogue.cashCents,'0');assert.equal(state.catalogue.products[0].stock,'100');
 }finally{await session.stop();}
 session=await launch(fixture);
 try{
  await session.page.locator('[data-cart-total]').getByText('RD$ 236.00',{exact:true}).waitFor();await session.page.getByRole('button',{name:/En espera/}).click();const dialog=session.page.getByRole('dialog',{name:'Ventas en espera',exact:true});await dialog.getByRole('button',{name:'Retomar Venta en espera 2',exact:true}).waitFor();await session.page.screenshot({path:join(root,'docs/native/evidence/native-paused-carts.png'),fullPage:true});await dialog.getByRole('button',{name:'Cerrar ventas en espera',exact:true}).click();
  await session.page.getByRole('button',{name:/Cobrar Venta/}).click();await session.page.getByLabel('Monto recibido (RD$)').fill('300');await session.page.getByText('RD$ 64.00',{exact:true}).waitFor();await session.page.getByRole('button',{name:'Confirmar venta de prueba',exact:true}).click();await session.page.getByRole('heading',{name:'Venta confirmada localmente',exact:true}).waitFor();await session.page.getByRole('button',{name:'Nueva Venta →',exact:true}).click();
  const state=await session.page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('qa_read',{ipcVersion:'ventard.qa.ipc.1',requestId:crypto.randomUUID()}));assert.equal(state.catalogue.carts.active,null);assert.equal(state.catalogue.carts.paused.length,1);assert.equal(state.catalogue.confirmedSales,'1');assert.equal(state.catalogue.products[0].stock,'98');assert.equal(state.catalogue.cashCents,'23600');
  await session.page.getByRole('button',{name:/En espera/}).click();await session.page.getByRole('button',{name:'Retomar Venta en espera 2',exact:true}).click();await dialog.waitFor({state:'hidden'});await session.page.getByRole('button',{name:'Aumentar cantidad de Producto QA 02'}).waitFor();
 }finally{await session.stop();}
});

test('Inventario definitivo: alta, edición, entrada auditable y venta; reabrir conserva el producto',{timeout:90000},async()=>{
 const fixture=mkdtempSync(join(tmpdir(),'ventard-native-spike-'));let session=await launch(fixture);
 let id;
 try {
  await session.page.getByRole('button',{name:'Crear datos sintéticos'}).click();
  await session.page.getByRole('link',{name:'Inventario',exact:true}).click();
  await session.page.getByRole('button',{name:'Nuevo producto',exact:true}).click({timeout:3000});
  const form=session.page.getByRole('dialog',{name:'Nuevo producto',exact:true});
  await form.getByLabel('Nombre',{exact:true}).fill('Cable USB C');await form.getByLabel('Código / SKU',{exact:true}).fill('000011');await form.getByLabel('Precio de venta (RD$)',{exact:true}).fill('125.00');
  await form.getByRole('button',{name:'Guardar producto',exact:true}).dblclick();await form.waitFor({state:'hidden'});
  await session.page.getByRole('textbox',{name:'Buscar producto',exact:true}).fill('000011');
  const row=session.page.locator('[data-inventory-product]').filter({hasText:'Cable USB C'});await row.waitFor();id=await row.getAttribute('data-inventory-product');
  assert.equal(await row.locator('[data-stock]').textContent(),'0');
  await row.getByRole('button',{name:'Editar Cable USB C',exact:true}).click();
  const edit=session.page.getByRole('dialog',{name:'Editar producto',exact:true});await edit.getByLabel('Nombre',{exact:true}).fill('Cable USB C reforzado');
  assert.equal(await edit.getByLabel('Stock',{exact:true}).count(),0);await edit.getByRole('button',{name:'Guardar producto',exact:true}).click();await edit.waitFor({state:'hidden'});
  await row.getByRole('button',{name:'Ajustar stock de Cable USB C reforzado',exact:true}).click();
  const stockForm=session.page.getByRole('dialog',{name:'Ajustar stock',exact:true});await stockForm.getByLabel('Variación de unidades',{exact:true}).fill('1.5');await stockForm.getByLabel('Motivo',{exact:true}).fill('Entrada de prueba');await stockForm.getByRole('button',{name:'Registrar movimiento',exact:true}).click();await stockForm.getByRole('alert').waitFor();assert.equal(await row.locator('[data-stock]').textContent(),'0');
  await stockForm.getByLabel('Variación de unidades',{exact:true}).fill('5');await stockForm.getByRole('button',{name:'Registrar movimiento',exact:true}).dblclick();await stockForm.waitFor({state:'hidden'});
  assert.equal(await row.locator('[data-stock]').textContent(),'5');
  await session.page.getByRole('link',{name:'Ventas',exact:true}).click();await session.page.getByRole('heading',{name:'Ventas',exact:true}).waitFor();await session.page.getByRole('textbox',{name:'Buscar producto',exact:true}).fill('000011');await session.page.getByRole('textbox',{name:'Buscar producto',exact:true}).press('Enter');
  await session.page.locator('[data-cart-total]').getByText('RD$ 147.50',{exact:true}).waitFor();
  // Editar mientras un carrito referencia una versión anterior NO cobra con
  // el precio viejo ni reescribe la intención silenciosamente.
  await session.page.getByRole('link',{name:'Inventario',exact:true}).click();await session.page.getByRole('heading',{name:'Inventario',exact:true}).waitFor();await session.page.getByRole('textbox',{name:'Buscar producto',exact:true}).fill('000011');await session.page.getByRole('button',{name:'Editar Cable USB C reforzado',exact:true}).click();
  const repricing=session.page.getByRole('dialog',{name:'Editar producto',exact:true});await repricing.getByLabel('Precio de venta (RD$)',{exact:true}).fill('126.00');await repricing.getByRole('button',{name:'Guardar producto',exact:true}).click();await repricing.waitFor({state:'hidden'});
  await session.page.getByRole('link',{name:'Ventas',exact:true}).click();await session.page.getByRole('heading',{name:'Ventas',exact:true}).waitFor();await session.page.getByRole('alert').filter({hasText:'Los datos o el turno cambiaron'}).waitFor();assert.equal(await session.page.getByRole('button',{name:/Cobrar Venta/}).isDisabled(),true);
  await session.page.getByRole('button',{name:'Limpiar',exact:true}).click();await session.page.getByRole('button',{name:'Añadir Cable USB C reforzado',exact:true}).click();
  await session.page.locator('[data-cart-total]').getByText('RD$ 148.68',{exact:true}).waitFor();await session.page.getByRole('button',{name:/Cobrar Venta/}).click();await session.page.getByLabel('Monto recibido (RD$)').fill('200');await session.page.getByText('RD$ 51.32',{exact:true}).waitFor();await session.page.getByRole('button',{name:'Confirmar venta de prueba',exact:true}).click();await session.page.getByRole('heading',{name:'Venta confirmada localmente',exact:true}).waitFor();
 } finally {await session.stop();}
 session=await launch(fixture);
 try {
  const state=await session.page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('qa_read',{ipcVersion:'ventard.qa.ipc.1',requestId:crypto.randomUUID()}));
  assert.equal(state.catalogue.products.length,11);const p=state.catalogue.products.find(p=>p.id===id);assert.equal(p.name,'Cable USB C reforzado');assert.equal(p.stock,'4');assert.equal(p.priceCents,'12600');assert.equal(state.catalogue.confirmedSales,'1');assert.equal(state.catalogue.cashCents,'14868');
  await session.page.getByRole('link',{name:'Inventario',exact:true}).click();await session.page.getByRole('heading',{name:'Inventario',exact:true}).waitFor();await session.page.getByRole('textbox',{name:'Buscar producto',exact:true}).fill('000011');await session.page.getByText('Cable USB C reforzado',{exact:true}).waitFor();await session.page.screenshot({path:join(root,'docs/native/evidence/native-inventory.png'),fullPage:true});
 } finally {await session.stop();}
});
