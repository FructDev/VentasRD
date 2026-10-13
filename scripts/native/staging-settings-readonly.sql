-- SELECT ONLY. Explicit target: Staging blzzinivvzadqjbnpsre.
select pg_catalog.jsonb_build_object(
 'qaGuard', (select count(*)=2 from public.negocios where
  (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
  (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO')),
 'settingsInstalled',pg_catalog.to_regclass('public.native_business_settings_v1') is not null,
 'parents',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
   'name',p.proname,'securityDefiner',p.prosecdef,'config',p.proconfig,
   'headerCompatible',position('not exists(select 1 from public.native_sales_snapshots_v1 ss where ss.negocio_id=n and ss.installation_id=i and ss.scope_kind=k and ss.sucursal_id is not distinct from b and ss.manifest->''business''=business)' in pg_catalog.pg_get_functiondef(p.oid))>0
    or position('native_settings_header_valid_v1' in pg_catalog.pg_get_functiondef(p.oid))>0)
   order by p.proname)
   from pg_catalog.pg_proc p join pg_catalog.pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public' and p.proname in ('native_repairs_submit_v1','native_layaways_submit_v1','native_warranty_submit_v1')),
 'versions',(select pg_catalog.jsonb_agg(version order by version) from supabase_migrations.schema_migrations
    where version in('20261012004947','20261012031553','20261012123311','20261012150846','20261012153049','20261012201138','20261012203519','20261012222616','20261012230033'))
) as settings_preflight;
