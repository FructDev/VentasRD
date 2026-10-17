// Definitive pages; explicit synthetic IPC, never a real user's credentials.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {routeDistFixture} from './route-dist-fixture.mjs';

test('reopening and same-account renewal use the PIN and saved catalogue without registering or bootstrapping again',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage(),calls=[];
  let unlocked=false;
  const view=()=>({status:unlocked?'PREPARATION_REQUIRED':'LOCKED',configured:true,actorId:'fixture-actor',tenantId:'fixture-tenant',role:'owner',pinEnrolled:true,tenants:[],catalogueReady:unlocked,operationalReady:unlocked});
  const snapshot={status:'ready',mode:'staging-operational',products:[{id:'fixture-product',name:'Producto conservado',code:'KEPT',priceCents:'2500',stock:'18',revision:'1'}],confirmedSales:'2',cashCents:'0',pendingOperations:'1',lastResult:null,pendingAttempt:null,carts:{active:null,paused:[]},customers:[],syncIssues:[]};
  await routeDistFixture(page,'http://127.0.0.1:1421',new URL('../../apps/pos/dist/',import.meta.url));
  await page.exposeFunction('__reopenFixture',async(command,args)=>{
   calls.push({command,action:args.command?.action});
   if(command==='native_access_status')return view();
   if(command==='native_access_login')return view();
   if(command==='native_access_pin'){assert.equal(args.pin,'9876');assert.equal(args.enroll,false);unlocked=true;return view();}
   if(command==='native_access_lock'){unlocked=false;return view();}
   if(command==='native_sales'&&args.command.action==='READ')return snapshot;
   if(command==='native_sales'&&args.command.action==='SYNCHRONIZE')throw{code:'ACCESS_NETWORK_UNAVAILABLE'};
   if(command==='native_sales'&&args.command.action==='PRODUCT_PHOTOS')return{rows:[]};
   throw Error('Unexpected synthetic lifecycle call '+command+':'+args.command?.action);
  });
  await page.addInitScript(()=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__reopenFixture(command,args)};Object.defineProperty(navigator,'onLine',{get:()=>false});});
  for(let open=0;open<2;open++){
   unlocked=false;
   await page.goto('http://127.0.0.1:1421/#/');
   if(open>0)await page.reload();
   await page.getByRole('heading',{name:'Desbloquear VentaRD',exact:true}).waitFor();
   await page.getByLabel('PIN',{exact:true}).fill('9876');
   await page.getByRole('button',{name:'Desbloquear',exact:true}).click();
   await page.getByRole('button',{name:'Añadir Producto conservado',exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Descargar catálogo y abrir VentaRD',exact:true}).count(),0);
  }
  // Same account renewal returns the existing LOCKED view; go straight to PIN.
  unlocked=false;await page.goto('http://127.0.0.1:1421/#/login');
  await page.getByLabel('Correo electrónico').fill('fixture@example.test');
  await page.getByLabel('Contraseña').fill('synthetic-unused-password');
  await page.getByRole('button',{name:'Iniciar sesión',exact:true}).click();
  await page.getByRole('heading',{name:'Desbloquear VentaRD',exact:true}).waitFor();
  assert.equal(calls.filter(c=>c.command==='native_access_provision'||c.command==='native_catalogue_download'||c.action==='BOOTSTRAP').length,0);
  assert.equal(calls.filter(c=>c.command==='native_access_login').length,1);
  assert.equal(snapshot.products[0].stock,'18');assert.equal(snapshot.confirmedSales,'2');assert.equal(snapshot.pendingOperations,'1');
 }finally{await browser.close()}
});
