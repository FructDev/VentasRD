-- SELECT ONLY; explicit Staging target required by the caller.
select jsonb_build_object(
 'migrationRecorded',exists(select 1 from supabase_migrations.schema_migrations where version='20261013041548'),
 'fixtureInstallations',(select count(*) from public.native_installations_v1 where installation_id::text like '97310000-%'),
 'fixtureLedgerRows',(select count(*) from public.native_fiscal_settings_ledger_v1 where request_id::text like '97340000-%'),
 'sequenceDigest',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(s) order by negocio_id),'[]'::jsonb)::text,'UTF8')),'hex') from public.ncf_secuencias s where negocio_id in('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002')),
 'qaBAdopted',exists(select 1 from public.native_sales_mode_v1 where negocio_id='96000000-0000-4000-8000-000000000002'),
 'rls',(select relrowsecurity from pg_class where oid='public.native_fiscal_settings_ledger_v1'::regclass),
 'directAuthenticatedAccess',has_table_privilege('authenticated','public.native_fiscal_settings_ledger_v1','SELECT'),
 'authenticatedSubmit',has_function_privilege('authenticated','public.native_fiscal_settings_submit_v1(text,text)','EXECUTE')
) as fiscal_settings_verification;
