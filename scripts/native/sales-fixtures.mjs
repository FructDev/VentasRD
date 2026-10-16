// Synthetic isolated PostgreSQL helpers only. No test registration, remote credentials or network.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {readdir} from 'node:fs/promises';

const id=n=>`96200000-0000-4000-8000-${String(n).padStart(12,'0')}`,tenant='96000000-0000-4000-8000-000000000001',other='96000000-0000-4000-8000-000000000002';

const importWire=process.env.VENTARD_IMPORT_WIRE_FIXTURE?JSON.parse(await readFile(process.env.VENTARD_IMPORT_WIRE_FIXTURE,'utf8')):null;

const importIdentity=importWire?.length?JSON.parse(importWire[0].bytes):null;

const actor=importIdentity?.actorId??id(1),device=importIdentity?.originDeviceId??id(2),installation=importIdentity?.installationId??id(3),branch=importIdentity?.scope.sucursalId??id(4),product=id(20),customer=id(30),grant=importIdentity?.permissionGrantId??id(9);

const canon=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canon).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';

const hash=v=>createHash('sha256').update(typeof v==='string'?v:canon(v)).digest('hex');

async function setup(){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create table negocios(id uuid primary key,nombre text,"dueño_id" uuid);create table sucursales(id uuid primary key,negocio_id uuid,nombre text);create table usuarios_negocio(id uuid primary key,negocio_id uuid,user_id uuid,rol text,activo boolean);
create table productos(id uuid primary key,negocio_id uuid,nombre text,codigo_barras text,precio_venta numeric,costo numeric,stock_actual integer,tasa_itbis numeric,tipo text,serializable boolean,eliminado boolean,precio_2 numeric,precio_3 numeric);
create table inventario_sucursales(sucursal_id uuid,producto_id uuid,stock_actual integer,primary key(sucursal_id,producto_id));create table composiciones(id uuid,negocio_id uuid,producto_padre_id uuid,insumo_id uuid,cantidad_necesaria numeric);
create table clientes(id uuid primary key,negocio_id uuid,nombre text,limite_credito numeric,eliminado boolean,tipo_precio integer,fecha_actualizacion bigint not null);create table transacciones_fiado(id uuid,negocio_id uuid,cliente_id uuid,tipo text,monto numeric);
create table seriales(id uuid primary key,negocio_id uuid,producto_id uuid,numero_serial text,estado text constraint seriales_estado_check check (estado in ('disponible','vendido')),venta_id uuid,fecha_venta bigint,fecha_actualizacion bigint);
create table ncf_secuencias(negocio_id uuid primary key,tipo text,desde bigint,hasta bigint,proximo bigint,habilitado boolean);
insert into auth.users values('${actor}'),('${id(7)}'),('${id(8)}');insert into negocios values('${tenant}','PRO00 QA A - SINTETICO','${actor}'),('${other}','PRO00 QA B - SINTETICO','${id(8)}');insert into sucursales values('${branch}','${tenant}','QA');insert into usuarios_negocio values('${id(70)}','${tenant}','${id(7)}','vendedor',true);
insert into productos values('${product}','${tenant}','Producto sintético','0001',100,60,100,.18,'simple',false,false,90,80);insert into inventario_sucursales values('${branch}','${product}',100);insert into clientes values('${customer}','${tenant}','Cliente sintético',5000,false,1,1791712800000);
insert into ncf_secuencias values('${tenant}','B02',1,1000,1,true);
grant usage on schema public,auth to authenticated;grant execute on function auth.uid() to authenticated;grant select,insert,update,delete on productos,inventario_sucursales,clientes,seriales,composiciones,transacciones_fiado to authenticated;`);
await db.exec(await readFile(new URL('../../supabase/migrations/20261009180752_native_provision_v1.sql',import.meta.url),'utf8'));await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);await db.query("select native_registrar_instalacion_v1($1,$2,$3,$4,'BRANCH',$5)",[grant,tenant,installation,device,branch]);await db.exec(await readFile(new URL('../../supabase/migrations/20261010134537_native_fiscal_allocation_v2.sql',import.meta.url),'utf8'));
if(process.env.VENTARD_SALES_RED!=='1'){const m=await readFile(new URL('../../supabase/migrations/20261011111415_native_sales_staging_v1.sql',import.meta.url),'utf8');await db.exec(m);await db.exec(m);if(process.env.VENTARD_SCHEMA_COMPAT_RED!=='1'){const compat=await readFile(new URL('../../supabase/migrations/20261011135055_native_sales_real_schema_compat_v1.sql',import.meta.url),'utf8');await db.exec(compat);await db.exec(compat);if(process.env.VENTARD_TURN_CONTEXT_RED!=='1'){const turn=await readFile(new URL('../../supabase/migrations/20261011192935_native_sales_turn_context_v1.sql',import.meta.url),'utf8');await db.exec(turn);await db.exec(turn);}}}await db.exec('set role authenticated');return db;}

async function rpc(db,name,args){return(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args)).rows[0].value;}

const context=[tenant,installation,device,'1','BRANCH',branch];

async function managementSetup(){const db=await setup();await db.exec('reset role');const name=(await readdir(new URL('../../supabase/migrations/',import.meta.url))).find(n=>n.endsWith('_native_management_staging_v1.sql'));const sql=await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);await db.exec('set role authenticated');await activate(db);return db;}

function managementCommand(n,kind,request,document,turnId=null){const v=command(n).intent;Object.assign(v,{kind,originalTurnId:turnId,expectedVersions:{},payload:{request:{...request,operationId:id(n)},document}});return v;}

const submitManagement=(db,v)=>rpc(db,'native_sales_submit_v1',[canon(v),hash(v),null,null]);

async function inventorySetup(){const db=await managementSetup();await db.exec('reset role');await db.exec('alter table productos add column stock_minimo integer default 0,add column ubicacion text,add column fecha_actualizacion bigint default 0;alter table inventario_sucursales add column stock_minimo integer default 0,add column fecha_actualizacion bigint default 0;');const sql=await readFile(new URL('../../supabase/migrations/20261012031553_native_inventory_staging_v1.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);await db.exec('set role authenticated');return db;}

function inventoryDefinition(){return{name:'Café QA',code:'CAFE',priceCents:'12345',tier2Cents:'10000',tier3Cents:null,costCents:'6000',taxPercent:'18',productType:'simple',location:'A-2',minimum:'3',serialRequired:false,recipe:[]};}

function productCommand(op,revision='0'){const d=inventoryDefinition();return managementCommand(op,revision==='0'?'PRODUCT_CREATE':'PRODUCT_PATCH',{kind:'PRODUCT_SAVE',productId:id(300),expectedRevision:revision,definition:d},{product:{id:id(300),name:d.name,code:d.code,revision:String(Number(revision)+1),deleted:false,priceTiers:{retailCents:d.priceCents,tier2Cents:d.tier2Cents,tier3Cents:d.tier3Cents},metadata:{costCents:d.costCents,taxRate:{numerator:'9',denominator:'50'},serialRequired:false,recipe:[],productType:'simple',recipeCostPolicy:'DECLARED',location:d.location,minimum:d.minimum}}});}

function stockCommand(op,{pid=id(300),before='0',base='0',sequence='0',pending=[],mode='IN',quantity='7',productRevision='1',serials=[]}={}){const proof={productId:pid,remoteBaseQty:base,remoteSequence:sequence,pending,effectiveQty:before},delta=mode==='COUNT'?BigInt(quantity)-BigInt(before):mode==='LOSS'?-BigInt(quantity):BigInt(quantity);return managementCommand(op,mode==='COUNT'?'INVENTORY_COUNT':'INVENTORY_DELTA',{kind:'INVENTORY_CHANGE',productId:pid,expectedStockRevision:hash({quantity:before,remoteSequence:sequence,pending}),mode,quantity,reason:'Conteo QA',serials},{productId:pid,productRevision,delta:String(delta),before,after:String(BigInt(before)+delta),mode,reason:'Conteo QA',serials,stockEvidence:proof});}

const activate=db=>rpc(db,'native_sales_activate_v1',[...context,'QA_SYNTHETIC_QUIESCED','0.18']);

async function admin(db,sql){await db.exec('reset role');try{if(sql.includes(';')){await db.exec(sql);return [];}return(await db.query(sql)).rows;}finally{await db.exec('set role authenticated');}}

function command(n,changes={}){
 const payment={method:'TARJETA',customerId:null,paidCents:'11800',creditChargeCents:'0',cashNetCents:'0',cardCents:'11800',transferCents:'0',tenderCents:'0',changeCents:'0',turnId:null,bankSettlementVerified:false};
 const stockEvidence=[{productId:product,remoteBaseQty:'100',remoteSequence:'0',pending:[],effectiveQty:'100'}];
 const sale={calculationVersion:'ventard.sale.calculation.1',currency:'DOP',lines:[{productId:product,productRevision:'1',name:'Producto sintético',unitPriceCents:'10000',quantity:{numerator:'1',denominator:'1'},taxRate:{numerator:'9',denominator:'50'},costCents:'6000',serial:null,recipe:[]}],discount:{type:'AMOUNT',amountCents:'0'},totals:{subtotalCents:'10000',itbisCents:'1800',discountCents:'0',totalCents:'11800'},payment,inventory:[{productId:product,delta:'-1',expectedRevision:hash({quantity:'100',remoteSequence:'0',pending:[]})}],serials:[],stockEvidence,fiscal:null,...changes};
 const intent={protocol:'ventard.native.v1',kind:'SALE_CONFIRM',contractVersion:1,canonicalizationVersion:'C-N1',operationId:id(n),negocioId:tenant,scope:{type:'BRANCH',sucursalId:branch},originDeviceId:device,installationId:installation,writerEpoch:'1',actorId:actor,permissionGrantId:grant,originalTurnId:sale.payment.turnId,originAtUtcMs:'1791712800000',expectedVersions:{cart:'1'},dependencies:[],payload:{cartId:id(80+n),cartRevision:'1',quoteHash:hash({...sale,fiscal:null}),sale,request:{}}};
 const snapshot={version:'ventard.ticket.snapshot.1',operationId:id(n),tenantId:tenant,scope:{type:'BRANCH',branchId:branch},ticket:'N'+installation.replaceAll('-','')+'-'+String(n).padStart(6,'0'),ncf:null,actorId:actor,originAtUtcMs:intent.originAtUtcMs,customerName:null,sale};
 return {intent,snapshot};}

const submit=(db,c)=>rpc(db,'native_sales_submit_v1',[canon(c.intent),hash(c.intent),canon(c.snapshot),hash(c.snapshot)]);

async function openTurn(db){const v=command(90).intent;v.kind='TURN_OPEN';v.payload={openingCents:'50000'};v.expectedVersions={drawer:'0'};return rpc(db,'native_sales_submit_v1',[canon(v),hash(v),null,null]);}
export {id,tenant,other,importWire,importIdentity,actor,device,installation,branch,product,customer,grant,canon,hash,setup,rpc,context,managementSetup,managementCommand,submitManagement,inventorySetup,inventoryDefinition,productCommand,stockCommand,activate,admin,command,submit,openTurn};
