-- REVIEW ONLY. Explicit production project must be selected by the caller.
-- No secrets, sales/customer rows, changes, registrations or activation.
begin read only;
set local statement_timeout='20s';
set local lock_timeout='2s';

select 'candidate_businesses' as section,coalesce(jsonb_agg(jsonb_build_object(
 'id',id,'name',nombre,'planActive',to_jsonb(n)->'plan_activo',
 'planTier',to_jsonb(n)->'plan_tier','accessUntil',to_jsonb(n)->'acceso_hasta',
 'trialUntil',to_jsonb(n)->'trial_hasta')),'[]'::jsonb) as rows
from public.negocios n where lower(nombre) like '%pica%'
union all
select 'schema_columns' as section,coalesce(jsonb_agg(jsonb_build_object(
 'table',table_name,'column',column_name,'type',data_type,
 'udt',udt_name,'nullable',is_nullable,'default',column_default)
 order by table_name,ordinal_position),'[]'::jsonb) as rows
from information_schema.columns where table_schema='public' and
 (table_name like 'native\_%' escape '\' or table_name in(
 'negocios','usuarios_negocio','sucursales','productos','inventario_sucursales',
 'clientes','transacciones_fiado','ventas','venta_detalles','cajas','cortes_caja',
 'gastos','devoluciones','devolucion_detalles','reparaciones','apartados',
 'garantias','seriales','composiciones'))
union all
select 'native_functions' as section,coalesce(jsonb_agg(jsonb_build_object(
 'signature',p.oid::regprocedure::text,'definitionHash',md5(pg_get_functiondef(p.oid)),
 'securityDefiner',p.prosecdef,'acl',p.proacl::text)
 order by p.oid::regprocedure::text),'[]'::jsonb) as rows
from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
where ns.nspname='public' and p.prokind='f' and p.proname like 'native\_%' escape '\'
union all
select 'constraints' as section,coalesce(jsonb_agg(jsonb_build_object(
 'table',c.conrelid::regclass::text,'name',c.conname,
 'definition',pg_get_constraintdef(c.oid)) order by c.conrelid::regclass::text,c.conname),'[]'::jsonb) as rows
from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace ns on ns.oid=t.relnamespace
where ns.nspname='public' and (t.relname like 'native\_%' escape '\' or t.relname in(
 'negocios','usuarios_negocio','productos','inventario_sucursales','ventas','venta_detalles',
 'clientes','transacciones_fiado','cajas','cortes_caja','reparaciones','apartados','seriales'))
union all
select 'migration_history_present' as section,
 jsonb_build_object('present',to_regclass('supabase_migrations.schema_migrations') is not null) as rows;
rollback;
