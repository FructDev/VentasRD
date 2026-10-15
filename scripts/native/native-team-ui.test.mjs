// Definitive Mi Equipo route; all accounts, tokens and IPC are synthetic.
import {test} from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';import {routeDistFixture} from './route-dist-fixture.mjs';import {fileURLToPath} from 'node:url';
const tenant='96000000-0000-4000-8000-000000000001',actor='96000000-0000-4000-8000-000000000003',version=n=>String(n).padStart(64,'0');
test('Mi Equipo: original form, private durable recovery, roles, removal, links and cashier navigation',{timeout:60000},async()=>{
 const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:980}}),errors=[],requests=[],calls=[];page.on('pageerror',e=>errors.push(e.message));
 let role='owner',lose=true,remoteReceipt=null,webOrigin='https://staging.example.test',counter=1,pending=null,lastReceipt=null;
 const members=[{id:'96000000-0000-4000-8000-000000000004',name:'Administrador · FIXTURE',email:'admin@example.test',role:'admin',active:true,pending:false,userId:actor,protected:true,expiresAtMs:null,version:version(1)}];
 const view=()=>({pending,lastReceipt,webOrigin,remoteError:role==='seller'?'TEAM_DENIED':null,remote:role==='seller'?null:{version:'ventard.team.view.1',tenantId:tenant,members}});
 await routeDistFixture(page,'http://127.0.0.1:1421',new URL('../../apps/pos/dist/',import.meta.url));
 await page.exposeFunction('__teamFixture',async(cmd,{command:c}={})=>{calls.push({cmd,action:c?.action});
 if(cmd==='native_access_status')return{status:'PREPARATION_REQUIRED',configured:true,actorId:actor,tenantId:tenant,role,pinEnrolled:true,tenants:[],operationalReady:true,catalogueReady:true};
 if(cmd!=='native_sales')throw{code:'EXPLICIT_FIXTURE_UNAVAILABLE'};
 if(['READ','SYNCHRONIZE'].includes(c.action))return{mode:'staging-operational',scopeRevision:'1',business:{name:'Equipo · IPC SINTÉTICO'},products:[],confirmedSales:'0',cashCents:'0',pendingOperations:'0',lastResult:null,pendingAttempt:null,carts:{active:null,paused:[]},customers:[],syncIssues:[]};
 if(c.action==='QUOTE')return{payable:false,lineTotals:[],limits:[]};
 if(c.action==='TEAM_READ')return view();
 if(c.action==='TEAM_SHARE'){assert.equal(c.operationId,lastReceipt.operationId);return{status:'DRAFT_REQUESTED'}}
 if(c.action==='TEAM_RECOVER'){assert.ok(pending);const result=remoteReceipt;pending=null;lastReceipt=result;return result}
 if(c.action==='TEAM_EXECUTE'){
  assert.ok(!pending);assert.equal(role,'owner');requests.push(c.input);pending=c.input;
  const q=c.input.command;let member;
  if(q.kind==='INVITE'){member={id:c.input.operationId,name:q.name,email:q.email,role:q.role,active:true,pending:true,userId:null,protected:false,expiresAtMs:String(Date.now()+86400000),version:version(++counter)};members.push(member)}
  else{member=members.find(m=>m.id===q.memberId);assert.equal(q.expectedVersion,member.version);member={...member,version:version(++counter),...(q.kind==='PATCH'?{role:q.role,active:q.active}:{})};members[members.findIndex(m=>m.id===member.id)]=member}
  remoteReceipt={version:'ventard.team.receipt.1',status:'APPLIED',tenantId:tenant,actorId:actor,operationId:c.input.operationId,requestHash:'a'.repeat(64),member,invitePath:q.kind==='PATCH'?null:'/unirse?token=96000000-0000-4000-8000-000000000099'};
  if(lose){lose=false;throw{code:'IPC_RESPONSE_LOST'}}pending=null;lastReceipt=remoteReceipt;return lastReceipt;
 }throw{code:'EXPLICIT_FIXTURE_UNAVAILABLE'};
 });
 await page.addInitScript(()=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:(cmd,args)=>window.__teamFixture(cmd,args)};});
 await page.goto('http://127.0.0.1:1421/#/configuracion/equipo');await page.getByRole('heading',{name:'Mi Equipo',exact:true}).waitFor();await page.getByRole('button',{name:'+ Agregar',exact:true}).click();const modal=page.getByRole('dialog',{name:'Nuevo empleado'});await modal.getByLabel('Nombre completo *').fill('Ana QA');await modal.getByLabel('Email (usuario para entrar) *').fill('ANA@example.test');await modal.getByRole('button',{name:'Crear usuario',exact:true}).click();await page.getByRole('button',{name:'Recuperar misma solicitud',exact:true}).waitFor();assert.equal(requests.length,1);
 await page.reload();await page.getByRole('button',{name:'Recuperar misma solicitud',exact:true}).click();await page.getByLabel('Enlace de invitación').waitFor();assert.equal(requests.length,1);assert.equal(requests[0].command.email,'ana@example.test');await page.getByRole('button',{name:'📱 Enviar por WhatsApp',exact:true}).click();await page.getByText('Borrador de WhatsApp abierto.',{exact:false}).waitFor();
 await page.getByLabel('Rol de Ana QA').selectOption('admin');await page.getByText('Cambio confirmado por el servidor.',{exact:true}).waitFor();assert.equal(members.find(m=>m.name==='Ana QA').role,'admin');
 await page.getByRole('button',{name:'Quitar',exact:true}).last().click();await page.getByRole('dialog',{name:'Desactivar usuario'}).getByRole('button',{name:'Desactivar',exact:true}).click();await page.getByRole('button',{name:'Activar',exact:true}).click();assert.equal(members.find(m=>m.name==='Ana QA').active,true);assert.equal(await page.getByLabel('Rol de Administrador · FIXTURE').isDisabled(),true);
 await page.screenshot({path:fileURLToPath(new URL('../../docs/native/evidence/native-team-original.png',import.meta.url))});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 webOrigin=null;await page.getByRole('button',{name:'Actualizar equipo',exact:true}).click();assert.equal(await page.getByRole('button',{name:'+ Agregar',exact:true}).isDisabled(),true);
 await page.setViewportSize({width:1440,height:980});role='cashier';calls.length=0;await page.reload();await page.waitForURL('**/#/');await page.getByText('Cajero',{exact:true}).waitFor();assert.equal(await page.getByRole('navigation',{name:'Navegación principal'}).getByRole('link').count(),1);assert.equal(calls.filter(c=>c.action==='TEAM_READ').length,0);assert.deepEqual(errors,[]);
 }finally{await browser.close()}
});
