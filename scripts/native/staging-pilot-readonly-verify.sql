begin transaction isolation level repeatable read read only;
do $verify$
declare n constant uuid:='96000000-0000-4000-8000-000000000003';
 b constant uuid:='96000003-0000-4000-8000-000000000003';
 owner_id constant uuid:='a1d0532d-df26-43bf-b8b2-5a99de7ab101';
begin
 if not exists(select 1 from public.negocios where id=n and "dueño_id"=owner_id and nota_operador='STAGING_NEW_PILOT_V1')
 or not exists(select 1 from public.sucursales where id=b and negocio_id=n)
 or not exists(select 1 from public.native_staging_licenses_v1 where negocio_id=n and plan_active and plan_tier='pro' and access_until_ms>extract(epoch from pg_catalog.statement_timestamp())*1000)
 then raise exception 'PILOT_SETUP_INVALID';end if;
 if exists(select 1 from public.ncf_secuencias where negocio_id=n) then raise exception 'PILOT_NCF_MUST_REMAIN_ABSENT';end if;
 if pg_catalog.has_function_privilege('anon','public.native_member_role_v1(uuid)','EXECUTE')
 or not pg_catalog.has_function_privilege('authenticated','public.native_member_role_v1(uuid)','EXECUTE')
 or pg_catalog.has_function_privilege('authenticated','public.native_team_invite_accept_v1(uuid,uuid)','EXECUTE') then raise exception 'PILOT_ACL_INVALID';end if;
 perform pg_catalog.set_config('request.jwt.claim.sub',owner_id::text,true);
 execute 'set local role authenticated';
 if public.native_member_role_v1(n) is distinct from 'owner'
 or (select count(*) from public.native_staging_licenses_v1 where negocio_id=n)<>1
 or (select count(*) from public.negocios where id=n)<>1
 or (select count(*) from public.sucursales where id=b and negocio_id=n)<>1
 or (select count(*) from public.productos where negocio_id=n)<>12
 or (select count(*) from public.clientes where negocio_id=n)<>2
 then raise exception 'PILOT_OWNER_READ_DENIED';end if;
 execute 'reset role';
end $verify$;
select 'STAGING_PILOT_READONLY_PASS' as status,
 (select count(*) from public.productos where negocio_id='96000000-0000-4000-8000-000000000003') as products,
 (select sum(stock_actual) from public.inventario_sucursales where sucursal_id='96000003-0000-4000-8000-000000000003') as units,
 (select count(*) from public.clientes where negocio_id='96000000-0000-4000-8000-000000000003') as customers,
 (select count(*) from public.native_installations_v1 where negocio_id='96000000-0000-4000-8000-000000000003') as installations,
 (select count(*) from public.native_sales_ledger_v1 where negocio_id='96000000-0000-4000-8000-000000000003') as native_operations,
 (select count(*) from public.ncf_secuencias where negocio_id='96000000-0000-4000-8000-000000000003') as fiscal_ranges;
rollback;
