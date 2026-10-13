// Original Settings route. Explicit IPC fixtures; real preservation is tested
// independently with WebCrypto -> Rust -> SQLCipher, not attributed to this UI.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {routeDistFixture} from './route-dist-fixture.mjs';
import {fileURLToPath} from 'node:url';
const root=new URL('../../apps/pos/dist/',import.meta.url);
test('Traslado en Configuración: recepción perdida, copia conservada, consulta y móvil sin enviar ventas',{timeout:60000},async()=>{
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],remote=[],calls=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:1421/')&&!r.url().startsWith('data:')&&!r.url().startsWith('blob:'))remote.push(r.url())});
 const summary={exportId:'98000000-0000-4000-8000-000000000001',tenantId:'96000000-0000-4000-8000-000000000001',origin:'https://qa.ventard.invalid',profileAlias:'Navegador QA · FIXTURE',capturedAtMs:'1791849600000',state:'PRESERVED_REVIEW_REQUIRED',writersStopped:false,counts:{ventas:1,productos:1,venta_detalles:1},pendingRows:2,remoteUnverifiedRows:2,unknownScopeRows:1,foreignTenantRows:0,unknownTenantRows:0,missingReferences:0,externalImageReferences:0,canActivate:false};
 const definition={name:'NEGOCIO SINTÉTICO QA',whatsapp:'',phone:'',rnc:'',address:'',footer:'',logo:null,color:'dorado',font:'syne',bank:null};let lost=true,invalid=true;const received=[];
 await page.exposeFunction('__migrationInvoke',async(command,args)=>{
  calls.push({command,args});assert.equal(args.ipcVersion,'ventard.native.access.1');
  if(command==='native_access_status')return{status:'PREPARATION_REQUIRED',configured:true,actorId:'96000000-0000-4000-8000-000000000002',tenantId:summary.tenantId,role:'owner',pinEnrolled:true,catalogueReady:true,operationalReady:true,tenants:[]};
  const c=args.command;
  if(command==='native_backup'){
   if(c.action==='WEB_STATUS')return{rows:received};
   if(c.action==='WEB_IMPORT'){if(invalid){invalid=false;throw{code:'WEB_IMPORT_KEY_INVALID'}}if(!received.length)received.push(summary);if(lost){lost=false;throw{code:'IPC_RESPONSE_LOST'}}return summary;}
   if(c.action==='WEB_ROWS'){assert.equal(c.exportId,summary.exportId);return{rows:c.table==='ventas'?[{id:'sale-qa',total:12.34,numero_ticket:7,ncf:'B0200000007',estado_sincronizacion:0}]:c.table==='productos'?[{id:'product-qa',nombre:'PRODUCTO SINTÉTICO',codigo_barras:'00001',stock_actual:4}]:[],total:1,page:c.page};}
   if(c.action==='STATUS')return{rows:[],canCreate:false};
  }
  if(command==='native_sales'){
   if(['READ','SYNCHRONIZE'].includes(c.action))return{status:'ready',mode:'staging-operational',business:definition,scopeRevision:'fixture',products:[],customers:[],confirmedSales:'0',cashCents:'0',pendingOperations:'0',carts:{active:null,paused:[]},lastResult:null,pendingAttempt:null};
   if(c.action==='MANAGEMENT_READ')return{canManage:true,planTier:'basico',customers:[],movements:[],pending:[],turn:null,coverage:'EXPLICIT_IPC_FIXTURE'};
   if(c.action==='SETTINGS_READ')return{supported:true,revision:'0',definition,canWrite:false,canLoadRemote:false,coverage:'EXPLICIT_IPC_FIXTURE'};
   if(c.action==='PRINT_LAYOUT_READ')return{layout:{paperWidth:'80mm',fontSize:'normal',density:'normal',copies:1,showLogo:true,autoPrint:false},canWrite:false};
   if(c.action==='PRINTER_READ')return{profile:{mode:'DIALOG',connection:'USB',queue:null,host:null,dots:576,cut:true,drawer:false},queues:[],canWrite:false};
   if(c.action==='FISCAL_SETTINGS_READ')return{configuration:null,capturedAtMs:null,pending:null,lastStatus:null,canWrite:false};
   if(c.action==='QUOTE')return{payable:false,lineTotals:[],totalCents:null,subtotalCents:null,itbisCents:null,changeCents:null};
  }
  throw Error('Unexpected fixture command: '+command+':'+c?.action);
 });
 await page.addInitScript(()=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:(c,a)=>window.__migrationInvoke(c,a)}});
 await routeDistFixture(page,'http://127.0.0.1:1421',root);
 await page.goto('http://127.0.0.1:1421/#/configuracion');
 await page.getByRole('button',{name:'Recibir archivo del navegador',exact:true}).click();await page.getByText('La llave no corresponde al archivo',{exact:false}).waitFor();assert.equal(received.length,0);
 await page.getByRole('button',{name:'Recibir archivo del navegador',exact:true}).click();assert.equal(received.length,1);
 await page.reload();await page.getByText('Copia conservada · migración pendiente',{exact:true}).waitFor();await page.getByText('7 · RD$ 12.34 · Pendiente',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Recibir archivo del navegador',exact:true}).click();await page.getByText('Archivo recibido. Integridad comprobada',{exact:false}).waitFor();assert.equal(received.length,1);
 await page.getByLabel('Revisar datos conservados').selectOption('productos');await page.getByText('PRODUCTO SINTÉTICO',{exact:true}).waitFor();
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('heading',{name:'Traslado desde la web',exact:true}).locator('..').screenshot({path:fileURLToPath(new URL('../../docs/native/evidence/native-web-migration-settings.png',import.meta.url))});
 assert.ok(calls.some(c=>c.args.command?.action==='WEB_ROWS'));assert.ok(!calls.some(c=>['CONFIRM','PRINT','EXECUTE'].includes(c.args.command?.action)));assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);
 }finally{await browser.close();}
});
