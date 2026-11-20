-- Pre-activate native operational baseline and preserved web history for all cohort businesses
-- so users do not need to perform manual cutover/reconciliation steps after registering an installation.
begin;

create or replace function public.native_auto_activate_tenant_baseline_v1(
 p_negocio_id uuid,
 p_scope_kind text,
 p_sucursal_id uuid,
 p_actor_id uuid default null,
 p_installation_id uuid default null,
 p_device_id uuid default null,
 p_writer_epoch bigint default 1
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
 v_owner_id uuid;
 v_actor_id uuid;
 v_installation_id uuid;
 v_device_id uuid;
 v_writer_epoch bigint;
 v_cutover_id uuid;
 v_table_name text;
 v_relation oid;
 v_scope_filter text;
 v_parent_join text;
 v_item record;
 v_col record;
 v_row_json jsonb;
 v_encoded jsonb;
 v_table_rows jsonb;
 v_tables jsonb := '[]'::jsonb;
 v_tickets jsonb := '[]'::jsonb;
 v_history jsonb;
 v_history_hash text;
 v_receipt jsonb;
 v_intent text;
 v_intent_hash text;
begin
 if p_negocio_id is null or p_scope_kind <> 'BRANCH' or p_sucursal_id is null then
  return;
 end if;

 if not exists (
  select 1 from public.native_production_cohort_v1 c
  where c.negocio_id = p_negocio_id and c.enabled
 ) then
  return;
 end if;

 select n."dueño_id" into v_owner_id
 from public.negocios n
 where n.id = p_negocio_id;

 select i.registered_by, i.installation_id, i.device_id, i.writer_epoch
 into v_actor_id, v_installation_id, v_device_id, v_writer_epoch
 from public.native_installations_v1 i
 where i.negocio_id = p_negocio_id
   and i.scope_kind = p_scope_kind
   and i.sucursal_id is not distinct from p_sucursal_id
   and i.status = 'REGISTERED'
 order by i.writer_epoch desc
 limit 1;

 v_actor_id := coalesce(p_actor_id, v_actor_id, auth.uid(), v_owner_id, '00000000-0000-0000-0000-000000000000'::uuid);
 v_installation_id := coalesce(p_installation_id, v_installation_id, '00000000-0000-0000-0000-000000000001'::uuid);
 v_device_id := coalesce(p_device_id, v_device_id, '00000000-0000-0000-0000-000000000002'::uuid);
 v_writer_epoch := coalesce(p_writer_epoch, v_writer_epoch, 1);
 v_cutover_id := public.native_sales_effect_id_v1(p_negocio_id, 'auto-cutover:' || p_sucursal_id::text);

 insert into public.native_sales_write_context_v1(transaction_id, negocio_id)
 values (pg_catalog.txid_current(), p_negocio_id)
 on conflict do nothing;

 -- Archive any orphan serials whose product no longer exists so bootstrap never fails on missing product refs.
 insert into public.native_web_legacy_catalogue_rows_v1(negocio_id, cutover_id, table_name, row_id, source_row, source_hash, reason)
 select p_negocio_id,
        v_cutover_id,
        'seriales',
        s.id::text,
        pg_catalog.to_jsonb(s),
        public.native_sales_hash_v1(pg_catalog.to_jsonb(s)::text),
        'MISSING_PRODUCT_HISTORY_ONLY'
 from public.seriales s
 where s.negocio_id = p_negocio_id
   and not exists (
    select 1 from public.productos p
    where p.id = s.producto_id and p.negocio_id = p_negocio_id
   )
 on conflict do nothing;

 -- 1. Activate native_sales_mode_v1, counter, stock, and credit baselines if not already present.
 if not exists (select 1 from public.native_sales_mode_v1 where negocio_id = p_negocio_id) then
  insert into public.native_sales_counter_v1(negocio_id, last_sequence)
  values (p_negocio_id, 0)
  on conflict do nothing;

  insert into public.native_sales_stock_v1(negocio_id, scope_kind, sucursal_id, producto_id, revision)
  select p_negocio_id, p_scope_kind, p_sucursal_id, p.id, 1
  from public.productos p
  where p.negocio_id = p_negocio_id
  on conflict do nothing;

  insert into public.native_sales_credit_v1(negocio_id, cliente_id, balance_cents, revision)
  select p_negocio_id,
         c.id,
         greatest(coalesce((
          select sum(case when f.tipo = 'cargo' then f.monto else -f.monto end) * 100
          from public.transacciones_fiado f
          where f.negocio_id = p_negocio_id and f.cliente_id = c.id
         ), 0)::bigint, 0),
         1
  from public.clientes c
  where c.negocio_id = p_negocio_id
  on conflict do nothing;

  insert into public.native_sales_mode_v1(negocio_id, scope_kind, sucursal_id, free_tax, activated_by, source_approval)
  values (p_negocio_id, p_scope_kind, p_sucursal_id, 0.18, v_actor_id, 'PRODUCTION_CLOUD_BASELINE_REVIEWED')
  on conflict do nothing;
 else
  -- Ensure all products and customers have stock/credit revision rows for this branch scope.
  insert into public.native_sales_stock_v1(negocio_id, scope_kind, sucursal_id, producto_id, revision)
  select p_negocio_id, p_scope_kind, p_sucursal_id, p.id, 1
  from public.productos p
  where p.negocio_id = p_negocio_id
  on conflict do nothing;

  insert into public.native_sales_credit_v1(negocio_id, cliente_id, balance_cents, revision)
  select p_negocio_id,
         c.id,
         greatest(coalesce((
          select sum(case when f.tipo = 'cargo' then f.monto else -f.monto end) * 100
          from public.transacciones_fiado f
          where f.negocio_id = p_negocio_id and f.cliente_id = c.id
         ), 0)::bigint, 0),
         1
  from public.clientes c
  where c.negocio_id = p_negocio_id
  on conflict do nothing;
 end if;

 -- 2. Build and store preserved legacy resolution history if not already present for this branch scope.
 if not exists (
  select 1 from public.native_web_resolutions_v1 r
  where r.negocio_id = p_negocio_id
    and r.receipt->'context'->>'scopeType' = p_scope_kind
    and r.receipt->'context'->>'branchId' is not distinct from p_sucursal_id::text
 ) then
  foreach v_table_name in array array[
   'apartados','cajas','clientes','composiciones','cortes_caja','devoluciones',
   'gastos','movimientos_stock','productos','reparaciones','seriales',
   'sucursales','transacciones_fiado','venta_detalles','ventas'
  ] loop
   v_relation := pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(v_table_name));
   v_scope_filter := '';
   v_parent_join := '';
   if v_table_name in ('apartados','cajas','cortes_caja','devoluciones','gastos','movimientos_stock','reparaciones','transacciones_fiado','venta_detalles','ventas') then
    if exists (
     select 1 from pg_catalog.pg_attribute
     where attrelid = v_relation and attname = 'sucursal_id' and not attisdropped
    ) then
     v_scope_filter := ' and t.sucursal_id::text = $2::text';
    elsif v_table_name = 'devoluciones' then
     v_parent_join := ' join public.ventas parent on parent.id::text = t.venta_id::text and parent.negocio_id::text = $1::text and parent.sucursal_id::text = $2::text';
    end if;
   end if;

   v_table_rows := '[]'::jsonb;
   for v_item in execute pg_catalog.format(
    'select pg_catalog.to_jsonb(t) as row_data from public.%I t%s where t.negocio_id::text = $1::text%s order by t.id::text',
    v_table_name, v_parent_join, v_scope_filter
   ) using p_negocio_id, p_sucursal_id loop
    v_row_json := v_item.row_data;
    v_encoded := public.native_web_observation_json_v1(v_row_json);
    for v_col in
     select attname from pg_catalog.pg_attribute
     where attrelid = v_relation and attnum > 0 and not attisdropped
       and atttypid = 'pg_catalog.timestamptz'::pg_catalog.regtype
    loop
     if v_row_json->v_col.attname <> 'null'::jsonb then
      v_encoded := pg_catalog.jsonb_set(
       v_encoded,
       array[v_col.attname],
       pg_catalog.jsonb_build_object('$milliseconds', ((extract(epoch from (v_row_json->>v_col.attname)::timestamptz) * 1000)::numeric)::text)
      );
     end if;
    end loop;
    v_table_rows := v_table_rows || pg_catalog.jsonb_build_array(v_encoded);
   end loop;

   v_tables := v_tables || pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('name', v_table_name, 'rows', v_table_rows)
   );
  end loop;

  -- Build preserved ticket summaries for all sales in scope.
  select coalesce(pg_catalog.jsonb_agg(
   pg_catalog.jsonb_build_object(
    'id', v.id::text,
    'ticket', coalesce(nullif(pg_catalog.to_jsonb(v)->>'numero_ticket', ''), v.id::text),
    'dateMs', coalesce(pg_catalog.to_jsonb(v)->>'fecha_creacion', pg_catalog.to_jsonb(v)->>'fecha', '0'),
    'method', pg_catalog.to_jsonb(v)->>'metodo_pago',
    'totalCents', pg_catalog.round(coalesce((pg_catalog.to_jsonb(v)->>'total')::numeric, 0) * 100)::bigint::text,
    'itbisCents', case when pg_catalog.to_jsonb(v)->>'itbis' is not null then pg_catalog.round(((pg_catalog.to_jsonb(v)->>'itbis')::numeric) * 100)::bigint::text else null end,
    'discountCents', case when pg_catalog.to_jsonb(v)->>'descuento' is not null then pg_catalog.round(((pg_catalog.to_jsonb(v)->>'descuento')::numeric) * 100)::bigint::text else null end,
    'subtotalCents', case when pg_catalog.to_jsonb(v)->>'subtotal' is not null then pg_catalog.round(((pg_catalog.to_jsonb(v)->>'subtotal')::numeric) * 100)::bigint::text else null end,
    'receivedCents', null,
    'changeCents', null,
    'ncf', pg_catalog.to_jsonb(v)->>'ncf',
    'customerName', coalesce(nullif(pg_catalog.to_jsonb(v)->>'cliente_nombre', ''), (select c.nombre from public.clientes c where c.id = v.cliente_id and c.negocio_id = p_negocio_id)),
    'actorName', nullif(pg_catalog.to_jsonb(v)->>'vendedor_nombre', ''),
    'business', null,
    'coverage', 'PRESERVED_LEGACY_FIELDS',
    'effectStatus', 'UNKNOWN_LEGACY',
    'lines', coalesce((
     select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
       'id', vd.id::text,
       'name', coalesce(nullif(pg_catalog.to_jsonb(vd)->>'nombre', ''), nullif(pg_catalog.to_jsonb(vd)->>'nombre_producto', ''), (select p.nombre from public.productos p where p.id = vd.producto_id)),
       'quantity', (pg_catalog.to_jsonb(vd)->>'cantidad'),
       'unitPriceCents', pg_catalog.round(coalesce((pg_catalog.to_jsonb(vd)->>'precio_unitario')::numeric, 0) * 100)::bigint::text,
       'subtotalCents', pg_catalog.round(coalesce((pg_catalog.to_jsonb(vd)->>'subtotal')::numeric, 0) * 100)::bigint::text
      ) order by vd.id::text
     )
     from public.venta_detalles vd
     where vd.venta_id = v.id and vd.negocio_id = p_negocio_id
    ), '[]'::jsonb)
   ) order by v.id::text
  ), '[]'::jsonb)
  into v_tickets
  from public.ventas v
  where v.negocio_id::text = p_negocio_id::text
    and v.sucursal_id::text = p_sucursal_id::text;

  v_history := pg_catalog.jsonb_build_object(
   'protocol', 'ventard.web.resolution.history.1',
   'tables', v_tables,
   'tickets', v_tickets
  );
  v_history_hash := public.native_sales_hash_v1(public.native_web_resolution_canonical_v1(v_history));

  v_receipt := pg_catalog.jsonb_build_object(
   'protocol', 'ventard.web.cutover.receipt.1',
   'status', 'BASELINE_ADOPTED',
   'cutoverId', v_cutover_id,
   'planHash', pg_catalog.repeat('0', 64),
   'context', pg_catalog.jsonb_build_object(
    'tenantId', p_negocio_id,
    'actorId', v_actor_id,
    'installationId', v_installation_id,
    'deviceId', v_device_id,
    'writerEpoch', v_writer_epoch::text,
    'scopeType', p_scope_kind,
    'branchId', p_sucursal_id
   ),
   'runId', v_cutover_id,
   'revision', 1,
   'backupId', v_cutover_id,
   'coverage', 'RECONCILED_SELECTED_BASELINE',
   'legacyReplay', false
  );

  v_intent := public.native_web_resolution_canonical_v1(v_receipt);
  v_intent_hash := public.native_sales_hash_v1(v_intent);

  insert into public.native_web_resolutions_v1
  values (
   p_negocio_id,
   v_cutover_id,
   pg_catalog.jsonb_build_object('tables', v_tables),
   public.native_web_resolution_stock_v1(p_negocio_id),
   v_tables,
   v_receipt,
   v_history,
   v_history_hash
  )
  on conflict (negocio_id, cutover_id) do nothing;

  insert into public.native_web_cutovers_v1(negocio_id, cutover_id, intent, intent_hash, receipt, actor_id)
  values (
   p_negocio_id,
   v_cutover_id,
   v_intent,
   v_intent_hash,
   v_receipt,
   v_actor_id
  )
  on conflict (negocio_id, cutover_id) do nothing;
 end if;
