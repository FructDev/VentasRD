-- 1. Purge inactive/non-existent businesses and their auth sessions to stop background sync egress.
-- 2. Enable remaining active businesses in native_production_cohort_v1 and align native_entitlements_v1.
-- 3. Prepare pre-cutover businesses (AdriTech, Maicol Alta Tecnologia, D Emilio Fast Cellular) for clean cutover.
begin;

do $purge_and_enable$
declare
 dead_tenants uuid[] := array[
  '0dd886cf-c834-45e1-af66-7d5a0051402d'::uuid, -- Goodclean
  '2e8abcfa-6de4-477c-84c0-9c7ed568480b'::uuid, -- Variedades luxi
  'a4f86e57-44df-4bf9-8afa-640fd63da1b4'::uuid, -- D Emilio Fast Cellular (empty duplicate)
  'b5c07279-62fc-4be7-a687-7fdc1e925730'::uuid, -- El varón la solución
  '5b349fe3-ac0d-477c-87a3-e446bf42bbfd'::uuid, -- smartphone Araujo
  '4ab67ce6-8ee7-4299-a853-8d95974a53ac'::uuid  -- Actiavocel
 ];
 dead_users uuid[];
 rec record;
 tab text;
 col record;
 at_ms bigint := floor(extract(epoch from transaction_timestamp()) * 1000);
