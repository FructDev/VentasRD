// Real permanent Sales UI + mocked native transport. Encryption/durability are
// separately exercised by account_drafts.rs; this is not remote/RLS evidence.
import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {readFileSync} from 'node:fs';import {resolve,extname,sep} from 'node:path';import {fileURLToPath} from 'node:url';import {chromium} from 'playwright';
const dist=fileURLToPath(new URL('../../apps/pos/dist',import.meta.url));
test('account Sales: bounded catalogue, durable drafts/retry/pause/swap, unknown amounts and blocked charge',async()=>{
 const server=createServer((req,res)=>{const p=resolve(dist,'.'+new URL(req.url,'http://localhost').pathname);if(!(p===dist||p.startsWith(dist+sep))){res.writeHead(403).end();return;}try{const f=p===dist?resolve(dist,'index.html'):p;res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(f)]??'application/octet-stream'}).end(readFileSync(f));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;let browser;
 const uuid=n=>`96000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 let snapshotId=uuid(900),workspace={active:null,paused:[]},loseResponse=false;
 const calls=[],requests=new Map(),effects=new Map();
 const products=Array.from({length:61},(_,i)=>({id:uuid(i+1),name:i===0?'Cuenta producto uno':i===1?'Precio desconocido':`Producto ${i+1}`,code:`SKU-${i+1}`,priceCents:i===1?null:'103',stock:i===0?null:'4',stockEvidence:i===0?'MISSING_BRANCH_AUTHORITY':'POINT_IN_TIME'}));
 const view={status:'PREPARATION_REQUIRED',configured:true,actorId:uuid(700),tenantId:uuid(701),role:'owner',pinEnrolled:true,tenants:[],catalogueReady:true};
 async function rpc(command,args){calls.push(command);assert.equal(args.ipcVersion,'ventard.native.access.1');
  if(command==='native_access_status')return structuredClone(view);
  if(command==='native_catalogue_read')return{manifest:{snapshotId,capturedAtMs:'1000',coverage:'CATALOGUE_PREVIEW_V1',watermark:null,context:{scopeType:'BRANCH',branchId:uuid(800)}},products};
  if(command==='native_cart_read')return structuredClone(workspace);
  if(command==='native_catalogue_quote'){const changed=args.lines.some(l=>l.revision!==snapshotId);const lineTotals=args.lines.map(l=>({productId:l.productId,subtotalCents:changed||products.find(p=>p.id===l.productId)?.priceCents===null?null:(103n*BigInt(l.quantity)).toString()}));return{subtotalCents:lineTotals.some(l=>l.subtotalCents===null)?null:lineTotals.reduce((n,l)=>n+BigInt(l.subtotalCents),0n).toString(),itbisCents:null,totalCents:null,changeCents:null,payable:false,lineTotals,limits:changed?['CATALOGUE_CHANGED']:['TAX_CONTEXT_UNAVAILABLE']};}
  if(command==='native_cart_save'||command==='native_cart_action'){
   const r=args.cart,raw=JSON.stringify(r);let ack=requests.get(r.requestId);
   if(ack){assert.equal(ack.raw,raw);}else{
    if(command==='native_cart_save'){const rev=workspace.active?String(BigInt(workspace.active.revision)+1n):'1';workspace.active={id:r.cartId??r.requestId,revision:rev,label:'Venta en espera '+(requests.size+1),lines:structuredClone(r.lines)};ack={raw,cartId:workspace.active.id,revision:rev};}
    else if(r.action==='PAUSE'){const cart=workspace.active;cart.revision=String(BigInt(cart.revision)+1n);workspace.paused.unshift(cart);workspace.active=null;ack={raw,cartId:cart.id,revision:cart.revision};}
    else{const index=workspace.paused.findIndex(c=>c.id===r.cartId);const target=workspace.paused.splice(index,1)[0];target.revision=String(BigInt(target.revision)+1n);if(r.action==='RESUME'){if(workspace.active)workspace.paused.unshift(workspace.active);workspace.active=target;}ack={raw,cartId:target.id,revision:target.revision};}
    requests.set(r.requestId,ack);effects.set(r.requestId,(effects.get(r.requestId)??0)+1);
    if(loseResponse){loseResponse=false;throw {code:'ACCESS_UNAVAILABLE'};}
   }
   return{requestId:r.requestId,cartId:ack.cartId,revision:ack.revision,workspace:structuredClone(workspace)};
  }
  throw {code:'CONTRACT_INVALID'};
 }
 try{browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:960}});const remote=[];await context.route('**/*',r=>{if(!r.request().url().startsWith(url+'/')){remote.push(r.request().url());return r.abort();}return r.continue();});
  await context.exposeBinding('__fixtureInvoke',async(_,command,args)=>rpc(command,args));await context.addInitScript(()=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__fixtureInvoke(command,args)};});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url+'/#/?source=preview');await page.getByRole('heading',{name:'Ventas',exact:true}).waitFor();
  assert.equal(await page.locator('[data-product]').count(),60);await page.getByRole('button',{name:'Sig ›',exact:true}).click();assert.equal(await page.locator('[data-product]').count(),1);
  await page.getByRole('textbox',{name:'Buscar producto',exact:true}).fill('Cuenta producto uno');await page.getByRole('button',{name:'Añadir Cuenta producto uno',exact:true}).click();
  await page.getByText('Carrito guardado localmente; se recupera al reabrir.',{exact:true}).waitFor();assert.match(await page.getByRole('button',{name:'Añadir Cuenta producto uno',exact:true}).innerText(),/No verificable/);
  loseResponse=true;await page.getByRole('button',{name:'Aumentar cantidad de Cuenta producto uno',exact:true}).click();await page.getByRole('button',{name:'Reintentar el mismo guardado',exact:true}).click();
  await page.getByText('Carrito guardado localmente; se recupera al reabrir.',{exact:true}).waitFor();assert.equal(workspace.active.lines[0].quantity,'2');assert.ok([...effects.values()].every(n=>n===1));
  await page.getByText('RD$ 2.06',{exact:true}).first().waitFor();assert.equal(await page.getByRole('button',{name:/Cobrar Venta/}).isDisabled(),true);assert.match(await page.locator('[data-cart-total]').innerText(),/Pendiente/);await page.keyboard.press('Space');assert.equal(await page.getByRole('heading',{name:'Completar Pago'}).count(),0);
  await page.getByRole('button',{name:/En espera/}).click();await page.getByRole('button',{name:'Pausar venta actual',exact:true}).click();
  await page.getByRole('textbox',{name:'Buscar producto',exact:true}).fill('Precio desconocido');await page.getByRole('button',{name:'Añadir Precio desconocido',exact:true}).click();await page.getByText('Carrito guardado localmente; se recupera al reabrir.',{exact:true}).waitFor();assert.match(await page.locator('[data-cart-total]').innerText(),/Pendiente/);
  await page.getByRole('button',{name:/En espera/}).click();await page.getByRole('button',{name:/^Retomar Venta en espera/}).click();assert.equal(workspace.active.lines[0].productId,uuid(1));assert.equal(workspace.paused[0].lines[0].productId,uuid(2));
  await page.reload();await page.getByRole('heading',{name:'Ventas',exact:true}).waitFor();await page.getByText('RD$ 2.06',{exact:true}).first().waitFor();assert.equal(await page.getByRole('button',{name:/Cobrar Venta/}).isDisabled(),true);
  snapshotId=uuid(901);await page.reload();await page.getByRole('button',{name:'Revisar precios del catálogo actual',exact:true}).click();await page.getByText('RD$ 2.06',{exact:true}).first().waitFor();assert.equal(workspace.active.lines[0].revision,snapshotId);
  await page.getByRole('link',{name:'Inventario',exact:true}).click();await page.getByRole('heading',{name:'Inventario',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Nuevo producto',exact:true}).isDisabled(),true);
  assert.ok(calls.every(c=>!c.startsWith('qa_')));assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>localStorage.length),0);
  await page.getByRole('link',{name:'Ventas',exact:true}).click();await page.getByRole('heading',{name:'Ventas',exact:true}).waitFor();await page.screenshot({path:fileURLToPath(new URL('../../docs/native/evidence/native-account-drafts.png',import.meta.url)),fullPage:true});
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
});
