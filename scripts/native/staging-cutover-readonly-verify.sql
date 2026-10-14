-- Deployment verification only: no cutover, provisioning, adoption or payload export.
begin transaction isolation level repeatable read read only;
do $verify$
declare installation record;capture jsonb;checks integer:=0;
begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
 if pg_catalog.to_regprocedure('public.native_web_cutover_v1(text,text)') is null or pg_catalog.to_regprocedure('public.native_web_cutover_abandon_v1(text,text)') is null then raise exception 'CUTOVER_MIGRATION_REQUIRED';end if;
 if pg_catalog.has_function_privilege('anon','public.native_web_cutover_v1(text,text)','EXECUTE') or pg_catalog.has_function_privilege('anon','public.native_web_cutover_abandon_v1(text,text)','EXECUTE') or pg_catalog.has_function_privilege('authenticated','public.native_web_cutover_tables_v1(jsonb)','EXECUTE') or pg_catalog.has_table_privilege('authenticated','public.native_web_cutovers_v1','SELECT') or not (select relrowsecurity from pg_catalog.pg_class where oid='public.native_web_cutovers_v1'::regclass) then raise exception 'CUTOVER_ACL_INVALID';end if;
 for installation in
  select distinct on(x.negocio_id) x.*,a.actor_id
  from public.native_installations_v1 x join public.native_actor_sequences_v1 a using(negocio_id,installation_id) join public.negocios g on g.id=x.negocio_id
  where x.negocio_id in('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002') and x.status='REGISTERED'
  and (a.actor_id=g."dueño_id" or exists(select 1 from public.usuarios_negocio u where u.negocio_id=x.negocio_id and u.user_id=a.actor_id and u.activo and u.rol='admin'))
  order by x.negocio_id,x.installation_id,a.actor_id
 loop
  perform pg_catalog.set_config('request.jwt.claim.sub',installation.actor_id::text,true);
  execute 'set local role authenticated';
  capture:=public.native_web_capture_v1(installation.negocio_id,installation.installation_id,installation.device_id,installation.writer_epoch,installation.scope_kind,installation.sucursal_id,'96009999-0000-4000-8000-000000000099');
  execute 'reset role';
  if pg_catalog.jsonb_array_length(public.native_web_cutover_tables_v1(capture))<>15 then raise exception 'CUTOVER_CAPTURE_INVALID';end if;
  checks:=checks+1;
 end loop;
 if checks=0 then raise exception 'CUTOVER_NO_EXISTING_CONTEXT';end if;
 perform pg_catalog.set_config('ventard.cutover_checks',checks::text,true);
end $verify$;
select 'CUTOVER_DEPLOYMENT_READONLY_PASS' as status,pg_catalog.current_setting('ventard.cutover_checks')::integer as registered_contexts_checked;
rollback;
