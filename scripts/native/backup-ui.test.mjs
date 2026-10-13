// Definitive VentaRD pages with explicit IPC fixtures. SQLCipher, Windows keys
// and native authorization are tested separately in Rust, not simulated here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {routeDistFixture} from './route-dist-fixture.mjs';
const root=new URL('../../apps/pos/dist/',import.meta.url);
const id=n=>'96000000-0000-4000-8000-'+String(n).padStart(12,'0');
test('Respaldo en Ajustes: replay, archivo rechazado y consulta histórica sin comandos de cuenta activa',{timeout:60000},async()=>{
 const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname,file=new URL(path==='/'?'index.html':'.'+path,root);if(!file.href.startsWith(root.href))throw Error('PATH');res.setHeader('Content-Type',path==='/'?'text/html':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream');res.end(await readFile(file))}catch{res.writeHead(404).end()}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],remote=[],unexpected=[],calls=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!/^(http:\/\/127\.0\.0\.1:|data:|blob:)/.test(r.url()))remote.push(r.url())});
  let archive=false,lose=true,invalid=true;const rows=[],created=[];
  const definition={name:'NEGOCIO RECUPERADO · FIXTURE',rnc:'',phone:'',address:'',whatsapp:'',footer:'Gracias',logo:null,color:'dorado',font:'syne',bank:null},layout={paperWidth:'80mm',fontSize:'normal',density:'normal',copies:1,showLogo:true,autoPrint:false};
  const summary={backupId:id(881),state:'VERIFIED',capturedAtMs:'1791842400000',databaseBytes:'65536',counts:{sales:'1',operation_journal:'2'},handle:id(882)};
  const snapshot=()=>({status:'ready',mode:archive?'recovery-readonly':'staging-operational',backupCapturedAtMs:archive?summary.capturedAtMs:undefined,business:definition,scopeRevision:'fixture-1',inventoryReadOnly:archive,supportsDrafts:false,products:[{id:id(700),name:'Artículo guardado · FIXTURE',code:'QA',priceCents:'10000',stock:'7',revision:'1',kind:'venta',serialRequired:false}],customers:[],confirmedSales:'1',cashCents:'11800',pendingOperations:'1',carts:{active:null,paused:[]},lastResult:null,pendingAttempt:null});
  const management=()=>({canManage:!archive,planTier:'basico',customers:[],movements:[],pending:[],turn:null,coverage:'EXPLICIT_IPC_FIXTURE'});
  const ticket={version:'ventard.ticket.snapshot.1',operationId:id(92),ticket:'NQA-BACKUP-1',ncf:null,originAtUtcMs:summary.capturedAtMs,customerName:null,printSnapshotHash:'1'.repeat(64),business:definition,printLayout:layout,sale:{lines:[{name:'Artículo guardado · FIXTURE',quantity:{numerator:'1',denominator:'1'},unitPriceCents:'10000',serial:null}],totals:{subtotalCents:'10000',itbisCents:'1800',discountCents:'0',totalCents:'11800'},payment:{method:'EFECTIVO',paidCents:'11800',tenderCents:'12000',changeCents:'200',creditChargeCents:'0'}}};
  await page.exposeFunction('__backupInvoke',async(command,args)=>{
   calls.push({command,args,archive});assert.equal(args.ipcVersion,'ventard.native.access.1');
   if(command==='native_access_status')return{status:archive?'RECOVERY_ARCHIVE':'PREPARATION_REQUIRED',configured:true,actorId:id(2),tenantId:id(1),role:archive?null:'owner',pinEnrolled:true,operationalReady:!archive,catalogueReady:true,tenants:[]};
   const c=args.command;
   if(command==='native_backup'){
    if(c.action==='WEB_STATUS')return{rows:[]};
    if(c.action==='STATUS')return{rows,canCreate:!archive,archive:archive?summary:undefined};
    if(c.action==='CREATE'){created.push(c.operationId);if(!rows.length)rows.push({...summary,backupId:c.operationId,handle:undefined});if(lose){lose=false;throw{code:'IPC_RESPONSE_LOST'}}return rows[0]}
    if(c.action==='INSPECT'){if(invalid){invalid=false;throw{code:'BACKUP_INVALID'}}return summary}
    if(c.action==='OPEN'){assert.equal(c.handle,summary.handle);archive=true;return{state:'OPEN'}}
    if(c.action==='CLOSE'){archive=false;return{state:'CLOSED'}}
    if(c.action==='HISTORY_READ')return{rows:[{operationId:id(92),ticket:ticket.ticket,dateMs:summary.capturedAtMs,method:'EFECTIVO',totalCents:'11800',itbisCents:'1800',discountCents:'0',ncf:null,customerName:null,ticketEvidence:'VERIFIED_SNAPSHOT',remoteStatus:'PENDING'}],total:'1',page:1,pageSize:10,scope:'BRANCH',branchId:id(5),coverage:'RECOVERED_ARCHIVE'};
    if(c.action==='TICKET')return ticket;
   }
   if(archive&&command!=='native_backup'){unexpected.push(command);throw{code:'ARCHIVE_LIVE_COMMAND'}}
   if(command==='native_cash_read')return{scope:'BRANCH',branchId:id(5),turn:null,canOpen:false};
   if(command==='native_sales'||command==='native_backup'){
    if(['READ','SYNCHRONIZE'].includes(c.action))return snapshot();
    if(c.action==='QUOTE')return{subtotalCents:null,itbisCents:null,totalCents:null,changeCents:null,payable:false,lineTotals:[]};
    if(c.action==='PRINTER_READ')return{profile:{mode:'DIALOG',connection:'USB',queue:null,host:null,dots:576,cut:true,drawer:false},queues:[],canWrite:false};if(c.action==='FISCAL_SETTINGS_READ')return{configuration:null,capturedAtMs:null,pending:null,lastStatus:null,canWrite:false,remoteError:'FISCAL_SETTINGS_MIGRATION_REQUIRED'};if(c.action==='MANAGEMENT_READ')return management();
    if(c.action==='SETTINGS_READ')return{supported:true,revision:'1',definition,canWrite:!archive,canLoadRemote:false,coverage:'EXPLICIT_IPC_FIXTURE'};
    if(c.action==='PRINT_LAYOUT_READ')return{layout,canWrite:!archive,coverage:'EXPLICIT_IPC_FIXTURE'};
   }
   unexpected.push(command+':'+c?.action);throw{code:'FIXTURE_UNKNOWN_COMMAND'};
  });
  await page.addInitScript(()=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__backupInvoke(command,args)}});
  const url='http://127.0.0.1:'+server.address().port;
  await routeDistFixture(page,url,root);
  await page.goto(url+'/#/configuracion');
  await page.getByRole('button',{name:'Crear respaldo cifrado',exact:true}).click();
  await page.getByRole('button',{name:'Recuperar el mismo respaldo',exact:true}).click();
  await page.getByText('Respaldo cifrado y llave guardados.',{exact:false}).waitFor();
  assert.equal(created.length,2);assert.equal(new Set(created).size,1);
  await page.getByRole('button',{name:'Abrir y verificar respaldo',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(archive,false);
  await page.getByRole('button',{name:'Abrir y verificar respaldo',exact:true}).click();await page.getByText('Copia verificada',{exact:true}).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Consultar datos recuperados'&&!b.disabled));
  await page.screenshot({path:fileURLToPath(new URL('../../docs/native/evidence/native-backup-settings.png',import.meta.url)),fullPage:true});
  await page.getByRole('button',{name:'Consultar datos recuperados',exact:true}).click();
  await page.getByRole('button',{name:'Ver ticket NQA-BACKUP-1',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Devolver ticket NQA-BACKUP-1'}).isDisabled(),true);
  await page.getByRole('button',{name:'Ver ticket NQA-BACKUP-1',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Imprimir ticket',exact:true}).isDisabled(),true);
  await page.screenshot({path:fileURLToPath(new URL('../../docs/native/evidence/native-backup-original-ticket.png',import.meta.url)),fullPage:true});
  await page.getByRole('button',{name:'Cerrar ticket',exact:true}).click();
  await page.goto(url+'/#/configuracion');await page.getByRole('button',{name:'Volver a mi cuenta',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Crear respaldo cifrado',exact:true}).isDisabled(),true);
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)}
  await page.getByRole('button',{name:'Volver a mi cuenta',exact:true}).click();await page.waitForFunction(()=>location.hash==='#/');
  assert.equal(archive,false);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);
  assert.ok(calls.some(c=>c.archive&&c.command==='native_backup'&&c.args.command.action==='TICKET'));
 }finally{await browser?.close();await new Promise(r=>server.close(r))}
});
