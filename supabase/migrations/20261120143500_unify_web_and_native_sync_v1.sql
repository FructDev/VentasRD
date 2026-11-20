-- 1. Allow authenticated business members to continue writing from the Web App (ventard.vercel.app)
--    even after native_sales_mode_v1 is active, so multi-computer shops using Web + Native App stay in sync.
-- 2. Automatically synchronize productos <-> inventario_sucursales <-> native_sales_stock_v1 on every web write.
-- 3. Make aplicar_movimiento_stock_v2 and aplicar_movimiento_stock self-healing against missing branch rows
--    (SCOPE_NOT_INITIALIZED) and legacy projection drift (AUTHORITY_PROJECTION_DIVERGED).
begin;

create or replace function public.native_sales_fence_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $f$
declare
 j jsonb;
 n uuid;
 p uuid;
 items jsonb[];
begin
 items := case
  when TG_OP = 'UPDATE' then array[pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)]
  when TG_OP = 'DELETE' then array[pg_catalog.to_jsonb(OLD)]
  else array[pg_catalog.to_jsonb(NEW)]
 end;
 foreach j in array items loop
  if TG_TABLE_NAME = 'inventario_sucursales' then
   p := (j->>'producto_id')::uuid;
   select x.negocio_id into n from public.productos x where x.id = p;
  elsif TG_TABLE_NAME = 'composiciones' then
   p := (j->>'producto_padre_id')::uuid;
   select x.negocio_id into n from public.productos x where x.id = p;
  else
   n := nullif(j->>'negocio_id', '')::uuid;
  end if;

  if n is not null and exists (select 1 from public.native_sales_mode_v1 m where m.negocio_id = n) then
   if not exists (
    select 1 from public.native_sales_write_context_v1 w
    where w.transaction_id = pg_catalog.txid_current() and w.negocio_id = n
   )
   and coalesce(auth.role(), '') <> 'service_role'
   and current_user not in ('postgres', 'supabase_admin')
   and public.native_member_role_v1(n) is null
   then
    raise exception using errcode = '42501', message = 'NATIVE_LEGACY_WRITER_FENCED';
   end if;
  end if;
 end loop;
 if TG_OP = 'DELETE' then
  return OLD;
 else
  return NEW;
 end if;
end
$f$;

-- Trigger function to keep inventario_sucursales and native_sales_stock_v1 aligned whenever
-- public.productos is inserted or updated from the Web App.
create or replace function public.native_sync_product_to_branch_and_native_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $f$
declare
 v_branch_count integer;
 v_single_branch_id uuid;
 v_at_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
 if pg_trigger_depth() > 1
    or exists (
     select 1 from public.native_sales_write_context_v1 w
     where w.transaction_id = pg_catalog.txid_current() and w.negocio_id = NEW.negocio_id
    ) then
  return NEW;
 end if;

 select count(*)::integer, min(s.id::text)::uuid
 into v_branch_count, v_single_branch_id
 from public.sucursales s
 where s.negocio_id = NEW.negocio_id;

 if v_branch_count = 1 and v_single_branch_id is not null and coalesce(NEW.tipo, 'simple') <> 'combo' then
  insert into public.inventario_sucursales(
   id, sucursal_id, producto_id, stock_actual, stock_minimo, estado_sincronizacion, fecha_actualizacion
  )
  values (
   gen_random_uuid(),
   v_single_branch_id,
   NEW.id,
   coalesce(NEW.stock_actual, 0),
   coalesce(NEW.stock_minimo, 0),
   1,
   coalesce(NEW.fecha_actualizacion, v_at_ms)
  )
  on conflict (sucursal_id, producto_id) do update
  set stock_minimo = excluded.stock_minimo,
      fecha_actualizacion = greatest(coalesce(public.inventario_sucursales.fecha_actualizacion, 0), excluded.fecha_actualizacion)
  where public.inventario_sucursales.stock_minimo is distinct from excluded.stock_minimo;

  if exists (select 1 from public.native_sales_mode_v1 m where m.negocio_id = NEW.negocio_id) then
   insert into public.native_sales_stock_v1(negocio_id, scope_kind, sucursal_id, producto_id, revision)
   values (NEW.negocio_id, 'BRANCH', v_single_branch_id, NEW.id, 1)
   on conflict (negocio_id, scope_kind, sucursal_id, producto_id) do update
   set revision = public.native_sales_stock_v1.revision + 1
   where TG_OP = 'INSERT'
      or OLD.stock_actual is distinct from NEW.stock_actual
      or OLD.stock_minimo is distinct from NEW.stock_minimo
      or OLD.precio_venta is distinct from NEW.precio_venta
      or OLD.costo is distinct from NEW.costo
      or OLD.nombre is distinct from NEW.nombre
      or OLD.eliminado is distinct from NEW.eliminado;
  end if;
 end if;

 return NEW;
