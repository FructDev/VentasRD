-- Metadata and current Pica pilot state only; never applies a cutover,
-- creates a context, impersonates an actor or changes commercial data.
begin read only;
do $verify$
declare f text;
begin
 if not exists(select 1 from public.native_production_cohort_v1 where negocio_id='864d08e5-2975-4b2d-a1e2-ba5a14f3d677' and enabled)
 or exists(select 1 from public.native_production_cohort_v1 where negocio_id<>'864d08e5-2975-4b2d-a1e2-ba5a14f3d677' and enabled) then raise exception 'PICA_ONLY_PRODUCTION_COHORT_REQUIRED';end if;
 foreach f in array array['native_web_resolution_canonical_v1(jsonb,integer)','native_web_resolution_bulk_decode_v1(jsonb,integer)','native_web_cutover_validated_v1(text,text,boolean)','native_web_resolution_assembled_v1(jsonb,uuid,text,integer,uuid)'] loop
  if pg_catalog.has_function_privilege('authenticated','public.'||f,'EXECUTE') or pg_catalog.has_function_privilege('anon','public.'||f,'EXECUTE') then raise exception 'BULK_HELPER_EXPOSED';end if;
 end loop;
 foreach f in array array['native_web_legacy_branch_stock_v1','native_web_legacy_catalogue_rows_v1'] loop
  if not (select relrowsecurity from pg_class where oid=to_regclass('public.'||f)) or pg_catalog.has_table_privilege('authenticated','public.'||f,'SELECT,INSERT,UPDATE,DELETE') or pg_catalog.has_table_privilege('anon','public.'||f,'SELECT,INSERT,UPDATE,DELETE') then raise exception 'BULK_ARCHIVE_EXPOSED';end if;
 end loop;
 if not exists(select 1 from pg_proc where oid='public.native_web_resolution_commit_v1(jsonb,uuid,text,integer)'::regprocedure and proconfig @> array['statement_timeout=60s']) then raise exception 'BULK_BUDGET_MISSING';end if;
 if strpos(pg_get_functiondef('public.native_web_cutover_v1(text,text)'::regprocedure),'native_web_cutover_validated_v1')=0 or strpos(pg_get_functiondef('public.native_web_cutover_validated_v1(text,text,boolean)'::regprocedure),'RESOLUTION_NATIVE_ALREADY_STARTED')=0 then raise exception 'BULK_FENCE_MISSING';end if;
end $verify$;
select jsonb_build_object('projectRef','oxbekqoecunsbjheqgqg','tenantId','864d08e5-2975-4b2d-a1e2-ba5a14f3d677',
 'active',(select count(*) from native_sales_mode_v1 where negocio_id='864d08e5-2975-4b2d-a1e2-ba5a14f3d677'),
 'nativeOperations',(select count(*) from native_sales_ledger_v1 where negocio_id='864d08e5-2975-4b2d-a1e2-ba5a14f3d677'),
 'archivedBranchRows',(select count(*) from native_web_legacy_branch_stock_v1 where negocio_id='864d08e5-2975-4b2d-a1e2-ba5a14f3d677'),
 'historicalCatalogueRows',(select count(*) from native_web_legacy_catalogue_rows_v1 where negocio_id='864d08e5-2975-4b2d-a1e2-ba5a14f3d677')) status;
rollback;
