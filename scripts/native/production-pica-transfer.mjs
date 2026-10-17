// Explicitly authorized one-branch TEST Pica repair. Never authenticates as an
// application user and never activates the business or creates financial ops.
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {resolve} from 'node:path';import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {cliQuery,decryptRecovery,encryptRecovery,recoveryScope,verifyPublicRestore,tenantId,projectRef} from './production-recovery.mjs';
const root=resolve(import.meta.dirname,'../..'),directory=resolve(root,'scratch/production-signing/recovery');
const tables=['apartados','cajas','clientes','composiciones','cortes_caja','detalles_ventas','devoluciones','gastos','inventario_operaciones_v2','inventario_secuencias_v2','inventario_sucursales','movimientos_stock','negocios','pagos_log','productos','reparaciones','seriales','sucursales','transacciones_fiado','usuarios_negocio','venta_detalles','ventas'];
const literal=v=>"'"+v.replaceAll("'","''")+"'",identifier=v=>'"'+v.replaceAll('"','""')+'"';
const sha=v=>createHash('sha256').update(v).digest('hex');
async function capture(){
 const names=tables.map(literal).join(',');
 const meta=await cliQuery(`begin read only;select c.relname as "table",a.attname as name,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as "notNull" from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where n.nspname='public' and c.relkind='r' and c.relname in(${names}) order by c.relname,a.attnum;rollback;`);
 if(new Set(meta.map(c=>c.table)).size!==tables.length)throw Error('PICA_BACKUP_SCHEMA_CHANGED');
 const union=tables.map(name=>{const predicate=recoveryScope(name,meta.filter(c=>c.table===name).map(c=>c.name));if(!predicate)throw Error('PICA_BACKUP_SCOPE');return `select ${literal(name)} as name,count(*)::integer as count,coalesce(jsonb_agg(row_to_json(t)::text order by row_to_json(t)::text),'[]'::jsonb) as rows from public.${identifier(name)} t where ${predicate}`}).join(' union all ');
 const result=await cliQuery(`begin isolation level repeatable read read only;set local timezone='UTC';select jsonb_build_object('protocol','ventard.pica.transfer.snapshot.1','projectRef','${projectRef}','tenantId','${tenantId}','takenAt',transaction_timestamp(),'tables',(select jsonb_agg(to_jsonb(t) order by name) from(${union}) t)) as snapshot;rollback;`);
 const snapshot=result[0]?.snapshot;if(snapshot?.tenantId!==tenantId||snapshot.tables?.length!==tables.length)throw Error('PICA_BACKUP_INVALID');
 snapshot.columns=meta;for(const t of snapshot.tables)t.sourceSha256=sha(Buffer.from(t.rows.join('\n')));
 return snapshot;
}
async function save(snapshot,label,key){
 const path=resolve(directory,`pica-transfer-${label}-${Date.now()}.vrrecovery`),bytes=Buffer.from(JSON.stringify(snapshot));
 await writeFile(path,JSON.stringify(encryptRecovery(bytes,key,'DATABASE')),{flag:'wx'});
 const clear=decryptRecovery(JSON.parse(await readFile(path,'utf8')),key,'DATABASE');if(!clear.equals(bytes))throw Error('PICA_BACKUP_ROUNDTRIP');clear.fill(0);bytes.fill(0);
 const restore=await verifyPublicRestore(snapshot);return {path,sha256:sha(await readFile(path)),restore};
}
function sourceGuard(snapshot){return 'do $source$ begin\n'+snapshot.tables.map(t=>{
 const predicate=recoveryScope(t.name,snapshot.columns.filter(c=>c.table===t.name).map(c=>c.name));
 return `if (select encode(sha256(convert_to(coalesce(string_agg(row_to_json(t)::text,E'\\n' order by row_to_json(t)::text),''),'UTF8')),'hex') from public.${identifier(t.name)} t where ${predicate})<>${literal(t.sourceSha256)} then raise exception 'PICA_TRANSFER_SOURCE_CHANGED';end if;`;
 }).join('\n')+'\nend $source$;';}