end
$f$;

drop trigger if exists native_sync_product_to_branch_and_native_v1 on public.productos;
create trigger native_sync_product_to_branch_and_native_v1
 after insert or update on public.productos
 for each row
 execute function public.native_sync_product_to_branch_and_native_v1();

-- Self-healing aplicar_movimiento_stock (v1 - used by web physical counts / conteos and legacy deltas).
create or replace function public.aplicar_movimiento_stock(
 p_id uuid,
 p_negocio_id uuid,
 p_sucursal_id uuid,
 p_producto_id uuid,
 p_delta numeric,
 p_tipo text,
 p_referencia_id uuid,
 p_fecha_creacion bigint,
 p_valor_absoluto numeric default null
) returns void
language plpgsql
security definer
set search_path = ''
as $f$
declare
 v_insertadas int;
 v_ahora bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
 v_branch_id uuid := p_sucursal_id;
 v_new_stock numeric;
begin
 if coalesce(auth.role(), '') <> 'service_role'
    and not public.es_miembro_del_negocio(p_negocio_id) then
  raise exception 'No autorizado para este negocio';
 end if;

 insert into public.native_sales_write_context_v1(transaction_id, negocio_id)
 values (pg_catalog.txid_current(), p_negocio_id)
 on conflict do nothing;

 if v_branch_id is null then
  select s.id into v_branch_id
  from public.sucursales s
  where s.negocio_id = p_negocio_id
  order by s.id
  limit 1;
 end if;

 insert into public.movimientos_stock(
  id, negocio_id, sucursal_id, producto_id, delta, valor_absoluto, tipo, referencia_id, fecha_creacion
 )
 values (
  p_id, p_negocio_id, v_branch_id, p_producto_id, coalesce(p_delta, 0), p_valor_absoluto, p_tipo, p_referencia_id, p_fecha_creacion
 )
 on conflict (id) do nothing;

 get diagnostics v_insertadas = row_count;
 if v_insertadas = 0 then
  return;
 end if;

 if p_valor_absoluto is not null then
  update public.productos
  set stock_actual = p_valor_absoluto,
      fecha_actualizacion = v_ahora
  where id = p_producto_id and negocio_id = p_negocio_id
  returning stock_actual into v_new_stock;
 else
  update public.productos
  set stock_actual = coalesce(stock_actual, 0) + coalesce(p_delta, 0),
      fecha_actualizacion = v_ahora
  where id = p_producto_id and negocio_id = p_negocio_id
  returning stock_actual into v_new_stock;
 end if;

 if v_branch_id is not null and v_new_stock is not null then
  insert into public.inventario_sucursales(
   id, sucursal_id, producto_id, stock_actual, stock_minimo, estado_sincronizacion, fecha_actualizacion
  )
  select gen_random_uuid(), v_branch_id, p_producto_id, v_new_stock, coalesce(p.stock_minimo, 0), 1, v_ahora
  from public.productos p
  where p.id = p_producto_id and p.negocio_id = p_negocio_id
  on conflict (sucursal_id, producto_id) do update
  set stock_actual = v_new_stock,
      fecha_actualizacion = v_ahora;

  if exists (select 1 from public.native_sales_mode_v1 m where m.negocio_id = p_negocio_id) then
   insert into public.native_sales_stock_v1(negocio_id, scope_kind, sucursal_id, producto_id, revision)
   values (p_negocio_id, 'BRANCH', v_branch_id, p_producto_id, 1)
   on conflict (negocio_id, scope_kind, sucursal_id, producto_id) do update
   set revision = public.native_sales_stock_v1.revision + 1;
  end if;
 end if;
end
$f$;

revoke execute on function public.aplicar_movimiento_stock(uuid, uuid, uuid, uuid, numeric, text, uuid, bigint, numeric) from public, anon;
grant execute on function public.aplicar_movimiento_stock(uuid, uuid, uuid, uuid, numeric, text, uuid, bigint, numeric) to authenticated, service_role;

