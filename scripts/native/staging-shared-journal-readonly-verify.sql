-- Only schema/ACL and read-only checks with existing synthetic contexts.
begin transaction isolation level repeatable read read only;
do $verify$
declare f text;x record;m jsonb;feed jsonb;checked integer:=0;
begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'STAGING_GUARD_FAILED';end if;
 if not (select relrowsecurity from pg_catalog.pg_class where oid='public.native_web_channels_v1'::regclass) or pg_catalog.has_table_privilege('authenticated','public.native_web_channels_v1','SELECT,INSERT,UPDATE,DELETE') or pg_catalog.has_table_privilege('anon','public.native_web_channels_v1','SELECT,INSERT,UPDATE,DELETE') then raise exception 'SHARED_TABLE_ACL_INVALID';end if;
 foreach f in array array['native_web_mode_v1(uuid,uuid)','native_web_enroll_v1(uuid,uuid,uuid,uuid,uuid)','native_web_submit_v1(jsonb,text,text,text,text)','native_web_lookup_v1(jsonb,uuid,text)','native_web_feed_v1(jsonb,bigint)','native_web_bootstrap_v1(jsonb,uuid)','native_web_bootstrap_page_v1(jsonb,uuid,integer)','native_web_service_plan_v1(jsonb,text,jsonb,jsonb,text,text,text)','native_web_return_plan_v1(jsonb,jsonb,jsonb,jsonb,jsonb)'] loop
  if not pg_catalog.has_function_privilege('authenticated','public.'||f,'EXECUTE') or pg_catalog.has_function_privilege('anon','public.'||f,'EXECUTE') then raise exception 'SHARED_RPC_ACL_INVALID';end if;
 end loop;
 foreach f in array array['native_web_context_v1(jsonb)','native_shared_ready_v1(uuid)','native_shared_stock_v1(uuid,text,uuid,uuid,uuid,jsonb,integer,bigint)','native_sales_submit_shared_base_v1(text,text,text,text)','native_sales_feed_shared_base_v1(uuid,uuid,uuid,bigint,text,uuid,bigint)','native_sales_bootstrap_shared_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)'] loop
  if pg_catalog.has_function_privilege('authenticated','public.'||f,'EXECUTE') or pg_catalog.has_function_privilege('anon','public.'||f,'EXECUTE') then raise exception 'SHARED_HELPER_EXPOSED';end if;
 end loop;
 if pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.native_sales_submit_base_v1(text,text,text,text)'::regprocedure),'native_shared_stock_v1')=0 then raise exception 'SHARED_SALE_PROTOCOL_MISSING';end if;
 perform pg_catalog.set_config('request.headers','{"x-ventard-journal":"stock-merge-1"}',true);
 for x in select i.*,a.actor_id from public.native_installations_v1 i join public.native_actor_sequences_v1 a using(negocio_id,installation_id) join public.negocios n on n.id=i.negocio_id where i.negocio_id in('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002') and i.status='REGISTERED' and (a.actor_id=n."dueño_id" or exists(select 1 from public.usuarios_negocio u where u.negocio_id=i.negocio_id and u.user_id=a.actor_id and u.activo and u.rol='admin')) loop
  perform pg_catalog.set_config('request.jwt.claim.sub',x.actor_id::text,true);
  execute 'set local role authenticated';
  m:=public.native_web_mode_v1(x.negocio_id,x.sucursal_id);
  if m->>'mode'='SHARED_JOURNAL' then feed:=public.native_sales_feed_v1(x.negocio_id,x.installation_id,x.device_id,x.writer_epoch,x.scope_kind,x.sucursal_id,0);end if;
  execute 'reset role';
  if m->>'protocol'<>'ventard.web.mode.1' or m->>'tenantId'<>x.negocio_id::text or m->>'mode' not in('LEGACY','SHARED_JOURNAL','SCOPE_BLOCKED') then raise exception 'SHARED_CONTEXT_READ_INVALID';end if;
  checked:=checked+1;
 end loop;
 if checked=0 then raise exception 'NO_EXISTING_QA_CONTEXT';end if;
 perform pg_catalog.set_config('ventard.shared_contexts',checked::text,true);
end $verify$;
select 'SHARED_JOURNAL_READONLY_PASS' as status,pg_catalog.current_setting('ventard.shared_contexts')::integer as existing_contexts;
rollback;
