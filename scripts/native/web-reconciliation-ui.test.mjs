// Definitive Settings with explicit IPC fixtures. No remote session/authority.
import {test} from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';import {fileURLToPath} from 'node:url';import {routeDistFixture} from './route-dist-fixture.mjs';
const root=new URL('../../apps/pos/dist/',import.meta.url),exportId='98000000-0000-4000-8000-000000000001';
test('Conciliación en Configuración: servicio pendiente, lectura perdida y recuperación sin replay financiero',{timeout:60000},async()=>{
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],remote=[],calls=[],preparations=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:1421/')&&!r.url().startsWith('data:')&&!r.url().startsWith('blob:'))remote.push(r.url())});
 const definition={name:'NEGOCIO QA · FIXTURE',whatsapp:'',phone:'',rnc:'',address:'',footer:'',logo:null,color:'dorado',font:'syne',bank:null};
 const summary={exportId,tenantId:'96000000-0000-4000-8000-000000000001',origin:'https://qa.ventard.invalid',profileAlias:'Navegador QA · FIXTURE',capturedAtMs:'1791909500000',state:'PRESERVED_REVIEW_REQUIRED',writersStopped:false,counts:{ventas:2,productos:1},pendingRows:2,remoteUnverifiedRows:3,unknownScopeRows:1,foreignTenantRows:0,unknownTenantRows:0,missingReferences:0,externalImageReferences:0,canActivate:false};
 let report=null,migrationPending=true,lost=true,steps=0;
 await page.exposeFunction('__reconciliationInvoke',async(command,args)=>{calls.push({command,args});const c=args.command;
  if(command==='native_access_status')return{status:'PREPARATION_REQUIRED',configured:true,actorId:'96000000-0000-4000-8000-000000000002',tenantId:summary.tenantId,role:'owner',pinEnrolled:true,catalogueReady:true,operationalReady:true,tenants:[]};
  if(command==='native_backup'){
   if(c.action==='STATUS')return{rows:[],canCreate:false};if(c.action==='WEB_STATUS')return{rows:[summary]};if(c.action==='WEB_ROWS')return{rows:[{id:'sale-qa',total:12.34,numero_ticket:7,ncf:'B0200000007',estado_sincronizacion:0}],total:2,page:c.page};
   if(c.action==='WEB_RECONCILE_VIEW')return{report};
   if(c.action==='WEB_RECONCILE_PREPARE'){preparations.push(c.reportId);report={reportId:c.reportId,exportId,state:'PENDING',lastError:null,totalBatches:2,completedBatches:0,createdAtMs:'1791909500000',counts:{},canActivate:false,coverage:'REQUESTED_IDS_ONLY_WINDOWED',effectStatus:'UNKNOWN_LEGACY'};return report;}
   if(c.action==='WEB_RECONCILE_STEP'){assert.equal(c.reportId,report.reportId);steps++;if(migrationPending){migrationPending=false;report={...report,state:'PENDING_ERROR',lastError:'MIGRATION_REQUIRED'};return report;}report={...report,state:report.completedBatches===1?'REVIEW_REQUIRED':'PENDING',completedBatches:report.completedBatches+1,lastError:null,counts:{MATCH_OBSERVED_FIELDS:1,DIFFERENT_OBSERVED:report.completedBatches===1?1:0}};if(lost){lost=false;throw{code:'IPC_RESPONSE_LOST'}}return report;}
   if(c.action==='WEB_RECONCILE_ROWS')return{rows:report.completedBatches?[{id:'sale-qa',table:'ventas',status:'MATCH_OBSERVED_FIELDS',effectStatus:'UNKNOWN_LEGACY',limitations:['REMOTE_EFFECTS_UNVERIFIED'],observedAtMs:'1791909600000'},...(report.completedBatches===2?[{id:'sale-different-qa',table:'ventas',status:'DIFFERENT_OBSERVED',effectStatus:'UNKNOWN_LEGACY',limitations:['REMOTE_EFFECTS_UNVERIFIED'],differentFields:['total'],reviewFields:[{field:'total',local:'12.34',remote:'12.35'}],observedAtMs:'1791909600001'}]:[])]:[],total:report.completedBatches,page:c.page};
  }
  if(command==='native_sales'){
   if(['READ','SYNCHRONIZE'].includes(c.action))return{status:'ready',mode:'staging-operational',business:definition,scopeRevision:'fixture',products:[],customers:[],confirmedSales:'0',cashCents:'0',pendingOperations:'0',carts:{active:null,paused:[]},lastResult:null,pendingAttempt:null};
   if(c.action==='MANAGEMENT_READ')return{canManage:true,planTier:'basico',customers:[],movements:[],pending:[],turn:null,coverage:'EXPLICIT_IPC_FIXTURE'};
   if(c.action==='SETTINGS_READ')return{supported:true,revision:'0',definition,canWrite:false,canLoadRemote:false,coverage:'EXPLICIT_IPC_FIXTURE'};
   if(c.action==='PRINT_LAYOUT_READ')return{layout:{paperWidth:'80mm',fontSize:'normal',density:'normal',copies:1,showLogo:true,autoPrint:false},canWrite:false};
   if(c.action==='PRINTER_READ')return{profile:{mode:'DIALOG',connection:'USB',queue:null,host:null,dots:576,cut:true,drawer:false},queues:[],canWrite:false};
   if(c.action==='FISCAL_SETTINGS_READ')return{configuration:null,capturedAtMs:null,pending:null,lastStatus:null,canWrite:false};
   if(c.action==='QUOTE')return{payable:false,lineTotals:[],totalCents:null,subtotalCents:null,itbisCents:null,changeCents:null};
  }throw Error('Unknown fixture: '+command+':'+c?.action);
 });
 await page.addInitScript(()=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:(c,a)=>window.__reconciliationInvoke(c,a)}});await routeDistFixture(page,'http://127.0.0.1:1421',root);await page.goto('http://127.0.0.1:1421/#/configuracion');
 await page.getByRole('button',{name:'Comparar copia con la nube',exact:true}).click();await page.getByText('El servicio de conciliación aún debe habilitarse en Staging.',{exact:false}).waitFor();assert.equal(report.completedBatches,0);
 await page.getByRole('button',{name:'Continuar la misma lectura',exact:true}).click();await page.getByText('Lotes: 1/2',{exact:false}).waitFor();await page.reload();await page.getByText('Lotes: 1/2',{exact:false}).waitFor();
 await page.getByRole('button',{name:'Continuar la misma lectura',exact:true}).click();await page.getByText('Comparación guardada; revisión pendiente',{exact:false}).waitFor();assert.equal(report.completedBatches,2);assert.equal(preparations.length,1);assert.equal(steps,3);assert.equal(report.canActivate,false);await page.getByText('Copia: 12.34',{exact:true}).waitFor();await page.getByText('Nube: 12.35',{exact:true}).waitFor();
 await page.getByRole('heading',{name:'Comparación con la nube',exact:true}).scrollIntoViewIfNeeded();await page.getByRole('heading',{name:'Comparación con la nube',exact:true}).locator('..').screenshot({path:fileURLToPath(new URL('../../docs/native/evidence/native-web-reconciliation-original.png',import.meta.url))});
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}assert.ok(!calls.some(c=>['CONFIRM','PRINT','EXECUTE','SYNCHRONIZE_LEGACY'].includes(c.args.command?.action)));assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
