-- SELECT ONLY. Run only in VentaRD Staging blzzinivvzadqjbnpsre.
-- Metadata of the newly approved migration; no commercial rows or RPC execution.
select pg_catalog.jsonb_build_object(
 'tables',(
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',c.relname,'rlsEnabled',c.relrowsecurity,'rlsForced',c.relforcerowsecurity) order by c.relname)
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in('native_staging_licenses_v1','native_installations_v1','native_actor_sequences_v1','native_registration_requests_v1')
 ),
 'policies',(
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table',tablename,'name',policyname,'roles',roles,'command',cmd,'using',qual,'check',with_check) order by tablename,policyname)
  from pg_catalog.pg_policies where schemaname='public' and tablename in('native_staging_licenses_v1','native_installations_v1','native_actor_sequences_v1','native_registration_requests_v1')
 ),
 'tableGrants',(
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table',table_name,'role',grantee,'privilege',privilege_type) order by table_name,grantee,privilege_type)
  from information_schema.role_table_grants where table_schema='public' and table_name in('native_staging_licenses_v1','native_installations_v1','native_actor_sequences_v1','native_registration_requests_v1')
 ),
 'functions',(
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',p.proname,'args',pg_catalog.pg_get_function_identity_arguments(p.oid),'securityDefiner',p.prosecdef,'config',p.proconfig,'acl',coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))::text,'definition',pg_catalog.pg_get_functiondef(p.oid)) order by p.proname)
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in('native_member_role_v1','native_registrar_instalacion_v1')
 ),
 'constraints',(
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table',c.relname,'name',k.conname,'type',k.contype,'definition',pg_catalog.pg_get_constraintdef(k.oid)) order by c.relname,k.conname)
  from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid=k.conrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in('native_staging_licenses_v1','native_installations_v1','native_actor_sequences_v1','native_registration_requests_v1')
 )
) as native_access_metadata;