-- Self-healing aplicar_movimiento_stock_v2:
-- 1. Authorizes native_sales_write_context_v1 so active native tenants can still sync from Web.
-- 2. Auto-initializes missing inventario_sucursales rows instead of rejecting with SCOPE_NOT_INITIALIZED.
-- 3. Auto-heals global vs branch projection drift instead of rejecting with AUTHORITY_PROJECTION_DIVERGED.
-- 4. Accepts ABSOLUTE operations even if expected_remote_sequence is stale.
-- 5. Mirrors the movement into public.movimientos_stock and bumps productos.fecha_actualizacion and native_sales_stock_v1.revision.
create or replace function public.aplicar_movimiento_stock_v2(
 p_contract_version integer,
 p_operation_id uuid,
 p_negocio_id uuid,
 p_sucursal_id uuid,
 p_producto_id uuid,
 p_effect_kind text,
 p_effect_value text,
 p_tipo text,
 p_referencia_id uuid,
 p_fecha_origen bigint,
 p_expected_remote_sequence bigint,
 p_payload_hash text,
 p_origin_device_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
 v_actor_id uuid;
 v_owner_id uuid;
 v_is_authorized boolean := false;
 v_authority text;
 v_effect_value_bigint bigint;
 v_effect_value_integer integer;
 v_effect_value_canonical text;
 v_canonical_payload text;
 v_computed_hash text;
 v_existing public.inventario_operaciones_v2%rowtype;
 v_global_before integer;
 v_global_minimo integer;
 v_global_after_bigint bigint;
 v_branch_before integer;
 v_branch_after_bigint bigint;
 v_branch_count bigint;
 v_branch_total bigint;
 v_stock_before integer;
 v_stock_after integer;
 v_current_sequence bigint := 0;
 v_next_sequence bigint;
 v_counter_id uuid;
 v_counter_exists boolean := false;
 v_applied_at timestamptz;
 v_warning_codes text[] := array[]::text[];
 v_affected_rows bigint;
 v_now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
 v_actor_id := auth.uid();
 if v_actor_id is null then
  return pg_catalog.jsonb_build_object(
   'contractVersion', '2.0',
   'outcome', 'REJECTED',
   'code', 'AUTH_REQUIRED'
  );
 end if;

 if p_contract_version is distinct from 2
    or p_operation_id is null
    or p_negocio_id is null
    or p_producto_id is null
    or p_fecha_origen is null
    or p_fecha_origen <= 0
    or p_payload_hash is null
    or p_payload_hash !~ '^[0-9a-f]{64}$'
    or p_origin_device_id is null
    or pg_catalog.length(pg_catalog.btrim(p_origin_device_id)) = 0
    or pg_catalog.length(p_origin_device_id) > 128
    or p_effect_kind is null
    or p_effect_kind not in ('DELTA', 'ABSOLUTE')
    or p_tipo is null
    or p_tipo not in (
     'venta', 'devolucion', 'entrada', 'merma', 'conteo',
     'importacion', 'reparacion', 'apartado'
    )
    or (p_effect_kind = 'DELTA' and p_expected_remote_sequence is not null)
    or (p_effect_kind = 'ABSOLUTE' and p_expected_remote_sequence is null)
    or (p_expected_remote_sequence is not null and p_expected_remote_sequence < 0)
 then
  return pg_catalog.jsonb_build_object(
   'contractVersion', '2.0',
   'outcome', 'REJECTED',
   'code', 'INVALID_EFFECT',
   'negocioId', p_negocio_id,
   'operationId', p_operation_id
  );
 end if;

 if p_effect_value is null or p_effect_value !~ '^[+-]?[0-9]+$' then
  return pg_catalog.jsonb_build_object(
   'contractVersion', '2.0',
   'outcome', 'REJECTED',
   'code', 'INVALID_EFFECT',
   'negocioId', p_negocio_id,
   'operationId', p_operation_id
  );
 end if;

 begin
  v_effect_value_bigint := p_effect_value::bigint;
 exception
  when invalid_text_representation or numeric_value_out_of_range then
   return pg_catalog.jsonb_build_object(
    'contractVersion', '2.0',
    'outcome', 'REJECTED',
    'code', 'INVALID_EFFECT',
    'negocioId', p_negocio_id,
    'operationId', p_operation_id
   );
 end;

 if v_effect_value_bigint < -2147483648 or v_effect_value_bigint > 2147483647 then
  return pg_catalog.jsonb_build_object(
   'contractVersion', '2.0',
   'outcome', 'REJECTED',
   'code', 'INVALID_EFFECT',
   'negocioId', p_negocio_id,
   'operationId', p_operation_id
  );
 end if;
 v_effect_value_integer := v_effect_value_bigint::integer;
 v_effect_value_canonical := v_effect_value_integer::text;
 v_authority := case when p_sucursal_id is null then 'GLOBAL' else 'BRANCH' end;

 v_canonical_payload :=
  '{"version":2'
  || ',"operationId":' || pg_catalog.to_json(p_operation_id::text)::text
  || ',"negocioId":' || pg_catalog.to_json(p_negocio_id::text)::text
  || ',"sucursalId":' || case
   when p_sucursal_id is null then 'null'
   else pg_catalog.to_json(p_sucursal_id::text)::text
  end
  || ',"productoId":' || pg_catalog.to_json(p_producto_id::text)::text
  || ',"effect":{"kind":' || pg_catalog.to_json(p_effect_kind)::text
  || ',"value":' || pg_catalog.to_json(v_effect_value_canonical)::text || '}'
  || ',"tipo":' || pg_catalog.to_json(p_tipo)::text
  || ',"referenciaId":' || case
   when p_referencia_id is null then 'null'
   else pg_catalog.to_json(p_referencia_id::text)::text
  end
  || ',"fechaOrigen":' || p_fecha_origen::text
  || ',"expectedRemoteSequence":' || case
   when p_expected_remote_sequence is null then 'null'
   else pg_catalog.to_json(p_expected_remote_sequence::text)::text
  end
  || '}';

 v_computed_hash := pg_catalog.encode(
  pg_catalog.sha256(pg_catalog.convert_to(v_canonical_payload, 'UTF8')),
  'hex'
 );
 if v_computed_hash is distinct from p_payload_hash then
  return pg_catalog.jsonb_build_object(
   'contractVersion', '2.0',
   'outcome', 'CONFLICT',
   'code', 'IDENTITY_PAYLOAD_MISMATCH',
   'negocioId', p_negocio_id,
   'operationId', p_operation_id,
   'payloadHash', p_payload_hash
  );
 end if;

 select n."dueño_id"
 into v_owner_id
 from public.negocios as n
 where n.id = p_negocio_id
 for share;
 if not found then
  return pg_catalog.jsonb_build_object(
   'contractVersion', '2.0',
   'outcome', 'REJECTED',
   'code', 'SCOPE_FORBIDDEN',
   'negocioId', p_negocio_id,
   'operationId', p_operation_id
  );
 end if;

 if v_owner_id = v_actor_id then
  v_is_authorized := true;
 else
  perform 1
  from public.usuarios_negocio as un
  where un.negocio_id = p_negocio_id
    and un.user_id = v_actor_id
    and un.activo = true
  for share;
  v_is_authorized := found;
 end if;
 if not v_is_authorized then
  return pg_catalog.jsonb_build_object(
   'contractVersion', '2.0',
   'outcome', 'REJECTED',
   'code', 'SCOPE_FORBIDDEN',
   'negocioId', p_negocio_id,
   'operationId', p_operation_id
  );
 end if;

 insert into public.native_sales_write_context_v1(transaction_id, negocio_id)
 values (pg_catalog.txid_current(), p_negocio_id)
 on conflict do nothing;

 perform pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
   'inventory-v2-operation:' || p_negocio_id::text || ':' || p_operation_id::text,
   0
  )
 );

 select ledger.*
 into v_existing
 from public.inventario_operaciones_v2 as ledger
 where ledger.negocio_id = p_negocio_id
   and ledger.operacion_id = p_operation_id;

 if found then
  return pg_catalog.jsonb_build_object(
   'contractVersion', '2.0',
   'outcome', 'ALREADY_APPLIED',
   'code', 'ALREADY_APPLIED',
   'negocioId', v_existing.negocio_id,
   'operationId', v_existing.operacion_id,
   'payloadHash', v_existing.payload_hash,
   'authority', v_existing.authority_kind,
   'productoId', v_existing.producto_id,
   'sucursalId', v_existing.sucursal_id,
   'remoteSequence', v_existing.remote_sequence::text,
   'stockBefore', v_existing.stock_before::text,
   'stockAfter', v_existing.stock_after::text,
   'appliedAt', v_existing.applied_at,
   'warningCodes', pg_catalog.to_jsonb(v_existing.warning_codes)
  );
 end if;

 if v_authority = 'BRANCH' then
  perform 1
  from public.sucursales as s
  where s.id = p_sucursal_id
    and s.negocio_id = p_negocio_id
  for share;
  if not found then
   return pg_catalog.jsonb_build_object(
    'contractVersion', '2.0',
    'outcome', 'REJECTED',
    'code', 'BRANCH_NOT_FOUND_OR_FORBIDDEN',
    'negocioId', p_negocio_id,
    'operationId', p_operation_id,
    'authority', v_authority,
    'productoId', p_producto_id,
    'sucursalId', p_sucursal_id
   );
  end if;
 end if;

 select coalesce(p.stock_actual, 0)::integer, coalesce(p.stock_minimo, 0)::integer
 into v_global_before, v_global_minimo
 from public.productos as p
 where p.id = p_producto_id
   and p.negocio_id = p_negocio_id
 for update;
 if not found then
  return pg_catalog.jsonb_build_object(
   'contractVersion', '2.0',
   'outcome', 'REJECTED',
   'code', 'PRODUCT_NOT_FOUND',
   'negocioId', p_negocio_id,
   'operationId', p_operation_id,
   'authority', v_authority,
   'productoId', p_producto_id,
   'sucursalId', p_sucursal_id
  );
 end if;

 if v_authority = 'GLOBAL' then
  v_stock_before := v_global_before;
 else
  -- Self-heal missing branch stock row (prevents SCOPE_NOT_INITIALIZED).
  insert into public.inventario_sucursales(
   id, sucursal_id, producto_id, stock_actual, stock_minimo, estado_sincronizacion, fecha_actualizacion
  )
  values (
   gen_random_uuid(), p_sucursal_id, p_producto_id, v_global_before, v_global_minimo, 1, v_now_ms
  )
  on conflict (sucursal_id, producto_id) do nothing;

  perform 1
  from public.inventario_sucursales as inventory
  where inventory.producto_id = p_producto_id
  order by inventory.sucursal_id
  for update;

  select coalesce(inventory.stock_actual, 0)::integer
  into v_branch_before
  from public.inventario_sucursales as inventory
  where inventory.sucursal_id = p_sucursal_id
    and inventory.producto_id = p_producto_id;

  select pg_catalog.count(*)::bigint,
         coalesce(pg_catalog.sum(inventory.stock_actual::bigint), 0::bigint)
  into v_branch_count, v_branch_total
  from public.inventario_sucursales as inventory
  where inventory.producto_id = p_producto_id;

  -- Self-heal projection drift (prevents AUTHORITY_PROJECTION_DIVERGED).
  if v_branch_total is distinct from v_global_before::bigint then
   v_global_before := v_branch_total::integer;
  end if;
  v_stock_before := v_branch_before;
 end if;

 -- If already recorded in legacy movimientos_stock before v2 ledger, treat as idempotent delta=0
 -- or record receipt without double-applying the stock change.
 if exists (
  select 1
  from public.movimientos_stock as legacy
  where legacy.id = p_operation_id
    and legacy.negocio_id = p_negocio_id
 ) then
  v_stock_after := v_stock_before;
 elsif p_effect_kind = 'DELTA' then
  v_stock_after := (v_stock_before::bigint + v_effect_value_bigint)::integer;
 else
  v_stock_after := v_effect_value_integer;
 end if;

 if v_stock_after < 0 and p_effect_kind = 'DELTA' and v_effect_value_integer < 0 then
  v_warning_codes := array['OFFLINE_OVERSELL']::text[];
 end if;

 if v_authority = 'BRANCH' then
  v_branch_after_bigint := v_stock_after::bigint;
  v_global_after_bigint := v_global_before::bigint + (v_branch_after_bigint - v_branch_before::bigint);
 end if;

 perform pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
   'inventory-v2-scope:' || p_negocio_id::text || ':'
   || v_authority || ':' || coalesce(p_sucursal_id::text, 'GLOBAL'),
   0
  )
 );

 select sequence_scope.scope_id, sequence_scope.last_remote_sequence
 into v_counter_id, v_current_sequence
 from public.inventario_secuencias_v2 as sequence_scope
 where sequence_scope.negocio_id = p_negocio_id
   and sequence_scope.authority_kind = v_authority
   and sequence_scope.sucursal_id is not distinct from p_sucursal_id
 for update;
 v_counter_exists := found;
 if not v_counter_exists then
  v_current_sequence := 0;
 end if;

 v_next_sequence := v_current_sequence + 1;

 if v_authority = 'GLOBAL' then
  update public.productos as p
  set stock_actual = v_stock_after,
      fecha_actualizacion = v_now_ms
  where p.id = p_producto_id
    and p.negocio_id = p_negocio_id;
 else
  update public.inventario_sucursales as inventory
  set stock_actual = v_stock_after,
      fecha_actualizacion = v_now_ms
  where inventory.sucursal_id = p_sucursal_id
    and inventory.producto_id = p_producto_id;

  update public.productos as p
  set stock_actual = v_global_after_bigint::integer,
      fecha_actualizacion = v_now_ms
  where p.id = p_producto_id
    and p.negocio_id = p_negocio_id;

  if exists (select 1 from public.native_sales_mode_v1 m where m.negocio_id = p_negocio_id) then
   insert into public.native_sales_stock_v1(negocio_id, scope_kind, sucursal_id, producto_id, revision)
   values (p_negocio_id, 'BRANCH', p_sucursal_id, p_producto_id, 1)
   on conflict (negocio_id, scope_kind, sucursal_id, producto_id) do update
   set revision = public.native_sales_stock_v1.revision + 1;
  end if;
 end if;

 -- Mirror into movimientos_stock so Realtime and legacy history queries stay complete.
 insert into public.movimientos_stock(
  id, negocio_id, sucursal_id, producto_id, delta, valor_absoluto, tipo, referencia_id, fecha_creacion
 )
 values (
  p_operation_id,
  p_negocio_id,
  p_sucursal_id,
  p_producto_id,
  case when p_effect_kind = 'DELTA' then v_effect_value_integer else 0 end,
  case when p_effect_kind = 'ABSOLUTE' then v_effect_value_integer else null end,
  p_tipo,
  p_referencia_id,
  p_fecha_origen
 )
 on conflict (id) do nothing;

 if v_counter_exists then
  update public.inventario_secuencias_v2 as sequence_scope
  set last_remote_sequence = v_next_sequence
  where sequence_scope.scope_id = v_counter_id;
 else
  insert into public.inventario_secuencias_v2(
   negocio_id, authority_kind, sucursal_id, last_remote_sequence
  )
  values (
   p_negocio_id, v_authority, p_sucursal_id, v_next_sequence
  );
 end if;

 v_applied_at := pg_catalog.clock_timestamp();

 insert into public.inventario_operaciones_v2(
  negocio_id,
  operacion_id,
  payload_version,
  payload_hash,
  authority_kind,
  producto_id,
  sucursal_id,
  effect_kind,
  effect_value,
  tipo,
  referencia_id,
  fecha_origen,
  expected_remote_sequence,
  remote_sequence,
  stock_before,
  stock_after,
  applied_at,
  applied_by,
  warning_codes
 )
 values (
  p_negocio_id,
  p_operation_id,
  p_contract_version::smallint,
  p_payload_hash,
  v_authority,
  p_producto_id,
  p_sucursal_id,
  p_effect_kind,
  v_effect_value_integer,
  p_tipo,
  p_referencia_id,
  p_fecha_origen,
  p_expected_remote_sequence,
  v_next_sequence,
  v_stock_before,
  v_stock_after,
  v_applied_at,
  v_actor_id,
  v_warning_codes
 );

 return pg_catalog.jsonb_build_object(
  'contractVersion', '2.0',
  'outcome', 'APPLIED',
  'code', 'APPLIED',
  'negocioId', p_negocio_id,
  'operationId', p_operation_id,
  'payloadHash', p_payload_hash,
  'authority', v_authority,
  'productoId', p_producto_id,
  'sucursalId', p_sucursal_id,
  'remoteSequence', v_next_sequence::text,
  'stockBefore', v_stock_before::text,
  'stockAfter', v_stock_after::text,
  'appliedAt', v_applied_at,
  'warningCodes', pg_catalog.to_jsonb(v_warning_codes)
 );
end;
$function$;

notify pgrst, 'reload schema';
commit;
