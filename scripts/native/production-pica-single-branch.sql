-- Reviewed data-only repair for the user's TEST business. It does not activate
-- native operation. Originals must first be encrypted and restore-verified.
-- The runner replaces the mandatory guard with scoped source SHA256 checks.
begin isolation level serializable;
set local statement_timeout='60s';
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:864d08e5-2975-4b2d-a1e2-ba5a14f3d677',0));
__PICA_TRANSFER_GUARD__
do $repair$
declare n constant uuid:='864d08e5-2975-4b2d-a1e2-ba5a14f3d677';
 b constant uuid:='09026e88-90f8-44d5-b8cb-9d87f715072f';
 tab text;col record;bad boolean;at_ms bigint:=floor(extract(epoch from transaction_timestamp())*1000);
begin
 if (select count(*) from public.sucursales where negocio_id=n)<>1
  or not exists(select 1 from public.sucursales where id=b and negocio_id=n) then raise exception 'PICA_SINGLE_BRANCH_REQUIRED';end if;
 if exists(select 1 from public.native_sales_mode_v1 where negocio_id=n)
  or exists(select 1 from public.native_sales_ledger_v1 where negocio_id=n) then raise exception 'PICA_REPAIR_REQUIRES_PRE_CUTOVER';end if;
 -- No guessed rounding: only the tiny representation noise already accepted
 -- by the legacy web centavo codec. Real fractional cents abort all changes.
 for col in select c.table_name,c.column_name from information_schema.columns c
 where c.table_schema='public'
 and c.table_name=any(array['apartados','cajas','clientes','cortes_caja','devoluciones','gastos','productos','reparaciones','transacciones_fiado','venta_detalles','ventas'])
 and c.data_type in('numeric','double precision','real')
 and c.column_name=any(array['total','monto','subtotal','precio_venta','precio_2','precio_3','precio_unitario','costo','limite_credito','monto_efectivo','monto_transferencia','monto_apertura','monto_cierre','monto_esperado','monto_contado','diferencia','efectivo','tarjeta','transferencia','fiado','mixto','total_ventas','ingreso_reparaciones','ingreso_apartados','ingreso_abonos_fiado','monto_devuelto','mano_obra','abono','abonado'])
 loop
  execute format('select exists(select 1 from public.%I where negocio_id::text=$1 and abs(%I::numeric-round(%I::numeric,2))>0.00000001)',col.table_name,col.column_name,col.column_name) into bad using n::text;
  if bad then raise exception 'PICA_GENUINE_FRACTIONAL_CENT: %.%',col.table_name,col.column_name;end if;
  execute format('update public.%I set %I=round(%I::numeric,2) where negocio_id::text=$1 and %I::numeric<>round(%I::numeric,2)',col.table_name,col.column_name,col.column_name,col.column_name,col.column_name) using n::text;
 end loop;
 for tab in select unnest(array['apartados','cajas','clientes','cortes_caja','gastos','movimientos_stock','reparaciones','transacciones_fiado','venta_detalles','ventas']) loop
  select format_type(a.atttypid,a.atttypmod) as typ into col from pg_attribute a
   where a.attrelid=to_regclass('public.'||quote_ident(tab)) and a.attname='sucursal_id' and not a.attisdropped;
  if found then
   execute format('update public.%I set sucursal_id=$1::%s where negocio_id::text=$2 and sucursal_id::text is distinct from $1',tab,col.typ) using b::text,n::text;
  end if;
 end loop;
 -- All records are test-only. Archive the two overlapping legacy turns;
 -- retain their opening/expected movements rather than inventing cash links.
 update public.cajas set estado='cerrada',monto_cierre=0,fecha_cierre=at_ms,
  diferencia=case when monto_esperado is null then null else -monto_esperado end
 where negocio_id::text=n::text and estado='abierta';
 -- The owner's one-branch web catalogue is the reviewed available-stock base.
 if exists(select 1 from public.productos where negocio_id=n and (stock_actual is null or stock_actual<0)) then raise exception 'PICA_STOCK_REVIEW_REQUIRED';end if;
 insert into public.inventario_sucursales(id,sucursal_id,producto_id,stock_actual,stock_minimo,estado_sincronizacion,fecha_actualizacion)
 select gen_random_uuid(),b,p.id,p.stock_actual,coalesce(p.stock_minimo,0),1,at_ms from public.productos p where p.negocio_id=n
 on conflict(sucursal_id,producto_id) do update set stock_actual=excluded.stock_actual,stock_minimo=excluded.stock_minimo,fecha_actualizacion=excluded.fecha_actualizacion
 where inventario_sucursales.stock_actual is distinct from excluded.stock_actual or inventario_sucursales.stock_minimo is distinct from excluded.stock_minimo;
end $repair$;
commit;
