-- Metadata/ACL only. No business records, registrations or commercial RPCs.
begin read only;
set local statement_timeout='20s';
select jsonb_build_object(
 'expectedMigrations',(select count(*) from supabase_migrations.schema_migrations where version in('20261017125853','20261017130229')),
 'enabledBusinesses',(select count(*) from public.native_production_cohort_v1 where enabled),
 'otherBusinessesEnabled',(select count(*) from public.native_production_cohort_v1 where enabled and negocio_id<>'864d08e5-2975-4b2d-a1e2-ba5a14f3d677'),
 'cohortPrivate',not has_table_privilege('authenticated','public.native_production_cohort_v1','INSERT,UPDATE,DELETE'),
 'directActivationDenied',not has_function_privilege('authenticated','public.native_sales_activate_v1(uuid,uuid,uuid,bigint,text,uuid,text,text)','EXECUTE'),
 'fiscalDenied',not has_function_privilege('authenticated','public.native_sales_fiscal_allocate_v1(jsonb,text)','EXECUTE'),
 'anonymousRegistrationDenied',not has_function_privilege('anon','public.native_registrar_instalacion_v1(uuid,uuid,uuid,uuid,text,uuid)','EXECUTE'),
 'noQaLicenses',to_regclass('public.native_staging_licenses_v1') is null,
 'noNativeFiscalRequests',to_regclass('public.native_fiscal_requests_v2') is null,
 'membershipRequiresCohort',strpos(pg_get_functiondef('public.native_member_role_v1(uuid)'::regprocedure),'native_production_cohort_v1')>0,
 'nativeOperations',(select count(*) from public.native_sales_ledger_v1),
 'installations',(select count(*) from public.native_installations_v1),
 'operationalCutovers',(select count(*) from public.native_sales_mode_v1)
) as verification;
rollback;
