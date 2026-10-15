// Definitive VentaRD header with explicit IPC fixtures, never real credentials.
import {test} from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';import {routeDistFixture} from './route-dist-fixture.mjs';import {fileURLToPath} from 'node:url';
const id=n=>`96500000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const logo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
test('account header: business branding, signed-role labels, offline display, account isolation and local logout',async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage({viewport:{width:1440,height:940}}),calls=[],errors=[],remote=[];
  let account={status:'PREPARATION_REQUIRED',configured:true,actorId:id(2),tenantId:id(1),role:'owner',pinEnrolled:true,tenants:[],operationalReady:true,catalogueReady:true,presentation:{tenantId:id(1),actorId:id(2),actorName:null,businessName:'Negocio sintético A',logo,color:'cielo',font:'syne',capturedAtMs:'2000'}},business={name:'Negocio sintético A',rnc:null,address:null,phone:null},locks=0;
  const snapshot=()=>({business,mode:'staging-operational',scopeRevision:'1',products:[],confirmedSales:'0',cashCents:'0',pendingOperations:'2',lastResult:null,pendingAttempt:null,carts:{active:null,paused:[]},customers:[],syncIssues:[]});
  await routeDistFixture(page,'http://127.0.0.1:1421',new URL('../../apps/pos/dist/',import.meta.url));page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:1421/')&&!r.url().startsWith('data:')&&!r.url().startsWith('blob:'))remote.push(r.url())});
  await page.exposeFunction('__accountHeaderFixture',async(cmd,args)=>{calls.push({cmd,args});
   if(cmd==='native_access_status')return account;if(cmd==='native_access_lock'){locks++;account={...account,status:'LOCKED',presentation:null};return account;}
   if(cmd==='native_sales'&&['READ','SYNCHRONIZE'].includes(args.command.action))return snapshot();
   if(cmd==='native_sales'&&args.command.action==='QUOTE')return{payable:false,lineTotals:[],limits:[]};
   if(cmd==='native_sales'&&args.command.action==='MANAGEMENT_READ')return{canManage:true,customers:[],movements:[],pending:[],turn:null};
   throw Error('Unexpected header fixture command '+cmd+':'+args.command?.action);
  });
  await page.addInitScript(()=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:(cmd,args)=>window.__accountHeaderFixture(cmd,args)};window.__TAURI__={};});
  await page.goto('http://127.0.0.1:1421/#/');const header=page.locator('header');
  await header.getByRole('img',{name:'Negocio sintético A',exact:true}).waitFor();await header.getByText('Dueño',{exact:true}).waitFor();assert.equal(await header.getByRole('link',{name:'Iniciar sesión',exact:true}).count(),0);
  await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>false});window.dispatchEvent(new Event('offline'));});await header.getByLabel('Conexión del dispositivo: Offline',{exact:true}).waitFor();await header.getByText('Dueño',{exact:true}).waitFor();
  await header.screenshot({path:fileURLToPath(new URL('../../docs/native/evidence/native-account-header-original.png',import.meta.url))});
  account={...account,role:'admin',presentation:{...account.presentation,actorName:'Ana QA'}};await page.reload();await header.getByText('Ana QA',{exact:true}).waitFor();await header.getByText('Admin',{exact:true}).waitFor();
  business={...business,name:'Negocio sintético B'};account={...account,actorId:id(4),tenantId:id(3),role:'seller'};await page.reload();await header.getByText('Vendedor',{exact:true}).waitFor();assert.equal(await header.getByText('Ana QA',{exact:true}).count(),0);assert.equal(await header.getByRole('img').count(),0);await header.getByText('Mi cuenta',{exact:true}).waitFor();
  account={...account,actorId:id(2),tenantId:id(1),role:'owner'};business={...business,name:'Nombre actualizado QA',settingsRevision:'1',logo:null,color:'coral',font:'syne'};await page.reload();await header.getByText('Dueño',{exact:true}).waitFor();await header.getByText('Nombre actualizado QA',{exact:true}).first().waitFor();assert.equal(await header.getByRole('img').count(),0);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await header.getByRole('button',{name:'Menú de usuario',exact:true}).click();await header.getByRole('button',{name:'🚪 Cerrar sesión',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Cerrar sesión',exact:true});await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();assert.equal(locks,0);
  await header.getByRole('button',{name:'Menú de usuario',exact:true}).click();await header.getByRole('button',{name:'🚪 Cerrar sesión',exact:true}).click();await page.getByRole('dialog',{name:'Cerrar sesión',exact:true}).getByRole('button',{name:'Cerrar sesión',exact:true}).click();await page.waitForURL('**/#/login');assert.equal(locks,1);assert.equal(snapshot().pendingOperations,'2');
  assert.equal(calls.filter(c=>c.args.command?.action==='MANAGEMENT_EXECUTE').length,0);assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);
 }finally{await browser.close();}
});