async function rehearse(snapshot,sql){
 const pg=new PGlite();try{
  for(const table of snapshot.tables){
   const cols=snapshot.columns.filter(c=>c.table===table.name);
   await pg.exec('create table public.'+identifier(table.name)+'('+cols.map(c=>identifier(c.name)+' '+c.type+(c.notNull?' not null':'')).join(',')+')');
   for(let i=0;i<table.rows.length;i+=100)await pg.query('insert into public.'+identifier(table.name)+' select * from jsonb_populate_recordset(null::public.'+identifier(table.name)+',$1::jsonb)',['['+table.rows.slice(i,i+100).join(',')+']']);
  }
  await pg.exec('alter table inventario_sucursales add unique(sucursal_id,producto_id);create table native_sales_mode_v1(negocio_id uuid);create table native_sales_ledger_v1(negocio_id uuid);set timezone=\'UTC\';');
  await pg.exec(sql);
  const facts=(await pg.query(`select (select count(*) from ventas) sales,(select count(*) from venta_detalles) details,(select count(*) from transacciones_fiado) credit,(select count(*) from cajas where estado='abierta') open_cash,(select count(*) from inventario_sucursales) branch_stock`)).rows[0];
  if(facts.sales!==snapshot.tables.find(t=>t.name==='ventas').count||facts.details!==snapshot.tables.find(t=>t.name==='venta_detalles').count||facts.credit!==snapshot.tables.find(t=>t.name==='transacciones_fiado').count||facts.open_cash!==0)throw Error('PICA_REHEARSAL_INVARIANT');
  return {engine:'ISOLATED_POSTGRESQL_RAM',...facts,privateRowsPersisted:false};
 }finally{await pg.close()}
}
export async function run(mode){
 if(!['--prepare','--apply-reviewed-single-test-branch'].includes(mode))throw Error('PICA_TRANSFER_EXPLICIT_MODE_REQUIRED');
 await mkdir(directory,{recursive:true});const e=JSON.parse(await readFile(resolve(directory,'verified.json'),'utf8')),kf=JSON.parse(await readFile(e.keyFile,'utf8'));
 if(kf.projectRef!==projectRef)throw Error('PICA_RECOVERY_KEY_PROJECT');const key=Buffer.from(kf.key,'base64');
 try{
  const before=await capture(),backup=await save(before,'before',key);
  const source=await readFile(resolve(root,'scripts/native/production-pica-single-branch.sql'),'utf8');
  const sql=source.replace('__PICA_TRANSFER_GUARD__',sourceGuard(before));
  const rehearsal=await rehearse(before,sql);
  const prepared=resolve(directory,'pica-transfer-reviewed.sql');await writeFile(prepared,sql);
  await writeFile(resolve(directory,'pica-transfer-prepared.json'),JSON.stringify({projectRef,tenantId,backup,sqlSha256:sha(sql),mode,onlyTestSingleBranch:true,ncfAccess:false},null,2)+'\n');
  console.log(JSON.stringify({prepared:true,backupVerified:backup.restore,backupFile:backup.path,rehearsal,sqlSha256:sha(sql),applied:false}));
  if(mode==='--prepare')return;
  await cliQuery(sql);
  const after=await capture(),afterBackup=await save(after,'after',key);
  for(const name of tables.filter(t=>t!=='inventario_sucursales')){
   const a=before.tables.find(t=>t.name===name),b=after.tables.find(t=>t.name===name);
   if(a.count!==b.count)throw Error('PICA_REPAIR_RECORD_COUNT_CHANGED');
  }
  const evidence={projectRef,tenantId,applied:true,before:backup,after:afterBackup,unchangedRecordCountsExceptBranchStock:true,ncfAccess:false,activation:false,newSales:false};
  await writeFile(resolve(directory,'pica-transfer-applied.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
 }finally{key.fill(0)}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))run(process.argv[2]).catch(e=>{console.error('PICA_TRANSFER_NOT_VERIFIED; '+(/^[A-Z][A-Z0-9_: .]+$/.test(e.message??'')?e.message:'REHEARSAL_OR_CAPTURE_FAILED')+'; inspect encrypted recovery before retrying');process.exitCode=1});
