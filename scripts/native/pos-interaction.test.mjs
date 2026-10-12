// Fixture de protocolo únicamente para presentación Chromium. El mismo
// frontend se prueba por separado contra IPC/SQLCipher reales en WebView2.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const dist=resolve(fileURLToPath(new URL('../../apps/pos/dist/',import.meta.url)));
test('POS definitivo: buscar/HID, ticket, navegación sin perder carrito, modal y guard doble click',async()=>{
 const server=createServer((req,res)=>{
  const path=resolve(dist,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(!(path===dist||path.startsWith(dist+sep))){res.writeHead(403).end();return;}
  const file=path===dist?resolve(dist,'index.html'):path;
  try{res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'}[extname(file)]??'application/octet-stream'}).end(readFileSync(file));}catch{res.writeHead(404).end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}`;let browser;
 try{
  browser=await chromium.launch({headless:true});const context=await browser.newContext();
  await context.addInitScript(()=>{
   window.isTauri=true;
   let count=0,stock=100,cart=null;const receipts=new Map();
   const products=[{id:'qa-product-01',name:'Producto QA 01',code:'000001',priceCents:'10000',stock:'100',revision:'1'}];
   window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
    if(command==='native_access_status')return {status:'NOT_CONFIGURED',configured:false,actorId:null,tenantId:null,role:null,pinEnrolled:false,tenants:[],catalogueReady:false};
    if(command==='qa_read')return {status:'READY',catalogue:{products:products.map(p=>({...p,stock:String(stock)})),confirmedSales:String(count),cashCents:String(count*11800),pendingOperations:String(count),lastResult:[...receipts.values()].at(-1)??null,pendingAttempt:null,carts:{active:cart,paused:[]}}};
    if(command==='qa_cart_save'){
     const input=args.cart;cart={id:input.cartId??input.requestId,revision:String(Number(input.expectedRevision??0)+1),label:'Venta en espera 1',lines:input.lines};return {requestId:input.requestId,cartId:cart.id,revision:cart.revision,workspace:{active:cart,paused:[]}};
    }
    if(command==='qa_quote'){
     const q=args.quote.lines[0]?.quantity??'0';const totals=q==='2'?['20000','3600','23600']:q==='1'?['10000','1800','11800']:['0','0','0'];
     const paid=args.quote.tenderCents;await new Promise(r=>setTimeout(r,15));
     const payable=q!=='0'&&paid!==null&&BigInt(paid)>=BigInt(totals[2]);
     return {subtotalCents:totals[0],itbisCents:totals[1],totalCents:totals[2],changeCents:payable?(BigInt(paid)-BigInt(totals[2])).toString():null,payable,quoteHash:payable?'b'.repeat(64):null,limits:[],discountCents:'0',lineTotals:args.quote.lines.map(l=>({productId:l.productId,subtotalCents:totals[0]}))};
    }
    if(command==='qa_sell'){
     if(receipts.has(args.sale.operationId))return receipts.get(args.sale.operationId);
     await new Promise(r=>setTimeout(r,150));count++;stock--;cart=null;
     const result={operationId:args.sale.operationId,hash:'a'.repeat(64),ticket:'QA-000001',totalCents:'11800',itbisCents:'1800',changeCents:'8200',remoteStatus:'NOT_ENABLED'};receipts.set(args.sale.operationId,result);return result;
    }
    if(command==='qa_result')return receipts.get(args.operationId)??null;
    throw {code:'QA_CONTRACT_INVALID'};
   }};
  });
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'/#/?source=synthetic');await page.getByRole('heading',{name:'Ventas',exact:true}).waitFor();
  await page.getByRole('textbox',{name:'Buscar producto',exact:true}).fill('000001');
  await page.getByRole('textbox',{name:'Buscar producto',exact:true}).press('Enter');
  await page.locator('[data-cart-total]').getByText('RD$ 118.00',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Clientes',exact:true}).click();await page.getByRole('heading',{name:'Clientes',exact:true}).waitFor();
  await page.getByRole('link',{name:'Ventas',exact:true}).click();await page.locator('[data-ticket-line]').waitFor();assert.equal(await page.locator('[data-ticket-line]').count(),1);
  await page.getByRole('button',{name:'Aumentar cantidad de Producto QA 01'}).click();await page.locator('[data-cart-total]').getByText('RD$ 236.00',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Disminuir cantidad de Producto QA 01'}).click();await page.locator('[data-cart-total]').getByText('RD$ 118.00',{exact:true}).waitFor();
  await page.locator('body').press('F2');assert.equal(await page.locator('#pos-search').evaluate(el=>el===document.activeElement),true);
  await page.getByRole('button',{name:/Cobrar Venta/}).click();await page.getByRole('dialog',{name:'Completar Pago'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Tarjeta',exact:true}).isEnabled(),true);
  assert.equal(await page.getByRole('button',{name:'Confirmar venta de prueba',exact:true}).isDisabled(),true);
  await page.getByLabel('Monto recibido (RD$)').fill('10');assert.equal(await page.getByRole('button',{name:'Confirmar venta de prueba',exact:true}).isDisabled(),true);
  await page.getByLabel('Monto recibido (RD$)').fill('200');await page.getByText('RD$ 82.00',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Confirmar venta de prueba',exact:true}).dblclick();
  await page.getByRole('heading',{name:'Venta confirmada localmente',exact:true}).waitFor();
  await page.getByRole('button',{name:'Nueva Venta →',exact:true}).click();
  assert.equal(await page.locator('[data-product="qa-product-01"] [data-stock]').textContent(),'99');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Ver Carrito (0)'}).click();
  await page.getByRole('button',{name:'Cerrar ticket',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:fileURLToPath(new URL('../../docs/native/evidence/native-pos-mobile.png',import.meta.url)),fullPage:true});
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>localStorage.length),0);
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
});
