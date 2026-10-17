// Deterministic LOCAL promotion. Never connects to a database or deploys SQL.
// Reuses reviewed financial implementations, preserving stable IDs/replay/ACL.
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),dir=resolve(root,'supabase/migrations');
export const productionOperationsFile='20261017130229_native_production_operations_v1.sql';
export async function productionOperations(){
 const files=(await readdir(dir)).filter(name=>/^202610\d+_native_.*\.sql$/.test(name)&&name<='20261016165440_native_web_shared_journal_staging_v1.sql'&&!['20261009180752_native_provision_v1.sql','20261010134537_native_fiscal_allocation_v2.sql','20261012150846_native_service_plan_staging_v1.sql','20261013041548_native_fiscal_settings_staging_v1.sql'].includes(name)).sort();
 const chunks=[];
 for(const file of files){
  const original=await readFile(resolve(dir,file),'utf8');let sql=original.replace(/\r\n/g,'\n');
  const guards=sql.match(/do \$guard\$[\s\S]*?end \$guard\$;/gi);if(guards?.length!==1)throw Error('PRODUCTION_SOURCE_GUARD_CHANGED:'+file);
  // Guard blocks can also contain required versioned wrapper renames. Remove
  // solely the QA fixture check, preserving every other statement in the DO.
  const qaGuard=/if\s*\(select count\(\*\) from public\.negocios[\s\S]*?then raise exception 'NATIVE_STAGING_GUARD_FAILED';\s*end if;/i;
  if(!qaGuard.test(guards[0]))throw Error('PRODUCTION_QA_CHECK_CHANGED:'+file);
  sql=sql.replace(guards[0],guards[0].replace(qaGuard,'').replace(/^[ \t]+$/gm,'')).replace(/^begin;\s*$/m,'').replace(/commit;\s*$/,'');
  sql=sql.replaceAll('native_staging_licenses_v1','native_entitlements_v1')
   .replaceAll('96000000-0000-4000-8000-000000000001','864d08e5-2975-4b2d-a1e2-ba5a14f3d677')
   .replaceAll('96000000-0000-4000-8000-000000000002','864d08e5-2975-4b2d-a1e2-ba5a14f3d677')
   .replaceAll('QA_SYNTHETIC_QUIESCED','PRODUCTION_CLOUD_BASELINE_REVIEWED')
   .replaceAll('QA_SYNTHETIC_ADOPTED','CLOUD_ADOPTED_V1');
  // Fiscal data and legacy fiscal writers remain completely outside this DDL.
  sql=sql.replace(",'ncf_secuencias'",'');
  if(/insert\s+into\s+(public\.)?(negocios|native_entitlements_v1)\b/i.test(sql))throw Error('PRODUCTION_SOURCE_SEED_FORBIDDEN:'+file);
  sql=sql.split('\n').filter(line=>!/^--.*(STAGING|QA only|staging only|synthetic tenant)/i.test(line)).join('\n');
  chunks.push('-- Source: '+file+' SHA256 '+createHash('sha256').update(original).digest('hex')+'\n'+sql.trim());
 }
 const access=await readFile(resolve(dir,'20261017125853_native_production_access_v1.sql'),'utf8');
 const member=access.slice(access.indexOf('create or replace function public.native_member_role_v1'),access.indexOf('create or replace view public.native_entitlements_v1'));
 const registration=access.slice(access.indexOf('create or replace function public.native_registrar_instalacion_v1'),access.lastIndexOf('commit;'));
 const guard=`-- Production pilot operations; source-equivalent financial protocol.
-- LOCAL PREPARATION ONLY. Applying schema activates no business or writer.
-- Requires production access migration; reads real entitlements, never seeds QA.
-- NCF provisioning/allocation/settings/sequence triggers are excluded.
begin;
do $production_guard$ begin
 if pg_catalog.to_regclass('public.native_staging_licenses_v1') is not null or pg_catalog.to_regclass('public.native_production_cohort_v1') is null then raise exception 'NATIVE_PRODUCTION_ACCESS_REQUIRED';end if;
end $production_guard$;
`;
 const fiscalGate=`
-- Restore production authorization after source-compatible role extensions.
${member}
${registration}
-- No native fiscal operation may run in this pilot. Existing legacy NCF intact.
create or replace function public.native_sales_fiscal_allocate_v1(p_request jsonb,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $no_fiscal$
begin raise exception using errcode='42501',message='NATIVE_FISCAL_DISABLED';end $no_fiscal$;
revoke all on function public.native_sales_fiscal_allocate_v1(jsonb,text) from public,anon,authenticated;
-- Copy the final shared-journal implementation, keeping its exact body/ACL.
do $copy_submit$ declare definition text;begin
 definition:=pg_catalog.pg_get_functiondef('public.native_sales_submit_v1(text,text,text,text)'::regprocedure);
 if pg_catalog.strpos(definition,'native_production_submit_base_v1')>0 then raise exception 'NATIVE_PRODUCTION_SUBMIT_SOURCE_INVALID';end if;
 execute pg_catalog.replace(definition,'FUNCTION public.native_sales_submit_v1(', 'FUNCTION public.native_production_submit_base_v1(');
end $copy_submit$;
revoke all on function public.native_production_submit_base_v1(text,text,text,text) from public,anon,authenticated;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $production_submit$
begin
 if coalesce(p_intent::jsonb->'payload'->'sale'->'fiscal','null'::jsonb)<>'null'::jsonb or coalesce(p_snapshot::jsonb->'ncf','null'::jsonb)<>'null'::jsonb then raise exception using errcode='42501',message='NATIVE_FISCAL_DISABLED';end if;
 return public.native_production_submit_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
end $production_submit$;
revoke all on function public.native_sales_submit_v1(text,text,text,text) from public,anon;
grant execute on function public.native_sales_submit_v1(text,text,text,text) to authenticated;
-- Cloud activation is reachable only through the reviewed, recoverable cutover.
revoke all on function public.native_sales_activate_v1(uuid,uuid,uuid,bigint,text,uuid,text,text) from public,anon,authenticated;
commit;
`;
 return guard+chunks.join('\n\n')+fiscalGate;
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const sql=await productionOperations(),path=resolve(dir,productionOperationsFile);
 if(process.argv.includes('--check')){if(await readFile(path,'utf8')!==sql)throw Error('PRODUCTION_MIGRATION_SOURCE_DRIFT');console.log('PRODUCTION_MIGRATION_SOURCE_MATCHES')}
 else{await writeFile(path,sql);console.log('PRODUCTION_MIGRATION_PREPARED_LOCALLY; NOT_APPLIED')}
}
