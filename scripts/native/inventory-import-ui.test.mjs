// Explicit native IPC fixture; validates real XLSX/CSV parsing and definitive UI.
// Atomicity, authorization, encrypted persistence and money are proven in Rust.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';import * as XLSX from 'xlsx';
const root=new URL('../../apps/pos/dist/',import.meta.url),id=n=>'96000000-0000-4000-8000-'+String(n).padStart(12,'0');
test('Importación original Excel/CSV: mapeo, vista previa, replay, reinicio y filas explícitas',{timeout:60000},async()=>{
 const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname,file=new URL(path==='/'?'index.html':'.'+path,root);if(!file.href.startsWith(root.href))throw Error('PATH');res.setHeader('Content-Type',path==='/'?'text/html':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream');res.end(await readFile(file))}catch{res.writeHead(404).end()}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],remote=[],unexpected=[],preparations=[],executions=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!/^(http:\/\/127\.0\.0\.1:|data:|blob:)/.test(r.url()))remote.push(r.url())});
  const products=[],plans=[];let losePrepare=true,loseCommit=true,commits=0,canManage=true;
  const snapshot=()=>({status:'ready',mode:'staging-operational',inventoryReadOnly:!canManage,supportsDrafts:false,scopeRevision:String(commits),products,customers:[],confirmedSales:'0',cashCents:'0',pendingOperations:String(commits*2),carts:{active:null,paused:[]},lastResult:null,pendingAttempt:null});
  await page.exposeFunction('__importInvoke',async(command,args)=>{
   assert.equal(args.ipcVersion,'ventard.native.access.1');
   if(command==='native_access_status')return{status:'PREPARATION_REQUIRED',configured:true,actorId:id(2),tenantId:id(1),role:canManage?'owner':'seller',pinEnrolled:true,operationalReady:true,catalogueReady:true,tenants:[]};
   if(command==='native_cash_read')return{scope:'BRANCH',branchId:id(5),turn:null,canOpen:false};
   if(command==='native_sales'){
    const c=args.command;if(['READ','SYNCHRONIZE'].includes(c.action))return snapshot();if(c.action==='QUOTE')return{subtotalCents:null,itbisCents:null,totalCents:null,changeCents:null,payable:false,lineTotals:[]};
    if(c.action==='MANAGEMENT_READ')return{canManage,planTier:'basico',customers:[],movements:[],pending:[],turn:null,coverage:'EXPLICIT_IPC_FIXTURE'};
    if(c.action==='IMPORT_LIST')return{rows:plans};
    if(c.action==='IMPORT_PREPARE'){
     preparations.push(structuredClone(c.batch));assert.equal(c.batch.rows[0].code,'000000000000001');assert.equal(c.batch.rows[0].stock,'7');assert.equal(c.batch.rows[0].price,'1500.01');assert.equal(c.batch.rows[0].minimum,'2');assert.equal(c.batch.duplicatePolicy,'SKIP');
     if(!plans.length){const definition={name:'Importado QA · FIXTURE',code:c.batch.rows[0].code,priceCents:'150001',tier2Cents:null,tier3Cents:null,costCents:'100000',taxPercent:'18',productType:'simple',location:'Pasillo QA',minimum:'2',serialRequired:false,recipe:[]};plans.push({operationId:c.batch.operationId,fileName:c.batch.fileName,state:'PREPARED',ready:'1',remaining:'1',created:'0',updated:'0',invalid:'1',skipped:'1',rows:[{row:2,name:definition.name,state:'READY',error:null,created:true,definition,stock:'7'},{row:3,name:'Inválido',state:'INVALID',error:'IMPORT_INVALID_NUMBER',created:false,definition:null,stock:null},{row:4,name:definition.name,state:'SKIPPED',error:'IMPORT_DUPLICATE_IN_FILE',created:false,definition:null,stock:null}]})}
     if(losePrepare){losePrepare=false;throw{code:'IPC_RESPONSE_LOST'}}return structuredClone(plans[0]);
    }
    if(c.action==='IMPORT_RUN'){executions.push(c.operationId);assert.equal(c.operationId,plans[0].operationId);if(!commits){commits++;plans[0].state='FINISHED';plans[0].ready='0';plans[0].remaining='0';plans[0].created='1';plans[0].rows[0].state='DONE';products.push({id:id(700),name:plans[0].rows[0].name,code:plans[0].rows[0].definition.code,priceCents:'150001',costCents:'100000',stock:'7',minimum:'2',kind:'simple',revision:'1',serialRequired:false})}if(loseCommit){loseCommit=false;throw{code:'IPC_RESPONSE_LOST'}}return structuredClone(plans[0])}
   }
   unexpected.push(command+':'+args.command?.action);throw{code:'FIXTURE_UNKNOWN_COMMAND'};
  });
  await page.addInitScript(()=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__importInvoke(command,args)}});
  const url='http://127.0.0.1:'+server.address().port;await page.goto(url+'/#/inventario');await page.getByRole('button',{name:'Importar',exact:true}).click();
  await page.getByRole('heading',{name:'Importar Inventario',exact:true}).waitFor();
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Descargar plantilla de ejemplo',exact:false}).click();const download=await downloadPromise;const template=XLSX.read(await readFile(await download.path()));assert.equal(template.SheetNames[0],'Inventario');
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Nombre','Precio Venta','Costo','Stock','Stock Minimo','Codigo de Barras','Ubicacion'],['Importado QA · FIXTURE','1500.01','1000.00','7','2','000000000000001','Pasillo QA'],['Inválido','1.234','','-2','','',''],['Importado QA · FIXTURE','9','','','','000000000000001','']]),'Inventario');
  await page.getByLabel('Archivo de inventario').setInputFiles({name:'inventario-qa.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'})});
  await page.getByRole('button',{name:'Revisar productos antes de importar',exact:true}).click();await page.getByRole('button',{name:'Recuperar la misma revisión',exact:true}).click();await page.getByRole('heading',{name:'Vista previa verificada',exact:true}).waitFor();
  assert.equal(preparations.length,2);assert.deepEqual(preparations[0],preparations[1]);
  await page.getByRole('button',{name:'Importar 1 producto',exact:true}).waitFor();await page.screenshot({path:fileURLToPath(new URL('../../docs/native/evidence/native-inventory-import-original.png',import.meta.url)),fullPage:true});
  await page.getByRole('button',{name:'Importar 1 producto',exact:true}).click();await page.getByRole('alert').waitFor();await page.getByRole('button',{name:'Importar 1 producto',exact:true}).click();
  await page.getByRole('heading',{name:'Importación finalizada',exact:true}).waitFor();assert.equal(commits,1);assert.equal(executions.length,2);assert.equal(new Set(executions).size,1);await page.reload();await page.getByRole('heading',{name:'Importación finalizada',exact:true}).waitFor();
  await page.getByRole('button',{name:'Importar otro archivo',exact:true}).click();
  const formula=XLSX.utils.aoa_to_sheet([['Nombre','Precio'],['Fórmula',1]]);formula.B2.f='1+1';const formulaBook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(formulaBook,formula,'Inventario');await page.getByLabel('Archivo de inventario').setInputFiles({name:'formula.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(formulaBook,{type:'buffer',bookType:'xlsx'})});await page.getByText('El archivo contiene fórmulas.',{exact:false}).waitFor();assert.equal(preparations.length,2);
  await page.getByLabel('Archivo de inventario').setInputFiles({name:'inventario.csv',mimeType:'text/csv',buffer:Buffer.from('Nombre,Precio Venta,Costo,Stock,Stock Minimo,Codigo de Barras,Ubicacion\nImportado QA · FIXTURE,1500.01,1000.00,7,2,000000000000001,Pasillo QA\n')});await page.getByRole('button',{name:'Revisar productos antes de importar',exact:true}).waitFor();assert.equal(await page.getByLabel('Código de barras',{exact:true}).inputValue(),'5');
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)}
  canManage=false;await page.goto(url+'/#/inventario');assert.equal(await page.getByRole('button',{name:'Importar',exact:true}).isDisabled(),true);
  assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);
 }finally{await browser?.close();await new Promise(r=>server.close(r))}
});
