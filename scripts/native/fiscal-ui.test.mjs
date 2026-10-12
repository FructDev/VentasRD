// Use the permanent preparation page; IPC fixture, not remote acceptance.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {readFileSync} from 'node:fs';import {resolve,extname,sep} from 'node:path';import {fileURLToPath} from 'node:url';import {chromium} from 'playwright';
const dist=fileURLToPath(new URL('../../apps/pos/dist',import.meta.url));
test('preparación real: NCF pending visible, no second double-click, retry and terminal unknown kind',async()=>{
 const server=createServer((req,res)=>{const p=resolve(dist,'.'+new URL(req.url,'http://localhost').pathname);if(!(p===dist||p.startsWith(dist+sep))){res.writeHead(403).end();return;}try{const file=p===dist?resolve(dist,'index.html'):p;res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]??'application/octet-stream'}).end(readFileSync(file));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;let browser;
 try{
  browser=await chromium.launch({headless:true});const context=await browser.newContext(),network=[];
  await context.route('**/*',r=>{if(!r.request().url().startsWith(url+'/')){network.push(r.request().url());return r.abort();}return r.continue();});
  await context.addInitScript(()=>{window.isTauri=true;window.__fiscalCalls=[];let pending=[],available='0',lastStatus=null,lastReason=null;const state=()=>({pending,availableB01:'0',availableB02:available,lastStatus,lastReason});window.__TAURI_INTERNALS__={invoke:async(name,args)=>{
   if(name==='native_access_status')return{status:'PREPARATION_REQUIRED',configured:true,actorId:'synthetic-actor',tenantId:'synthetic-tenant',role:'admin',pinEnrolled:true,tenants:[],catalogueReady:true};
   if(name==='native_fiscal_read')return state();
   if(name==='native_fiscal_prepare'){window.__fiscalCalls.push(args);await new Promise(r=>setTimeout(r,200));if(window.__fiscalCalls.length===1){pending=['B02'];throw{code:'FISCAL_REMOTE_UNAVAILABLE'};}pending=[];lastStatus=args.kind==='B02'?'ALLOCATED':'NO_BLOCK';lastReason=args.kind==='B02'?null:'KIND_NOT_CONFIGURED';if(args.kind==='B02')available='20';return state();}
   throw{code:'CONTRACT_INVALID'};
  }};});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url+'/#/preparacion');await page.getByText('Opciones de soporte',{exact:true}).click();
  await page.getByRole('heading',{name:'Comprobantes fiscales'}).waitFor({timeout:5000});
  await page.getByRole('button',{name:'Preparar 20 B02'}).dblclick();
  await page.getByText('Reserva B02 pendiente: se consultará el mismo ID antes de reenviar.').waitFor();
  assert.equal(await page.evaluate(()=>window.__fiscalCalls.length),1);
  await page.getByRole('button',{name:'Recuperar B02'}).click();
  await page.getByText('B02 disponibles: 20',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Preparar 20 B01'}).click();
  await page.getByText('El tipo solicitado no está configurado en la secuencia del negocio.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.length),0);assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  for(const args of await page.evaluate(()=>window.__fiscalCalls)){assert.deepEqual(Object.keys(args).sort(),['ipcVersion','kind','requestId']);assert.equal(args.ipcVersion,'ventard.native.access.1');}
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
});
