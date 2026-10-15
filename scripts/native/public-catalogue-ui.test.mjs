// Definitive settings page, explicit synthetic IPC; never publishes a business.
import {test} from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';import {routeDistFixture} from './route-dist-fixture.mjs';import {fileURLToPath} from 'node:url';
const tenant='96000000-0000-4000-8000-000000000001',actor='96000000-0000-4000-8000-000000000003';
test('catalogue UI: pending is not published, missing deployment, exact recovered intent and permissions',{timeout:60000},async()=>{
 const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));
 let revision='1',canManage=true,lose=true,request=null;
 const view={lastConfirmed:null,pending:[],remote:{version:'ventard.catalogue.publication.1',tenantId:tenant,enabled:false,revision:'0',publicPath:'/catalogo/'+tenant},remoteError:null,webOrigin:null};
 const definition={name:'CATÁLOGO · FIXTURE',whatsapp:'',phone:'',rnc:'',address:'',footer:'',logo:null,color:'dorado',font:'syne',bank:null};
 await routeDistFixture(page,'http://127.0.0.1:1421',new URL('../../apps/pos/dist/',import.meta.url));
 await page.exposeFunction('__catalogueFixture',async(cmd,{command:c}={})=>{
 if(cmd==='native_access_status')return{status:'PREPARATION_REQUIRED',configured:true,actorId:actor,tenantId:tenant,role:canManage?'owner':'seller',pinEnrolled:true,tenants:[],operationalReady:true,catalogueReady:true};
 if(cmd!=='native_sales')throw{code:'EXPLICIT_FIXTURE_UNAVAILABLE'};
 if(['READ','SYNCHRONIZE'].includes(c.action))return{mode:'staging-operational',scopeRevision:revision,business:{name:definition.name},products:[],confirmedSales:'0',cashCents:'0',pendingOperations:String(view.pending.length),lastResult:null,pendingAttempt:null,carts:{active:null,paused:[]},customers:[],syncIssues:[]};
 if(c.action==='MANAGEMENT_READ')return{canManage,customers:[],movements:[],pending:request?[request]:[],turn:null};
 if(c.action==='CATALOGUE_READ')return view;
 if(c.action==='SETTINGS_READ')return{revision:'0',definition,remoteStatus:'CAPTURED',canWrite:canManage,coverage:'EXPLICIT_FIXTURE'};
 if(c.action==='PRINT_LAYOUT_READ')return{layout:{paperWidth:'80mm',fontSize:'normal',density:'normal',copies:1},canWrite:canManage};
 if(c.action==='MANAGEMENT_EXECUTE'){if(!canManage)throw{code:'PERMISSION_DENIED'};if(request)assert.deepEqual(c.request,request);else{request=c.request;requests.push(request)}if(lose){lose=false;throw{code:'IPC_RESPONSE_LOST'}}view.pending=[{operationId:request.operationId,state:'PENDING'}];revision='2';request=null;return{operationId:c.request.operationId,kind:'CONFIG_PATCH',remoteStatus:'PENDING',document:{}}}
 throw{code:'EXPLICIT_FIXTURE_UNAVAILABLE'};
 });
 await page.addInitScript(()=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:(cmd,args)=>window.__catalogueFixture(cmd,args)};});
 await page.goto('http://127.0.0.1:1421/#/configuracion');const toggle=page.getByRole('switch',{name:'Activar catálogo público'});await toggle.waitFor();await page.getByText('Dirección web pendiente de configurar.',{exact:false}).waitFor();
 await toggle.click();await page.getByRole('button',{name:'Recuperar el mismo intento',exact:true}).click();await page.getByRole('button',{name:'Actualizar catálogo',exact:true}).click();assert.equal(requests.length,1);assert.equal(requests[0].expectedEnabled,false);assert.equal(await toggle.getAttribute('aria-checked'),'false');assert.equal(await toggle.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Compartir por WhatsApp',exact:true}).count(),0);
 view.pending=[];view.remote.enabled=true;view.remote.revision='1';view.lastConfirmed={...view.remote};await page.getByRole('button',{name:'Actualizar catálogo',exact:true}).click();await page.getByText('Última consulta al servidor: catálogo activado.',{exact:true}).waitFor();assert.equal(await toggle.getAttribute('aria-checked'),'true');
 await page.setViewportSize({width:390,height:844});await toggle.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:fileURLToPath(new URL('../../docs/native/evidence/native-public-catalogue-settings.png',import.meta.url))});
 view.remote=null;view.remoteError='ACCESS_LOGIN_REQUIRED';await page.getByRole('button',{name:'Actualizar catálogo',exact:true}).click();assert.equal(await toggle.isDisabled(),true);await page.getByText('Última confirmación nativa guardada:',{exact:false}).waitFor();
 canManage=false;await page.reload();await toggle.waitFor();assert.equal(await toggle.isDisabled(),true);assert.deepEqual(errors,[]);
 }finally{await browser.close()}
});
