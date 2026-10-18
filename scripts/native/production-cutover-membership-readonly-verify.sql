begin read only;
do $verify$
declare source text;
begin
 if pg_catalog.has_function_privilege('authenticated','public.native_web_resolution_missing_ids_v1(jsonb,jsonb)','EXECUTE')
 or pg_catalog.has_function_privilege('anon','public.native_web_resolution_missing_ids_v1(jsonb,jsonb)','EXECUTE') then raise exception 'MEMBERSHIP_HELPER_EXPOSED';end if;
 source:=pg_catalog.pg_get_functiondef('public.native_web_cutover_validated_v1(text,text,boolean)'::regprocedure);
 if pg_catalog.strpos(source,'missing_ids:=public.native_web_resolution_missing_ids_v1(t->''rows'',all_rows->table_name);')=0
 or pg_catalog.strpos(source,'RESOLUTION_SOURCE_PARENT_MISSING')=0
 or pg_catalog.strpos(source,'RESOLUTION_NATIVE_ALREADY_STARTED')=0 then raise exception 'MEMBERSHIP_GUARD_MISSING';end if;
end $verify$;
select version from supabase_migrations.schema_migrations where version='20261018222701';
rollback;
