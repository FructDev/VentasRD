-- Prepared for explicit Staging approval. Read-only registered QA contexts;
-- no provisioning, license changes, adoption, fixture writes or output payloads.
begin transaction isolation level repeatable read read only;
do $verify$
declare n uuid;installation record;answer jsonb;table_json jsonb;row_json jsonb;contexts_checked integer:=0;tables_checked integer:=0;
begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'WEB_STAGING_GUARD_FAILED';end if;
 if pg_catalog.to_regprocedure('public.native_web_capture_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)') is null then raise exception 'WEB_CAPTURE_MIGRATION_REQUIRED';end if;
 if pg_catalog.has_function_privilege('anon','public.native_web_capture_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)','EXECUTE') or pg_catalog.has_function_privilege('authenticated','public.native_web_observation_json_v1(jsonb,integer)','EXECUTE') then raise exception 'WEB_CAPTURE_ACL_INVALID';end if;
 foreach n in array array['96000000-0000-4000-8000-000000000001'::uuid,'96000000-0000-4000-8000-000000000002'::uuid] loop
  select x.*,a.actor_id into installation from public.native_installations_v1 x join public.native_actor_sequences_v1 a using(negocio_id,installation_id) join public.negocios business on business.id=x.negocio_id
  where x.negocio_id=n and x.status='REGISTERED' and (a.actor_id=business."dueño_id" or exists(select 1 from public.usuarios_negocio un where un.negocio_id=n and un.user_id=a.actor_id and un.activo and un.rol='admin')) order by x.installation_id,a.actor_id limit 1;
  if not found then continue;end if;
  perform pg_catalog.set_config('request.jwt.claim.sub',installation.actor_id::text,true);
  execute 'set local role authenticated';
  answer:=public.native_web_capture_v1(n,installation.installation_id,installation.device_id,installation.writer_epoch,installation.scope_kind,installation.sucursal_id,'96009999-0000-4000-8000-000000000097');
  execute 'reset role';
  if answer->>'protocol'<>'ventard.web.capture.1' or answer->>'coverage'<>'SCOPE_COMPLETE_SINGLE_SNAPSHOT' or answer->'context'<>pg_catalog.jsonb_build_object('tenantId',n,'actorId',installation.actor_id,'installationId',installation.installation_id,'deviceId',installation.device_id,'writerEpoch',installation.writer_epoch::text,'scopeType',installation.scope_kind,'branchId',installation.sucursal_id) or pg_catalog.jsonb_array_length(answer->'tables')<>15 then raise exception 'WEB_CAPTURE_CONTEXT_INVALID';end if;
  for table_json in select value from pg_catalog.jsonb_array_elements(answer->'tables') loop
   if (table_json->>'count')::integer<>pg_catalog.jsonb_array_length(table_json->'rows') then raise exception 'WEB_CAPTURE_COUNT_INVALID';end if;
   for row_json in select value from pg_catalog.jsonb_array_elements(table_json->'rows') loop
    if row_json->>'negocio_id' is distinct from n::text then raise exception 'WEB_CAPTURE_TENANT_INVALID';end if;
   end loop;
   tables_checked:=tables_checked+1;
  end loop;
  contexts_checked:=contexts_checked+1;
 end loop;
 if contexts_checked=0 then raise exception 'WEB_CAPTURE_NO_REAL_QA_CONTEXT';end if;
 perform pg_catalog.set_config('ventard.capture_contexts',contexts_checked::text,true);
 perform pg_catalog.set_config('ventard.capture_tables',tables_checked::text,true);
end $verify$;
select 'WEB_CAPTURE_READONLY_PASS' as status,pg_catalog.current_setting('ventard.capture_contexts')::integer as registered_contexts_checked,pg_catalog.current_setting('ventard.capture_tables')::integer as complete_tables_checked;
rollback;