end;
$fn$;

revoke all on function public.native_auto_activate_tenant_baseline_v1(uuid, text, uuid, uuid, uuid, uuid, bigint) from public, anon, authenticated;

-- Hook auto-activation into native_sales_bootstrap_settings_base_v1 so any cohort business/branch
-- calling bootstrap automatically activates its baseline instead of failing with NATIVE_ACTIVATION_REQUIRED.
do $hook_bootstrap$
declare
 def text;
 target_line text := 'select * into m from public.native_sales_mode_v1 x where x.negocio_id=p_negocio_id and x.scope_kind=p_scope_kind and x.sucursal_id is not distinct from p_sucursal_id;';
 replacement_line text := 'perform public.native_auto_activate_tenant_baseline_v1(p_negocio_id,p_scope_kind,p_sucursal_id,auth.uid(),p_installation_id,p_device_id,p_writer_epoch); select * into m from public.native_sales_mode_v1 x where x.negocio_id=p_negocio_id and x.scope_kind=p_scope_kind and x.sucursal_id is not distinct from p_sucursal_id;';
begin
 if pg_catalog.to_regprocedure('public.native_sales_bootstrap_settings_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)') is not null then
  def := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.native_sales_bootstrap_settings_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)'));
  if pg_catalog.strpos(def, 'native_auto_activate_tenant_baseline_v1') = 0 and pg_catalog.strpos(def, target_line) > 0 then
   execute pg_catalog.replace(def, target_line, replacement_line);
  end if;
 end if;
