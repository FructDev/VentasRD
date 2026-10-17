// Read-only production capture. Private rows/keys are never logged or written
// unencrypted to the repository. Restore verification uses isolated RAM only.
import {spawn} from 'node:child_process';
import {randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';import {PGlite} from '@electric-sql/pglite';
import {readSecret} from './signing-custody.mjs';
export const projectRef='oxbekqoecunsbjheqgqg';
export const tenantId='864d08e5-2975-4b2d-a1e2-ba5a14f3d677';
const root=resolve(import.meta.dirname,'../..'),privateDirectory=resolve(root,'scratch/production-signing/recovery');
const sha=b=>createHash('sha256').update(b).digest('hex');
export function encryptRecovery(bytes,key,purpose){
 if(!Buffer.isBuffer(bytes)||!Buffer.isBuffer(key)||key.length!==32||!['DATABASE','SIGNING'].includes(purpose))throw Error('RECOVERY_INPUT_INVALID');
 const nonce=randomBytes(12),aad=Buffer.from('ventard.production.recovery.1:'+projectRef+':'+purpose),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);
 const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
 return {protocol:'ventard.production.recovery.1',projectRef,purpose,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),sha256:sha(bytes),ciphertext:ciphertext.toString('base64')};
}
export function decryptRecovery(envelope,key,purpose){
 if(envelope.protocol!=='ventard.production.recovery.1'||envelope.projectRef!==projectRef||envelope.purpose!==purpose||key.length!==32)throw Error('RECOVERY_ENVELOPE_INVALID');
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.nonce,'base64'));decipher.setAAD(Buffer.from('ventard.production.recovery.1:'+projectRef+':'+purpose));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
 const bytes=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]);if(sha(bytes)!==envelope.sha256)throw Error('RECOVERY_HASH_MISMATCH');return bytes;
}
const identifier=v=>'"'+v.replaceAll('"','""')+'"';
const literal=v=>"'"+v.replaceAll("'","''")+"'";
export function recoveryScope(table,columns){
 const target=literal(tenantId);
 if(table==='ncf_secuencias')return null;
 if(table==='negocios')return 't.id='+target;
 if(['venta_detalles','detalles_ventas'].includes(table)&&columns.includes('venta_id')){
  const parent=`exists(select 1 from public.ventas p where p.id::text=t.venta_id::text and p.negocio_id=${target})`;
  return columns.includes('negocio_id')?`(t.negocio_id=${target} or(t.negocio_id is null and ${parent}))`:parent;
 }
 if(columns.includes('negocio_id'))return 't.negocio_id='+target;
 if(table==='inventario_sucursales'&&columns.includes('sucursal_id'))return `exists(select 1 from public.sucursales p where p.id=t.sucursal_id and p.negocio_id=${target})`;
 throw Error('RECOVERY_UNSCOPED_TABLE_REJECTED');
}
async function cliQuery(sql){
 await mkdir(privateDirectory,{recursive:true});const file=join(privateDirectory,'readonly-'+randomBytes(12).toString('hex')+'.sql');await writeFile(file,sql,{flag:'wx'});
 try{return await new Promise((ok,fail)=>{
  const npx=resolve(dirname(process.execPath),'node_modules/npm/bin/npx-cli.js');
  const child=spawn(process.execPath,[npx,'--offline','supabase','db','query','--linked','--project-ref',projectRef,'--file',file,'-o','json'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:180000});let output='',size=0;
  child.stdout.setEncoding('utf8');child.stdout.on('data',b=>{size+=Buffer.byteLength(b);if(size>256*1024*1024)child.kill();else output+=b});child.stderr.on('data',()=>{});
  child.once('error',()=>fail(Error('RECOVERY_QUERY_UNAVAILABLE')));child.once('exit',code=>{if(code!==0)return fail(Error('RECOVERY_QUERY_FAILED'));try{ok(JSON.parse(output.slice(output.indexOf('{'))).rows)}catch{fail(Error('RECOVERY_QUERY_OUTPUT_INVALID'))}});
 })}finally{await rm(file,{force:true})}
}
export async function verifyPublicRestore(snapshot){
 const db=new PGlite();let count=0;
 try{
  for(const table of snapshot.tables){
   if(table.sourceSha256&&sha(Buffer.from(table.rows.join('\n')))!==table.sourceSha256)throw Error('RECOVERY_SOURCE_BYTES_MISMATCH');
   const columns=snapshot.columns.filter(c=>c.table===table.name);if(!columns.length)throw Error('RECOVERY_COLUMNS_MISSING');
   // PostgreSQL emits these type declarations; quote every identifier. No
   // source defaults/functions/triggers are executed in this data restore.
   for(const c of columns)if(!/^(uuid|text(\[\])?|jsonb|json|boolean|bigint|integer|smallint|numeric(\([0-9, ]+\))?|double precision|real|timestamp with time zone|timestamp without time zone|character varying(\([0-9]+\))?|date|bytea)$/.test(c.type))throw Error('RECOVERY_TYPE_UNSUPPORTED');
   await db.exec('create table public.'+identifier(table.name)+'('+columns.map(c=>identifier(c.name)+' '+c.type+(c.notNull?' not null':'')).join(',')+')');
   for(let offset=0;offset<table.rows.length;offset+=100){const rows=table.rows.slice(offset,offset+100);await db.query('insert into public.'+identifier(table.name)+' select * from jsonb_populate_recordset(null::public.'+identifier(table.name)+',$1::jsonb)',['['+rows.join(',')+']'])}
   const actual=(await db.query('select row_to_json(t)::text as row from public.'+identifier(table.name)+' t')).rows.map(r=>r.row);
   // JSONB normalizes object keys while retaining exact PostgreSQL numerics;
   // compare on the SQL side to avoid JS rounding of money or large integers.
   const matched=(await db.query('select (select jsonb_agg(j order by j::text) from jsonb_array_elements($1::jsonb) j) is not distinct from (select jsonb_agg(j order by j::text) from jsonb_array_elements($2::jsonb) j) as ok',['['+table.rows.join(',')+']','['+actual.join(',')+']'])).rows[0].ok;
   if(!matched||actual.length!==table.count)throw Error('RECOVERY_RESTORE_MISMATCH');count+=actual.length;
  }
  return {engine:'ISOLATED_POSTGRESQL_RAM',tables:snapshot.tables.length,rows:count,exactNumericComparison:true,remoteWrites:false};
 }finally{await db.close()}
}
export async function captureProductionRecovery(){
 const metadata=await cliQuery("begin read only;select c.relname as name,array_agg(a.attname::text order by a.attnum) as columns from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where n.nspname='public' and c.relkind='r' group by c.relname order by c.relname;rollback;");
 const scoped=metadata.map(t=>({...t,predicate:recoveryScope(t.name,t.columns)})).filter(t=>t.predicate!==null),names=scoped.map(t=>t.name);
 if(!names.includes('negocios')||names.some(n=>n.startsWith('native_')))throw Error('RECOVERY_EXPECTED_PREDEPLOY_SCHEMA_REQUIRED');
 const union=scoped.map(({name,predicate})=>`select ${literal(name)} as name,count(*)::integer as count,encode(sha256(convert_to(coalesce(string_agg(row_to_json(t)::text,E'\\n' order by row_to_json(t)::text),''),'UTF8')),'hex') as "sourceSha256",coalesce(jsonb_agg(row_to_json(t)::text order by row_to_json(t)::text),'[]'::jsonb) as rows from public.${identifier(name)} t where ${predicate}`).join(' union all ');
 const rows=await cliQuery(`begin isolation level repeatable read read only;set local statement_timeout='120s';set local timezone='UTC';
 select jsonb_build_object('protocol','ventard.production.public.snapshot.1','projectRef','${projectRef}','tenantId','${tenantId}','takenAt',transaction_timestamp(),
 'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) order by c.relname,a.attnum) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='public' and c.relkind='r'),
 'constraints',(select coalesce(jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid))),'[]') from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='public'),
 'functions',(select coalesce(jsonb_agg(pg_get_functiondef(p.oid)),'[]') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'),
 'triggers',(select coalesce(jsonb_agg(pg_get_triggerdef(t.oid)),'[]') from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal),
 'indexes',(select coalesce(jsonb_agg(indexdef),'[]') from pg_indexes where schemaname='public'),
 'policies',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from pg_policies p where schemaname='public'),
 'grants',(select coalesce(jsonb_agg(to_jsonb(g)),'[]') from information_schema.table_privileges g where table_schema='public'),
 'migrationHistory',(select coalesce(jsonb_agg(to_jsonb(m) order by version),'[]') from supabase_migrations.schema_migrations m),
 'tables',(select jsonb_agg(to_jsonb(t) order by name) from (${union}) t)) as snapshot;rollback;`);
 const snapshot=rows[0]?.snapshot;if(snapshot?.projectRef!==projectRef||snapshot.tenantId!==tenantId||snapshot.tables?.length!==names.length)throw Error('RECOVERY_SNAPSHOT_INVALID');
 const recoveryPath=resolve(process.env.USERPROFILE,'Downloads','VentaRD-produccion-recuperacion-20261017.key');let key;
 try{const existing=JSON.parse(await readFile(recoveryPath,'utf8'));if(existing.protocol!=='ventard.production.recovery.key.1'||existing.projectRef!==projectRef)throw Error('RECOVERY_KEY_MISMATCH');key=Buffer.from(existing.key,'base64');if(key.length!==32)throw Error('RECOVERY_KEY_INVALID')}
 catch(e){if(e.code!=='ENOENT')throw e;key=randomBytes(32);await writeFile(recoveryPath,JSON.stringify({protocol:'ventard.production.recovery.key.1',projectRef,key:key.toString('base64')})+'\n',{flag:'wx',mode:0o600})}
 try{
  const bytes=Buffer.from(JSON.stringify(snapshot)),name='database-'+new Date().toISOString().replace(/[:.]/g,'-')+'.vrrecovery',archive=join(privateDirectory,name);
  await writeFile(archive,JSON.stringify(encryptRecovery(bytes,key,'DATABASE')),{flag:'wx'});
  const restored=decryptRecovery(JSON.parse(await readFile(archive,'utf8')),key,'DATABASE');if(!restored.equals(bytes))throw Error('RECOVERY_ROUNDTRIP_FAILED');
  const verification=await verifyPublicRestore(JSON.parse(restored));restored.fill(0);bytes.fill(0);
  const grant=await readSecret(resolve(root,'scratch/production-signing'),'production-grant'),updater=await readSecret(resolve(root,'scratch/production-signing'),'production-updater');
  try{
   const secretBytes=Buffer.from(JSON.stringify({grant:grant.toString('base64'),updater:updater.toString('base64'),public:JSON.parse(await readFile(resolve(root,'scratch/production-signing/public.json'),'utf8'))}));
   const path=join(privateDirectory,'signing-'+name);await writeFile(path,JSON.stringify(encryptRecovery(secretBytes,key,'SIGNING')),{flag:'wx'});const roundtrip=decryptRecovery(JSON.parse(await readFile(path,'utf8')),key,'SIGNING');if(!roundtrip.equals(secretBytes))throw Error('RECOVERY_SIGNING_FAILED');roundtrip.fill(0);secretBytes.fill(0);
  }finally{grant.fill(0);updater.fill(0)}
  const evidence={protocol:'ventard.production.recovery.evidence.1',projectRef,tenantId,otherBusinessRowsIncluded:false,ncfSequencesIncluded:false,takenAt:snapshot.takenAt,archive,archiveSha256:sha(await readFile(archive)),keyFile:recoveryPath,verification,authSchemaAndStorageObjects:'NOT_INCLUDED_NO_CHANGES_AUTHORIZED',schemaDefinitionsPreserved:true};
  await writeFile(join(privateDirectory,'verified.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));return evidence;
 }finally{key.fill(0)}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 if(process.argv.slice(2).join(' ')!=='--capture-production')throw Error('RECOVERY_EXPLICIT_CAPTURE_REQUIRED');
 captureProductionRecovery().catch(error=>{const code=/^RECOVERY_[A-Z_]+$/.test(error.message??'')?error.message:'RECOVERY_INTERNAL_ERROR';console.error('PRODUCTION_RECOVERY_NOT_VERIFIED; '+code+'; private data was not emitted');process.exitCode=1});
}
