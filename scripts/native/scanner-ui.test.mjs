// Definitive POS, explicit synthetic IPC/camera. ZXing fallback decodes actual
// EAN pixels; this does not certify a physical camera or grant OS permissions.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {routeDistFixture} from './route-dist-fixture.mjs';
const root=new URL('../../apps/pos/dist/',import.meta.url),url='http://127.0.0.1:4489';
const config=JSON.parse(await readFile(new URL('../../apps/pos/src-tauri/tauri.conf.json',import.meta.url),'utf8'));

async function fixture(browser,native=true){
 const context=await browser.newContext({viewport:{width:1100,height:810}});
 await context.addInitScript(({native})=>{
  window.isTauri=true;window.__scanValue=null;window.__cameraMode='ready';window.__tracksStopped=0;window.__cartSaves=0;
  let cart=null;
  const products=[{id:'camera-product',name:'Producto de cámara',code:native?'0000000000017':'000000000017',priceCents:'10000',stock:'100',revision:'1'},
   {id:'duplicate-1',name:'Código duplicado A',code:'222222',priceCents:'10000',stock:'100',revision:'1'},
   {id:'duplicate-2',name:'Código duplicado B',code:'222222',priceCents:'10000',stock:'100',revision:'1'}];
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   if(command==='native_access_status')return{status:'NOT_CONFIGURED',configured:false,pinEnrolled:false,tenants:[],catalogueReady:false};
   if(command==='qa_read')return{status:'READY',catalogue:{products,confirmedSales:'0',cashCents:'0',pendingOperations:'0',lastResult:null,pendingAttempt:null,carts:{active:cart,paused:[]}}};
   if(command==='qa_cart_save'){window.__cartSaves++;const r=args.cart;cart={id:r.cartId??r.requestId,revision:String(Number(r.expectedRevision??0)+1),label:'Carrito sintético',lines:r.lines};return{requestId:r.requestId,cartId:cart.id,revision:cart.revision,workspace:{active:cart,paused:[]}}}
   if(command==='qa_quote'){const lines=args.quote.lines;return{subtotalCents:lines.length?'10000':'0',itbisCents:lines.length?'1800':'0',totalCents:lines.length?'11800':'0',changeCents:null,payable:false,lineTotals:lines.map(l=>({productId:l.productId,subtotalCents:'10000'}))}}
   throw{code:'QA_CONTRACT_INVALID'};
  }};
  function stream(){
   const canvas=document.createElement('canvas');canvas.width=345;canvas.height=180;
   const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,345,180);
   // EAN-13 0000000000017 / UPC-A 000000000017, with quiet zones.
   // ZXing reports the UPC-A representation; the catalog preserves that text.
   const bits='101'+'0001101'.repeat(6)+'01010'+'1110010'.repeat(4)+'1100110'+'1000100'+'101';
   c.fillStyle='black';[...bits].forEach((b,i)=>{if(b==='1')c.fillRect((i+10)*3,10,3,160)});
   const value=canvas.captureStream(12);for(const t of value.getTracks()){const stop=t.stop.bind(t);t.stop=()=>{window.__tracksStopped++;stop()}}
   return value;
  }
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
   if(window.__cameraMode==='denied')throw new DOMException('Synthetic permission rejection','NotAllowedError');
   if(window.__cameraMode==='pending')return new Promise(resolve=>{window.__cameraRelease=()=>resolve(stream())});
   return stream();
  }});
  if(native)window.BarcodeDetector=class{
   static async getSupportedFormats(){return['ean_13','code_128']}
   async detect(){return window.__scanValue?[{rawValue:window.__scanValue},{rawValue:window.__scanValue}]:[]}
  };
  else window.BarcodeDetector=class{static async getSupportedFormats(){return['qr_code']}};
 },{native});
 const page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await routeDistFixture(page,url,root,config.app.security.csp);
 await page.goto(url+'/#/?source=synthetic');
 await page.getByRole('heading',{name:'Ventas',exact:true}).waitFor();
 return{context,page,errors};
}

test('scanner POS: exact text codes, duplicate guard, permission error, late stream close and HID coexist',{timeout:60000},async()=>{
 const browser=await chromium.launch({headless:true});try{
  const {context,page,errors}=await fixture(browser);
  const open=()=>page.getByRole('button',{name:'Escanear producto',exact:true}).click();
  await open();await page.getByRole('dialog',{name:'Escanear código de barras'}).waitFor();
  await page.getByRole('button',{name:'Cerrar cámara',exact:true}).press('F2');assert.equal(await page.getByRole('dialog',{name:'Completar Pago'}).count(),0);
  await page.evaluate(()=>{window.__scanValue='0000000000017'});
  await page.locator('[data-ticket-line="camera-product"]').waitFor({timeout:10000});
  await page.waitForFunction(()=>window.__tracksStopped>0);assert.equal(await page.evaluate(()=>window.__cartSaves),1);
  const saves=await page.evaluate(()=>window.__cartSaves);
  await page.evaluate(()=>{window.__scanValue='000000000001'});await open();
  await page.getByText('Ese código no está en tu inventario.',{exact:true}).waitFor();
  assert.equal(await page.locator('#pos-search').inputValue(),'000000000001');assert.equal(await page.evaluate(()=>window.__cartSaves),saves);
  await page.evaluate(()=>{window.__scanValue='222222'});await open();
  await page.getByText('Varios productos tienen ese código. Elige el producto correcto.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__cartSaves),saves);
  await page.evaluate(()=>{window.__cameraMode='denied'});await open();
  await page.getByText('Sin acceso a la cámara',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Volver',exact:true}).click();
  await page.evaluate(()=>{window.__cameraMode='pending';window.__scanValue=null});await open();
  await page.waitForFunction(()=>typeof window.__cameraRelease==='function');
  const stopped=await page.evaluate(()=>window.__tracksStopped);
  await page.getByRole('button',{name:'Cerrar cámara',exact:true}).press('Escape');
  await page.evaluate(()=>window.__cameraRelease());await page.waitForFunction(old=>window.__tracksStopped>old,stopped);
  assert.equal(await page.getByRole('dialog',{name:'Escanear código de barras'}).count(),0);
  await page.locator('body').press('F2');assert.equal(await page.locator('#pos-search').evaluate(n=>n===document.activeElement),true);
  await page.locator('#pos-search').fill('0000000000017');await page.locator('#pos-search').press('Enter');
  await page.waitForFunction(()=>window.__cartSaves===2);assert.deepEqual(errors,[]);
  await context.close();
 }finally{await browser.close()}
});

test('scanner POS: unsupported native format falls back to bundled ZXing and decodes real UPC frames',{timeout:60000},async()=>{
 const browser=await chromium.launch({headless:true});try{
  const {context,page,errors}=await fixture(browser,false);
  await page.getByRole('button',{name:'Escanear producto',exact:true}).click();
  await page.locator('[data-ticket-line="camera-product"]').waitFor({timeout:20000});
  assert.equal(await page.evaluate(()=>window.__cartSaves),1);
  await page.waitForFunction(()=>window.__tracksStopped>0);assert.deepEqual(errors,[]);
  await context.close();
 }finally{await browser.close()}
});
