// Definitive Configuración, explicitly synthetic IPC. No remote mutations.
import {test} from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';import {routeDistFixture} from './route-dist-fixture.mjs';
const id=n=>`96400000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('recovery UI: original pending, explicit retirement, lost response and restart preserve one attempt',async()=>{const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[],remote=[],calls=[];let plan=null,retirements=0;
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:1421/')&&!r.url().startsWith('data:')&&!r.url().startsWith('blob:'))remote.push(r.url())});await routeDistFixture(page,'http://127.0.0.1:1421',new URL('../../apps/pos/dist/',import.meta.url));
 const definition={name:'RECOVERY · EXPLICIT IPC FIXTURE',whatsapp:'',phone:'',rnc:'',address:'',footer:'',logo:null,color:'dorado',font:'syne',bank:null};const snapshot={mode:'staging-operational',scopeRevision:'1',products:[],confirmedSales:'0',cashCents:'0',pendingOperations:'0',lastResult:null,pendingAttempt:null,carts:{active:null,paused:[]},customers:[],syncIssues:[]};
 await page.exposeFunction('__recoveryFixture',async(cmd,args)=>{calls.push({cmd,args});
  if(cmd==='native_access_status')return{status:'PREPARATION_REQUIRED',configured:true,actorId:id(2),tenantId:id(1),role:'owner',pinEnrolled:true,tenants:[],operationalReady:true,catalogueReady:true};
  const c=args.command;if(cmd==='native_sales'){
   if(c.action==='READ'||c.action==='SYNCHRONIZE')return snapshot;if(c.action==='QUOTE')return{payable:false,lineTotals:[],limits:[]};
   if(c.action==='MANAGEMENT_READ')return{canManage:true,planTier:'basico',customers:[],movements:[],pending:[],turn:null};
   if(c.action==='SETTINGS_READ')return{definition,revision:'1',canWrite:false,canLoadRemote:false,pending:null};
   if(c.action==='PRINT_LAYOUT_READ')return{layout:{paperWidth:'80mm',fontSize:'normal',density:'normal',copies:1,showLogo:true,autoPrint:false},canWrite:false};
   if(c.action==='PRINTER_READ')return{profile:{mode:'DIALOG',connection:'USB',queue:null,host:null,dots:512,cut:false,drawer:false},queues:[],canWrite:false,pendingProbe:null};
   if(c.action==='FISCAL_SETTINGS_READ')return{supported:false,canWrite:false,pending:null};throw Error('Unexpected native Sales action '+c.action);
  }
  assert.equal(cmd,'native_backup');
  if(c.action==='STATUS')return{canCreate:true,rows:[]};if(c.action==='WEB_STATUS')return{rows:[]};if(c.action==='TRANSITION_VIEW')return{report:null,capture:null};if(c.action==='RECOVERY_LIST')return{rows:plan?[plan]:[]};
  if(c.action==='INSPECT')return{backupId:id(881),handle:id(882),state:'VERIFIED',capturedAtMs:'1791712800000',databaseBytes:'65536',counts:{operation_journal:'1',sales:'1'}};
  if(c.action==='RECOVERY_PREPARE'){assert.equal(c.handle,id(882));plan={recoveryId:c.recoveryId,backupId:id(881),capturedAtMs:'1791712800000',state:'BLOCKED',review:{total:'1',verified:'0',unresolved:'1',canTransfer:false,replay:false,issues:[{operationId:id(700),code:'CLOUD_OPERATION_MISSING',pendingInBackup:true}]}};return plan;}
  if(c.action==='RECOVERY_SEND_PENDING'){assert.equal(c.originalStopped,true);assert.equal(c.recoveryId,plan.recoveryId);plan={...plan,state:'REVIEW',review:{...plan.review,verified:'1',unresolved:'0',issues:[],canTransfer:true}};return plan;}
  if(c.action==='RECOVERY_CONFIRM'){assert.equal(c.originalStopped,true);assert.equal(c.recoveryId,plan.recoveryId);plan={...plan,state:'PREPARED'};retirements++;throw{code:'NETWORK_UNAVAILABLE'};}
  if(c.action==='RECOVERY_RECOVER'){assert.equal(c.recoveryId,plan.recoveryId);plan={...plan,state:'ACTIVE'};return plan;}
  throw Error('Unexpected backup fixture '+c.action);
 });
 await page.addInitScript(()=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:(cmd,args)=>window.__recoveryFixture(cmd,args)}});await page.goto('http://127.0.0.1:1421/#/configuracion');
 await page.getByRole('button',{name:'Abrir y verificar respaldo',exact:true}).click();await page.getByRole('button',{name:'Preparar continuidad desde este respaldo',exact:true}).click();
 const pending=page.getByRole('button',{name:'Recuperar pendientes originales de mi usuario',exact:true});assert.equal(await pending.isDisabled(),true);await page.getByRole('checkbox',{name:/Recuperar sólo los pendientes nativos creados por mi usuario/}).check();await pending.click();
 const confirm=page.getByRole('button',{name:'Retirar equipo anterior y continuar',exact:true});assert.equal(await confirm.isDisabled(),true);await page.getByRole('checkbox',{name:/Acepto retirar su acceso/}).check();await confirm.click();await page.getByRole('button',{name:'Recuperar el mismo retiro',exact:true}).waitFor();
 const recoveryId=plan.recoveryId;await page.reload();await page.getByRole('button',{name:'Recuperar el mismo retiro',exact:true}).click();await page.getByText('Equipo nuevo habilitado; respaldo conservado',{exact:true}).waitFor();assert.equal(plan.recoveryId,recoveryId);assert.equal(retirements,1);assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);assert.equal(calls.some(c=>c.args?.command?.action==='MANAGEMENT_EXECUTE'),false);
}finally{await browser.close()}});
