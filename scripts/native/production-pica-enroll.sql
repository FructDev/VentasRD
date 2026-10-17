-- Administrative pilot enrollment authorized by the owner. No business writes,
-- installation registration, entitlement change, cutover or fiscal operation.
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';
lock table public.native_production_cohort_v1 in share row exclusive mode;
do $guard$ begin
 if to_regclass('public.native_staging_licenses_v1') is not null
 or not exists(select 1 from public.negocios where id='864d08e5-2975-4b2d-a1e2-ba5a14f3d677')
 or exists(select 1 from public.native_production_cohort_v1 where enabled and negocio_id<>'864d08e5-2975-4b2d-a1e2-ba5a14f3d677')
 then raise exception 'PICA_ONLY_PRODUCTION_COHORT_REQUIRED';end if;
end $guard$;
insert into public.native_production_cohort_v1(negocio_id,enabled,approved_at)
 values('864d08e5-2975-4b2d-a1e2-ba5a14f3d677',true,now())
 on conflict(negocio_id)do update set enabled=true,approved_at=coalesce(public.native_production_cohort_v1.approved_at,excluded.approved_at);
select jsonb_build_object('projectRef','oxbekqoecunsbjheqgqg','tenantId','864d08e5-2975-4b2d-a1e2-ba5a14f3d677',
 'enabledCount',(select count(*) from public.native_production_cohort_v1 where enabled),
 'otherBusinessesEnabled',(select count(*) from public.native_production_cohort_v1 where enabled and negocio_id<>'864d08e5-2975-4b2d-a1e2-ba5a14f3d677'),
 'operationalCutovers',(select count(*) from public.native_sales_mode_v1),
 'nativeOperations',(select count(*) from public.native_sales_ledger_v1),
 'installations',(select count(*) from public.native_installations_v1)) as pilot;
commit;