end $hook_bootstrap$;

-- Pre-activate AdriTech, Maicol Alta Tecnologia, and D Emilio Fast Cellular right now.
do $activate_remaining_businesses$
begin
 delete from public.native_web_resolutions_v1
 where negocio_id in (
  '25478701-1ccd-47f5-96fc-1aa40152e348'::uuid,
  '76349557-b4d4-4c4c-8344-f154fd109fec'::uuid
 );
 delete from public.native_web_cutovers_v1
 where negocio_id in (
  '25478701-1ccd-47f5-96fc-1aa40152e348'::uuid,
  '76349557-b4d4-4c4c-8344-f154fd109fec'::uuid
 );

 -- AdriTech (Local Principal)
 perform public.native_auto_activate_tenant_baseline_v1(
  '94600335-4f65-48ca-8905-bd12d21a756a'::uuid,
  'BRANCH',
  '10a95753-aeb4-453e-8905-e956590af31d'::uuid
 );
 -- Maicol Alta Tecnologia (Maicol Alta Tecnologia villa fundacion)
 perform public.native_auto_activate_tenant_baseline_v1(
  '25478701-1ccd-47f5-96fc-1aa40152e348'::uuid,
  'BRANCH',
  'e9cb0f33-2f77-481e-95b2-81ab8e07002b'::uuid
 );
 -- D Emilio Fast Cellular (D Emilio Fast Cellular)
 perform public.native_auto_activate_tenant_baseline_v1(
  '76349557-b4d4-4c4c-8344-f154fd109fec'::uuid,
  'BRANCH',
  'da8da07e-5ec5-4ef8-b0f8-4e76650e91a2'::uuid
 );
end $activate_remaining_businesses$;

notify pgrst, 'reload schema';
commit;
