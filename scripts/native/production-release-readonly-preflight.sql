-- Schema metadata ONLY for the legacy stock journal dependency. No row data,
-- fiscal metadata, mutations, business activation or migrations.
begin transaction isolation level repeatable read read only;
set local statement_timeout='15s';
select jsonb_build_object(
 'protocol','ventard.production.release.preflight.1',
 'tableExists',to_regclass('public.movimientos_stock') is not null,
 'columns',coalesce((select jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'udt',udt_name,'nullable',is_nullable,'default',column_default) order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='movimientos_stock'),'[]'::jsonb),
 'constraints',coalesce((select jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid))) from pg_constraint where conrelid=to_regclass('public.movimientos_stock')),'[]'::jsonb)
) as result;
rollback;
