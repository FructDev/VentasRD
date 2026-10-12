-- Authorized 2026-10-12: Staging blzzinivvzadqjbnpsre, synthetic QA A/B only.
-- Data setup, not a schema migration. Never run against production.
begin;
do $qa$
declare before_other jsonb; after_other jsonb; updated integer;
begin
 if (select count(*) from public.negocios where
   (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
   (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO')) <> 2
 then raise exception 'NATIVE_STAGING_GUARD_FAILED'; end if;
 select jsonb_agg(to_jsonb(l) order by negocio_id) into before_other
 from public.native_staging_licenses_v1 l
 where negocio_id not in ('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002');
 update public.native_staging_licenses_v1 set plan_tier='pro'
 where negocio_id in ('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002');
 get diagnostics updated = row_count;
 if updated <> 2 then raise exception 'NATIVE_QA_LICENSES_MISSING'; end if;
 select jsonb_agg(to_jsonb(l) order by negocio_id) into after_other
 from public.native_staging_licenses_v1 l
 where negocio_id not in ('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002');
 if before_other is distinct from after_other then raise exception 'NATIVE_NON_QA_LICENSE_CHANGED'; end if;
end $qa$;
commit;
select negocio_id, plan_tier, plan_active from public.native_staging_licenses_v1
where negocio_id in ('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002') order by negocio_id;
