// Synthetic isolated PostgreSQL helpers only. No test registration, remote credentials or network.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {inventorySetup,managementCommand,submitManagement,openTurn,context,rpc,hash,canon,id,product,tenant,actor,installation,device,branch} from './sales-fixtures.mjs';

const proGrant=id(99),repairId=id(700),folio=`REP-N${installation.replaceAll('-','')}-001`;

async function admin(db,sql,args=[]){await db.exec('reset role');try{return(await db.query(sql,args)).rows;}finally{await db.exec('set role authenticated');}}

async function adminExec(db,sql){await db.exec('reset role');try{await db.exec(sql);}finally{await db.exec('set role authenticated');}}

async function setup(pro=true){const db=await inventorySetup();await db.exec('reset role');for(const name of ['20261012123311_native_returns_staging_v1.sql','20261012150846_native_service_plan_staging_v1.sql','20261012153049_native_repairs_staging_v1.sql']){const sql=await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);}if(pro)await db.query("update native_staging_licenses_v1 set plan_tier='pro' where negocio_id=$1",[tenant]);await db.exec('set role authenticated');await rpc(db,'native_registrar_instalacion_v1',[proGrant,tenant,installation,device,'BRANCH',branch]);return db;}

function definition(){return {customerId:null,customerName:'Ana QA',phone:'8095550100',brand:'Samsung',model:'A14',imei:'IMEI-QA',color:'Negro',conditionChecks:['Enciende'],conditionNotes:'Rayón',accessories:'Funda',problem:'Pantalla',diagnosis:'Cambio pantalla',notes:'QA\nsegunda línea',technician:'Luis',labourCents:'200',partsChargeSeparate:true,parts:[{productId:product,name:'Pantalla QA',quantity:'2',costCents:'60',priceCents:'100'}]};}

function base(op,previous=null){const request={kind:'REPAIR_SAVE',operationId:id(op),repairId,expectedRevision:previous?.revision??'0',quote:false,definition:definition(),initialPaymentCents:previous?'0':'100',method:'EFECTIVO',turnId:id(90)};
 const repair=previous?structuredClone(previous):{id:repairId,revision:'0',folio,folioNumber:'1',state:'recibido',definition:{},totalCents:'0',paidCents:'0',payments:[],log:[{state:'recibido',dateMs:'1791712800000',actorId:actor}],createdAtMs:'1791712800000',updatedAtMs:'1791712800000',deliveredAtMs:null,warrantyDays:'0',warrantyUntilMs:null};
 repair.revision=String(BigInt(request.expectedRevision)+1n);repair.definition=definition();repair.totalCents='400';return {request,repair};}

function envelope(op,request,repair,stock=[],amount='0',type='abono'){
 const payment=amount==='0'?null:{operationId:id(op),amountCents:amount,method:request.method,turnId:request.turnId,dateMs:'1791712800000',type};
 if(payment){repair.payments.push(payment);repair.paidCents=String(BigInt(repair.paidCents)+BigInt(amount));}
 const doc={operationId:id(op),repair,stock,payment,amountCents:amount,method:payment?request.method:null,concept:`Reparación ${repair.folio}`,business:null};if(payment&&request.turnId)doc.cashDeltaCents=request.method==='EFECTIVO'?amount:'0';
 const v=managementCommand(op,request.expectedRevision==='0'?'REPAIR_CREATE':'REPAIR_EDIT',request,doc,payment?.turnId??null);v.permissionGrantId=proGrant;return v;
}

async function stock(db,delta){const [row]=await admin(db,'select s.revision,inv.stock_actual from native_sales_stock_v1 s join inventario_sucursales inv on inv.producto_id=s.producto_id and inv.sucursal_id=s.sucursal_id where s.negocio_id=$1 and s.producto_id=$2',[tenant,product]);const proof={productId:product,remoteBaseQty:String(row.stock_actual),remoteSequence:String(row.revision),pending:[],effectiveQty:String(row.stock_actual)};return [{productId:product,delta:String(delta),before:proof.effectiveQty,after:String(BigInt(proof.effectiveQty)+BigInt(delta)),expectedRevision:hash({quantity:proof.effectiveQty,remoteSequence:proof.remoteSequence,pending:[]}),stockEvidence:proof}];}

function action(op,previous,action,amount='0',method='EFECTIVO',business=null){
 const request={kind:'REPAIR_ACTION',repairId,expectedRevision:previous.revision,action,amountCents:amount,method,turnId:id(90),warrantyDays:'30'},r=structuredClone(previous);r.revision=String(BigInt(r.revision)+1n);r.updatedAtMs='1791712800000';
 const next={DIAGNOSE:'diagnostico',APPROVE:'en_reparacion',READY:'listo',DELIVER:'entregado',CANCEL:'cancelado',REJECT:'no_reparado',ABANDON:'abandonado'}[action]??r.state;if(next!==r.state)r.log.push({state:next,dateMs:'1791712800000',actorId:actor});r.state=next;
 if(action==='DELIVER'){r.deliveredAtMs='1791712800000';r.warrantyDays='30';r.warrantyUntilMs='1794304800000';amount=String(BigInt(r.totalCents)-BigInt(r.paidCents));}if(['ABANDON','REJECT'].includes(action)){r.definition.labourCents='0';r.totalCents=amount;r.settlementPendingCents=r.paidCents;}const command=envelope(op,request,r,[],amount,action==='DELIVER'?'final':['ABANDON','REJECT'].includes(action)?'revision':'abono');command.payload.document.business=structuredClone(business);return command;
}
export {proGrant,repairId,folio,admin,adminExec,setup,definition,base,envelope,stock,action,setup as repairSetup};
