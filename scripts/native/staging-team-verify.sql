-- Existing synthetic QA contexts, schema/ACL/read only; no invitations or users.
begin transaction isolation level repeatable read read only;
do $verify$
declare x record;v jsonb;checked integer:=0;
begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'STAGING_GUARD_FAILED';end if;
 if pg_catalog.has_table_privilege('authenticated','public.native_team_operations_v1','INSERT') or pg_catalog.has_table_privilege('authenticated','public.native_team_redemptions_v1','SELECT') or pg_catalog.has_function_privilege('authenticated','public.native_team_context_v1(jsonb)','EXECUTE') or pg_catalog.has_function_privilege('authenticated','public.native_sales_submit_team_base_v1(text,text,text,text)','EXECUTE') or pg_catalog.has_function_privilege('authenticated','public.native_team_invite_accept_v1(uuid,uuid)','EXECUTE') or pg_catalog.has_function_privilege('anon','public.native_team_read_v1(uuid,uuid,uuid,bigint,text,uuid)','EXECUTE') or not pg_catalog.has_function_privilege('service_role','public.native_team_invite_accept_v1(uuid,uuid)','EXECUTE') then raise exception 'TEAM_ACL_INVALID';end if;
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='usuarios_negocio' and column_name='invite_expires_at') then raise exception 'TEAM_SCHEMA_MISSING';end if;
 if pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.native_sales_submit_v1(text,text,text,text)'::regprocedure),'NATIVE_CASHIER_POS_ONLY')=0 or pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.native_member_role_v1(uuid)'::regprocedure),'''cajero''')=0 then raise exception 'CASHIER_POLICY_MISSING';end if;
 for x in select i.*,a.actor_id from public.native_installations_v1 i join public.native_actor_sequences_v1 a using(negocio_id,installation_id) where i.negocio_id in('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002') and i.status='REGISTERED' loop
  perform pg_catalog.set_config('request.jwt.claim.sub',x.actor_id::text,true);
  execute 'set local role authenticated';
  v:=public.native_team_read_v1(x.negocio_id,x.installation_id,x.device_id,x.writer_epoch,x.scope_kind,x.sucursal_id);
  execute 'reset role';
  if v->>'version'<>'ventard.team.view.1' or v->>'tenantId'<>x.negocio_id::text or pg_catalog.jsonb_typeof(v->'members')<>'array' then raise exception 'TEAM_CONTEXT_INVALID';end if;
  checked:=checked+1;
 end loop;
 if checked=0 then raise exception 'NO_EXISTING_QA_CONTEXT';end if;
 perform pg_catalog.set_config('ventard.team_contexts',checked::text,true);
end $verify$;
select 'TEAM_READONLY_PASS' as status,pg_catalog.current_setting('ventard.team_contexts')::integer as existing_contexts;
rollback;