begin
 -- Collect users exclusively tied to dead_tenants (never touching users of active businesses).
 select coalesce(array_agg(distinct u_id), array[]::uuid[])
 into dead_users
 from (
  select n."dueño_id" as u_id from public.negocios n where n.id = any(dead_tenants) and n."dueño_id" is not null
  union
  select un.user_id as u_id from public.usuarios_negocio un where un.negocio_id = any(dead_tenants) and un.user_id is not null
 ) candidates
 where not exists (
  select 1 from public.negocios active_n
  where active_n.id <> all(dead_tenants) and active_n."dueño_id" = candidates.u_id
 )
 and not exists (
  select 1 from public.usuarios_negocio active_un
  where active_un.negocio_id <> all(dead_tenants) and active_un.user_id = candidates.u_id
 );

 -- Authorize write context for any triggers on legacy tables before deleting dead tenants.
 if to_regclass('public.native_sales_write_context_v1') is not null then
  insert into public.native_sales_write_context_v1(transaction_id, negocio_id)
  select pg_catalog.txid_current(), unnest(dead_tenants)
  on conflict do nothing;
 end if;

 -- Delete child rows without direct negocio_id column first.
 if to_regclass('public.detalles_ventas') is not null then
  delete from public.detalles_ventas dv
  where exists (
   select 1 from public.ventas v
   where v.id = dv.venta_id and v.negocio_id::text = any(select unnest(dead_tenants)::text)
  )
  or exists (
   select 1 from public.productos p
   where p.id = dv.producto_id and p.negocio_id = any(dead_tenants)
  );
 end if;

 delete from public.inventario_sucursales i
 where exists (
  select 1 from public.sucursales s where s.id = i.sucursal_id and s.negocio_id = any(dead_tenants)
 )
 or exists (
  select 1 from public.productos p where p.id = i.producto_id and p.negocio_id = any(dead_tenants)
 );

 if to_regclass('public.inventario_operaciones_v2') is not null then
  alter table public.inventario_operaciones_v2 disable trigger inventario_operaciones_v2_immutable;
  delete from public.inventario_operaciones_v2 where negocio_id = any(dead_tenants);
  alter table public.inventario_operaciones_v2 enable trigger inventario_operaciones_v2_immutable;
 end if;

 -- Delete from all public tables carrying negocio_id (excluding public.negocios and inventario_operaciones_v2).
 for rec in
  select c.table_name
  from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public'
    and c.column_name = 'negocio_id'
    and t.table_type = 'BASE TABLE'
    and c.table_name not in ('negocios', 'inventario_operaciones_v2')
  order by c.table_name
 loop
  execute format(
   'delete from public.%I where negocio_id::text = any(select unnest($1)::text)',
   rec.table_name
  ) using dead_tenants;
 end loop;

 -- Delete the inactive businesses themselves.
 delete from public.negocios where id = any(dead_tenants);

 -- Delete native registration requests and auth sessions/users for dead_users to cut any open browser sync loops.
 if coalesce(cardinality(dead_users), 0) > 0 then
  if to_regclass('public.native_registration_requests_v1') is not null then
   delete from public.native_registration_requests_v1 where actor_id = any(dead_users);
  end if;
  delete from auth.users where id = any(dead_users);
 end if;

 -- Clean up revoked refresh tokens to keep auth schema compact.
 delete from auth.refresh_tokens where revoked = true;

 -- Enroll all remaining active businesses into native_production_cohort_v1.
 insert into public.native_production_cohort_v1(negocio_id, enabled, approved_at)
 select n.id, true, now()
 from public.negocios n
 on conflict (negocio_id) do update
 set enabled = true,
     approved_at = coalesce(public.native_production_cohort_v1.approved_at, excluded.approved_at);

 -- Ensure plan_activo = true and valid acceso_hasta on all active businesses.
 update public.negocios
 set plan_activo = true,
     acceso_hasta = greatest(coalesce(acceso_hasta, 0), at_ms + 2592000000)
 where plan_activo is distinct from true
    or acceso_hasta is null
    or acceso_hasta < at_ms;

 -- Prepare pre-cutover businesses (those not yet in native_sales_mode_v1).
 for rec in
  select n.id as negocio_id,
         (select count(*) from public.sucursales s where s.negocio_id = n.id) as branch_count,
         (select s.id from public.sucursales s where s.negocio_id = n.id order by s.id limit 1) as single_branch_id
  from public.negocios n
  where not exists (select 1 from public.native_sales_mode_v1 m where m.negocio_id = n.id)
    and not exists (select 1 from public.native_sales_ledger_v1 l where l.negocio_id = n.id)
 loop
  -- Remove orphan branch stock rows pointing to deleted/foreign sucursal_id.
  delete from public.inventario_sucursales z
  using public.productos p
  where p.id = z.producto_id
    and p.negocio_id = rec.negocio_id
    and not exists (
     select 1 from public.sucursales s
     where s.id = z.sucursal_id and s.negocio_id = rec.negocio_id
    );

  -- Close stale legacy web open turns before cutover.
  update public.cajas
  set estado = 'cerrada',
      monto_cierre = coalesce(monto_cierre, 0),
      fecha_cierre = coalesce(fecha_cierre, at_ms),
      diferencia = case when monto_esperado is null then null else -monto_esperado end
  where negocio_id::text = rec.negocio_id::text
    and estado is distinct from 'cerrada';

  -- For single-branch businesses, align sucursal_id and branch inventory baseline.
  if rec.branch_count = 1 and rec.single_branch_id is not null then
   for tab in select unnest(array['apartados','cajas','clientes','cortes_caja','gastos','movimientos_stock','reparaciones','transacciones_fiado','venta_detalles','ventas']) loop
    select format_type(a.atttypid, a.atttypmod) as typ into col
    from pg_attribute a
    where a.attrelid = to_regclass('public.' || quote_ident(tab))
      and a.attname = 'sucursal_id'
      and not a.attisdropped;
    if found then
     execute format(
      'update public.%I set sucursal_id = $1::%s where negocio_id::text = $2 and sucursal_id::text is distinct from $1',
      tab, col.typ
     ) using rec.single_branch_id::text, rec.negocio_id::text;
    end if;
   end loop;

   insert into public.inventario_sucursales(id, sucursal_id, producto_id, stock_actual, stock_minimo, estado_sincronizacion, fecha_actualizacion)
   select gen_random_uuid(), rec.single_branch_id, p.id, coalesce(p.stock_actual, 0), coalesce(p.stock_minimo, 0), 1, at_ms
   from public.productos p
   where p.negocio_id = rec.negocio_id and p.tipo is distinct from 'combo'
   on conflict(sucursal_id, producto_id) do update
   set stock_actual = excluded.stock_actual,
       stock_minimo = excluded.stock_minimo,
       fecha_actualizacion = excluded.fecha_actualizacion
   where inventario_sucursales.stock_actual is distinct from excluded.stock_actual
      or inventario_sucursales.stock_minimo is distinct from excluded.stock_minimo;
  elsif rec.branch_count > 1 then
   -- Ensure every non-combo product has a branch stock row on each branch (0 when missing) and sum matches productos.stock_actual.
   insert into public.inventario_sucursales(id, sucursal_id, producto_id, stock_actual, stock_minimo, estado_sincronizacion, fecha_actualizacion)
   select gen_random_uuid(), s.id, p.id, 0, coalesce(p.stock_minimo, 0), 1, at_ms
   from public.productos p
   cross join public.sucursales s
   where p.negocio_id = rec.negocio_id
     and s.negocio_id = rec.negocio_id
     and p.tipo is distinct from 'combo'
   on conflict(sucursal_id, producto_id) do nothing;

   update public.productos p
   set stock_actual = coalesce((
    select sum(z.stock_actual)::integer
    from public.inventario_sucursales z
    join public.sucursales s on s.id = z.sucursal_id and s.negocio_id = rec.negocio_id
    where z.producto_id = p.id
   ), 0)
   where p.negocio_id = rec.negocio_id
     and p.tipo is distinct from 'combo'
     and p.stock_actual is distinct from coalesce((
      select sum(z.stock_actual)::integer
      from public.inventario_sucursales z
      join public.sucursales s on s.id = z.sucursal_id and s.negocio_id = rec.negocio_id
      where z.producto_id = p.id
     ), 0);
  end if;
 end loop;
