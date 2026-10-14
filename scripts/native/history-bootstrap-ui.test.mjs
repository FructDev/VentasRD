// Definitive Historial page and explicit IPC fixture; no remote authorization.
import {test} from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';
import {routeDistFixture} from './route-dist-fixture.mjs';import {command,id} from './sales-server.test.mjs';
test('history UI: download on definitive page, lost response and original ticket remain recoverable',async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[],remote=[],calls=[];let captured=false,lost=true;
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:1421/')&&!r.url().startsWith('data:')&&!r.url().startsWith('blob:'))remote.push(r.url());});
  await routeDistFixture(page,'http://127.0.0.1:1421',new URL('../../apps/pos/dist/',import.meta.url));
  const ticket=command(1900).snapshot;
  const snapshot=()=>({mode:'staging-operational',scopeRevision:'1',products:[],confirmedSales:captured?'1':'0',cashCents:'0',pendingOperations:'0',lastResult:null,pendingAttempt:null,carts:{active:null,paused:[]},customers:[],syncIssues:[]});
  await page.exposeFunction('__historyFixture',async(cmd,args)=>{
   calls.push({cmd,args});if(cmd==='native_access_status')return{status:'PREPARATION_REQUIRED',configured:true,actorId:id(2),tenantId:ticket.tenantId,role:'owner',pinEnrolled:true,tenants:[],operationalReady:true,catalogueReady:true};
   if(cmd==='native_history_read')return{rows:captured?[{operationId:ticket.operationId,ticket:ticket.ticket,dateMs:ticket.originAtUtcMs,method:'TARJETA',totalCents:'11800',itbisCents:'1800',discountCents:'0',ncf:null,customerName:null,ticketEvidence:'VERIFIED_SNAPSHOT',remoteStatus:'APPLIED'}]:[],total:captured?'1':'0',page:1,pageSize:10,scope:'BRANCH',branchId:ticket.scope.branchId,coverage:'LOCAL_NATIVE_ONLY'};
   if(cmd==='native_history_ticket'){assert.equal(args.operationId,ticket.operationId);return ticket;}
   assert.equal(cmd,'native_sales');const c=args.command;
   if(c.action==='READ'||c.action==='SYNCHRONIZE')return snapshot();if(c.action==='QUOTE')return{payable:false,lineTotals:[],limits:[]};
   if(c.action==='MANAGEMENT_READ')return{planTier:'basic',customers:[],movements:[],pending:[],turn:null,movementLimit:200,coverage:'EXPLICIT_IPC_FIXTURE',canManage:false};
   if(c.action==='HISTORY_LOAD_REMOTE'){captured=true;if(lost){lost=false;throw{code:'NETWORK_UNAVAILABLE'}}return{coverage:'NATIVE_LEDGER_THROUGH_WATERMARK',count:'1',watermark:'1',capturedAtMs:ticket.originAtUtcMs};}
   throw Error('Unexpected fixture action '+c.action);
  });
  await page.addInitScript(()=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:(cmd,args)=>window.__historyFixture(cmd,args)};});await page.goto('http://127.0.0.1:1421/#/historial');
  const button=page.getByRole('button',{name:'Descargar historial de la nube',exact:true});await button.click();await page.getByRole('alert').waitFor();await button.click();await page.getByText('Historia descargada: 1 operaciones verificadas. Se conservaron los tickets y saldos actuales.',{exact:true}).waitFor();
  await page.getByRole('button',{name:`Ver ticket ${ticket.ticket}`,exact:true}).waitFor();await page.reload();await page.getByRole('button',{name:`Ver ticket ${ticket.ticket}`,exact:true}).click();await page.getByRole('dialog').waitFor();assert.ok((await page.getByRole('dialog').innerText()).includes(ticket.ticket));
  assert.equal(calls.filter(c=>c.args?.command?.action==='HISTORY_LOAD_REMOTE').length,2);assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);
 }finally{await browser.close();}
});
