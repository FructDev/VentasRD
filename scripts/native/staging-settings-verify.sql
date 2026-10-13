-- SELECT ONLY after the authorized Staging migration/rollback fixture.
select jsonb_build_object(
 'migrationRecorded',exists(select 1 from supabase_migrations.schema_migrations where version='20261012230033'),
 'qaSettingsRows',(select count(*) from public.native_business_settings_v1 where negocio_id in('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002')),
 'fixtureLedgerRows',(select count(*) from public.native_sales_ledger_v1 where operation_id::text like '97040000-%'),
 'fixtureInstallations',(select count(*) from public.native_installations_v1 where installation_id::text like '97010000-%'),
 'fixtureSnapshots',(select count(*) from public.native_sales_snapshots_v1 where snapshot_id::text like '97050000-%' or snapshot_id::text like '97060000-%'),
 'qaBAdopted',exists(select 1 from public.native_sales_mode_v1 where negocio_id='96000000-0000-4000-8000-000000000002'),
 'tableRls',(select relrowsecurity from pg_class where oid='public.native_business_settings_v1'::regclass),
 'directAuthenticatedTableAccess',has_table_privilege('authenticated','public.native_business_settings_v1','SELECT'),
 'authenticatedSubmit',has_function_privilege('authenticated','public.native_sales_submit_v1(text,text,text,text)','EXECUTE')
) as settings_verification;