end $purge_and_enable$;

-- Ensure native_entitlements_v1 treats a future acceso_hasta or trial_hasta as active even if SuperAdmin only updated timestamps.
create or replace view public.native_entitlements_v1 with(security_barrier=true) as
 select n.id as negocio_id,
        (coalesce(n.plan_activo, false)
         or (n.acceso_hasta is not null and n.acceso_hasta >= (floor(extract(epoch from clock_timestamp()) * 1000))::bigint)
         or (n.trial_hasta is not null and n.trial_hasta >= (floor(extract(epoch from clock_timestamp()) * 1000))::bigint)
        ) as plan_active,
        n.plan_tier,
        n.acceso_hasta as access_until_ms,
        n.trial_hasta as trial_until_ms
 from public.negocios n
 where public.native_member_role_v1(n.id) is not null;

revoke all on public.native_entitlements_v1 from public, anon, authenticated;
grant select on public.native_entitlements_v1 to authenticated;

-- Generalize orphan serial/branch-stock archival in native_web_cutover_validated_v1 and native_web_cutover_resolution_base_v1 for all cohort businesses.
do $generalize_orphan_archival$
declare
 def text;
 old_if text := 'if n=''864d08e5-2975-4b2d-a1e2-ba5a14f3d677''::uuid then';
 new_if text := 'if n in(select c0.negocio_id from public.native_production_cohort_v1 c0 where c0.enabled) then';
 old_activate text := 'perform public.native_legacy_services_adopt_v1(capture,ctx,op,(v->''serviceReservationsConfirmed''=''true''::jsonb));';
 new_activate text := 'insert into public.native_web_legacy_catalogue_rows_v1(negocio_id,cutover_id,table_name,row_id,source_row,source_hash,reason) select n,op,''seriales'',s.id::text,pg_catalog.to_jsonb(s),public.native_sales_hash_v1(pg_catalog.to_jsonb(s)::text),''MISSING_PRODUCT_HISTORY_ONLY'' from public.seriales s where s.negocio_id=n and not exists(select 1 from public.productos p where p.id=s.producto_id and p.negocio_id=n) on conflict do nothing; perform public.native_legacy_services_adopt_v1(capture,ctx,op,(v->''serviceReservationsConfirmed''=''true''::jsonb));';
begin
 if pg_catalog.to_regprocedure('public.native_web_cutover_validated_v1(text,text,boolean)') is not null then
  def := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.native_web_cutover_validated_v1(text,text,boolean)'));
  if pg_catalog.strpos(def, old_if) > 0 then
   execute pg_catalog.replace(def, old_if, new_if);
  end if;
 end if;

 if pg_catalog.to_regprocedure('public.native_web_cutover_resolution_base_v1(text,text)') is not null then
  def := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.native_web_cutover_resolution_base_v1(text,text)'));
  if pg_catalog.strpos(def, old_activate) > 0 and pg_catalog.strpos(def, 'MISSING_PRODUCT_HISTORY_ONLY') = 0 then
   execute pg_catalog.replace(def, old_activate, new_activate);
  end if;
 end if;
end $generalize_orphan_archival$;

notify pgrst, 'reload schema';
commit;
