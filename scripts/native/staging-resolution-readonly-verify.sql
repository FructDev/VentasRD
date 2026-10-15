-- Schema/ACL and existing synthetic QA contexts only. No cutover or adoption.
begin transaction isolation level repeatable read read only;
do $verify$
declare x record;v jsonb;c jsonb;f text;t text;checked integer:=0;
begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'STAGING_GUARD_FAILED';end if;
 foreach t in array array['native_web_resolutions_v1','native_web_resolution_parts_v1'] loop
  if not (select relrowsecurity from pg_catalog.pg_class where oid=pg_catalog.to_regclass('public.'||t)) or pg_catalog.has_table_privilege('authenticated','public.'||t,'SELECT,INSERT,UPDATE,DELETE') or pg_catalog.has_table_privilege('anon','public.'||t,'SELECT,INSERT,UPDATE,DELETE') then raise exception 'RESOLUTION_TABLE_ACL_INVALID';end if;
 end loop;
 foreach f in array array['native_web_resolution_basis_v1(jsonb,uuid)','native_web_resolution_history_v1(jsonb,uuid)','native_web_resolution_stage_v1(jsonb,uuid,text,integer,integer,text,text)','native_web_resolution_commit_v1(jsonb,uuid,text,integer)','native_web_resolution_abandon_v1(jsonb,uuid,text,integer)','native_web_cutover_v1(text,text)','native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)'] loop
  if pg_catalog.has_function_privilege('anon','public.'||f,'EXECUTE') or not pg_catalog.has_function_privilege('authenticated','public.'||f,'EXECUTE') then raise exception 'RESOLUTION_RPC_ACL_INVALID';end if;
 end loop;
 foreach f in array array['native_web_resolution_stock_v1(uuid)','native_web_resolution_decode_v1(jsonb,integer)','native_web_resolution_upsert_v1(text,jsonb,uuid,text,uuid)','native_web_resolution_transport_v1(jsonb,uuid,text,integer)','native_web_resolution_assembled_v1(jsonb,uuid,text,integer,uuid)','native_web_resolution_finish_v1(jsonb,uuid,text,integer,boolean)','native_web_cutover_resolution_base_v1(text,text)','native_sales_bootstrap_resolution_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)'] loop
  if pg_catalog.has_function_privilege('authenticated','public.'||f,'EXECUTE') or pg_catalog.has_function_privilege('anon','public.'||f,'EXECUTE') then raise exception 'RESOLUTION_HELPER_EXPOSED';end if;
 end loop;
 if pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.native_web_cutover_v1(text,text)'::regprocedure),'RESOLUTION_NATIVE_ALREADY_STARTED')=0 or pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)'::regprocedure),'legacyResolutionHistory')=0 then raise exception 'RESOLUTION_FENCE_OR_HISTORY_MISSING';end if;
 for x in select i.*,a.actor_id from public.native_installations_v1 i join public.native_actor_sequences_v1 a using(negocio_id,installation_id) join public.negocios g on g.id=i.negocio_id where i.negocio_id in('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002') and i.status='REGISTERED' and (a.actor_id=g."dueño_id" or exists(select 1 from public.usuarios_negocio u where u.negocio_id=i.negocio_id and u.user_id=a.actor_id and u.activo and u.rol='admin')) loop
  c:=pg_catalog.jsonb_build_object('tenantId',x.negocio_id,'actorId',x.actor_id,'installationId',x.installation_id,'deviceId',x.device_id,'writerEpoch',x.writer_epoch::text,'scopeType',x.scope_kind,'branchId',x.sucursal_id);
  perform pg_catalog.set_config('request.jwt.claim.sub',x.actor_id::text,true);
  execute 'set local role authenticated';
  v:=public.native_web_resolution_basis_v1(c,'96009999-0000-4000-8000-000000000099');
  execute 'reset role';
  if v->>'protocol'<>'ventard.web.resolution.basis.1' or v->'context' is distinct from c or pg_catalog.jsonb_array_length(v->'tables')<>15 or pg_catalog.jsonb_typeof(v->'stockBase')<>'array' or v->>'stockHash'!~'^[0-9a-f]{64}$' or pg_catalog.jsonb_typeof(v->'started')<>'boolean' then raise exception 'RESOLUTION_CONTEXT_INVALID';end if;
  checked:=checked+1;
 end loop;
 if checked=0 then raise exception 'NO_EXISTING_QA_CONTEXT';end if;
 perform pg_catalog.set_config('ventard.resolution_contexts',checked::text,true);
end $verify$;
select 'RESOLUTION_DEPLOYMENT_READONLY_PASS' as status,pg_catalog.current_setting('ventard.resolution_contexts')::integer as existing_contexts;
rollback;
