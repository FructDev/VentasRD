-- Staging only: two QA businesses plus one explicitly bounded NEW pilot.
-- This schema change creates no business, user, membership, licence or NCF.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2
 or pg_catalog.to_regclass('public.native_web_channels_v1') is null then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;

alter table public.native_staging_licenses_v1 drop constraint if exists native_staging_licenses_v1_negocio_id_check;
alter table public.native_staging_licenses_v1 add constraint native_staging_licenses_v1_negocio_id_check check(negocio_id in(
 '96000000-0000-4000-8000-000000000001'::uuid,
 '96000000-0000-4000-8000-000000000002'::uuid,
 '96000000-0000-4000-8000-000000000003'::uuid));

create or replace function public.native_member_role_v1(p_negocio_id uuid) returns text language sql stable security definer set search_path='' as $f$
 select case when n."dueño_id"=auth.uid() then 'owner' else
 (select u.rol from public.usuarios_negocio u where u.negocio_id=n.id and u.user_id=auth.uid() and u.activo and u.rol in('admin','vendedor','cajero') order by u.id limit 1) end
 from public.negocios n where auth.uid() is not null and n.id=p_negocio_id and n.id in(
 '96000000-0000-4000-8000-000000000001'::uuid,'96000000-0000-4000-8000-000000000002'::uuid,'96000000-0000-4000-8000-000000000003'::uuid);
$f$;
revoke all on function public.native_member_role_v1(uuid) from public,anon;
grant execute on function public.native_member_role_v1(uuid) to authenticated;

-- Change only the cohort literal in the existing reviewed implementations.
-- Preserve their version-specific reconciliation, replay, backup and ACL rules.
-- Fail closed if any prerequisite implementation has changed unexpectedly.
do $cohort$
declare signature text;definition text;before_list text:='''96000000-0000-4000-8000-000000000001''::uuid,''96000000-0000-4000-8000-000000000002''::uuid';
 after_list text:=before_list||',''96000000-0000-4000-8000-000000000003''::uuid';
begin
 foreach signature in array array[
 'public.native_team_invite_read_v1(uuid)',
 'public.native_team_invite_accept_v1(uuid,uuid)',
 'public.native_web_cutover_v1(text,text)',
 'public.native_web_cutover_resolution_base_v1(text,text)',
 'public.native_web_cutover_abandon_v1(text,text)'] loop
  if pg_catalog.to_regprocedure(signature) is null then raise exception 'NATIVE_PILOT_PREREQUISITE_MISSING';end if;
  definition:=pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(signature));
  if pg_catalog.strpos(definition,after_list)=0 then
   if (pg_catalog.length(definition)-pg_catalog.length(pg_catalog.replace(definition,before_list,'')))<>pg_catalog.length(before_list) then raise exception 'NATIVE_PILOT_IMPLEMENTATION_CHANGED';end if;
   execute pg_catalog.replace(definition,before_list,after_list);
  end if;
 end loop;
end $cohort$;
commit;
