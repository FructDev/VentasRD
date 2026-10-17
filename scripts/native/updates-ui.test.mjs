// Definitive Settings page, synthetic IPC only. Never installs or authenticates.
import {test} from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';import {routeDistFixture} from './route-dist-fixture.mjs';
test('production pilot Settings: no fiscal UI; signed update requires confirmation and preserves a pending-operation rejection',async()=>{
 const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),calls=[],errors=[];
 await routeDistFixture(page,'http://127.0.0.1:1421',new URL('../../apps/pos/dist/',import.meta.url));page.on('pageerror',e=>errors.push(e.message));
 let reject=true,status='READY';
 await page.exposeFunction('__updateFixture',async(cmd,args)=>{
  if(cmd==='native_access_status')return{environment:'production-pilot',status:'PREPARATION_REQUIRED',configured:true,actorId:'fixture-actor',tenantId:'fixture-tenant',role:'owner',pinEnrolled:true,tenants:[],operationalReady:true,catalogueReady:true};
  if(cmd==='native_update'){
   calls.push(structuredClone(args));if(args.command.action==='CHECK')status='AVAILABLE';
   if(args.command.action==='INSTALL'){if(reject)throw{code:'UPDATE_OPERATIONS_PENDING'};status='INSTALLING'}
   return{currentVersion:'0.1.8',status,version:status==='AVAILABLE'?'0.1.9':undefined,notes:'Actualización · FIXTURE explícito'};
  }
  if(cmd==='native_sales'&&['READ','SYNCHRONIZE'].includes(args.command.action))return{status:'ready',mode:'staging-operational',products:[],confirmedSales:'0',cashCents:'0',pendingOperations:'0',pendingAttempt:null,lastResult:null,carts:{active:null,paused:[]},customers:[],syncIssues:[]};
  if(cmd==='native_sales'&&args.command.action==='MANAGEMENT_READ')return{canManage:false,customers:[],movements:[],pending:[],turn:null};
  throw{code:'FIXTURE_UNSUPPORTED_READ'};
 });
 await page.addInitScript(()=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:(c,a)=>window.__updateFixture(c,a)}});
 await page.goto('http://127.0.0.1:1421/#/configuracion');
 await page.getByRole('heading',{name:'Actualización de VentaRD',exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Comprobantes fiscales',exact:false}).count(),0);
 await page.getByRole('button',{name:'Buscar actualizaciones',exact:true}).click();await page.getByText('Versión 0.1.9 disponible',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Actualizar VentaRD',exact:true}).click();let dialog=page.getByRole('dialog',{name:'Actualizar VentaRD',exact:true});
 await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();assert.equal(calls.filter(c=>c.command.action==='INSTALL').length,0);
 await page.getByRole('button',{name:'Actualizar VentaRD',exact:true}).click();dialog=page.getByRole('dialog',{name:'Actualizar VentaRD',exact:true});await dialog.getByRole('button',{name:'Instalar actualización',exact:true}).click();
 await page.getByRole('alert').getByText('Termina el carrito y sincroniza las operaciones pendientes antes de actualizar.',{exact:true}).waitFor();
 reject=false;await dialog.getByRole('button',{name:'Instalar actualización',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await page.getByRole('status').getByText('Instalando actualización. VentaRD se cerrará para completar la instalación.',{exact:true}).waitFor();
 const installs=calls.filter(c=>c.command.action==='INSTALL');assert.equal(installs.length,2);for(const c of installs){assert.deepEqual(c.command,{action:'INSTALL',version:'0.1.9',confirmation:'INSTALAR_ACTUALIZACION'});assert.equal(c.ipcVersion,'ventard.native.access.1')}
 assert.deepEqual(errors,[]);
 }finally{await browser.close()}
});
