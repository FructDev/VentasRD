-- Read only, existing synthetic QA contexts. No names, contacts or tokens output.
begin transaction isolation level repeatable read read only;
do $verify$
declare x record;checked integer:=0;businesses integer;members integer;
begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'STAGING_GUARD_FAILED';end if;
 for x in select i.negocio_id,a.actor_id from public.native_installations_v1 i join public.native_actor_sequences_v1 a using(negocio_id,installation_id) where i.negocio_id in('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002') and i.status='REGISTERED' loop
  perform pg_catalog.set_config('request.jwt.claim.sub',x.actor_id::text,true);
  execute 'set local role authenticated';
  select count(*) into businesses from public.negocios where id=x.negocio_id and nombre is not null;
  perform id,logo_url,color_marca,fuente_marca from public.negocios where id=x.negocio_id;
  select count(*) into members from public.usuarios_negocio where negocio_id=x.negocio_id and user_id=x.actor_id and activo=true;
  execute 'reset role';
  if businesses<>1 or members>1 then raise exception 'ACCOUNT_PROFILE_READ_INVALID';end if;
  checked:=checked+1;
 end loop;
 if checked=0 then raise exception 'NO_EXISTING_QA_CONTEXT';end if;
 perform pg_catalog.set_config('ventard.profile_contexts',checked::text,true);
end $verify$;
select 'ACCOUNT_PROFILE_READONLY_PASS' as status,pg_catalog.current_setting('ventard.profile_contexts')::integer as existing_contexts;
rollback;
