-- Align AdriTech's Audifonos LogiZ-300 stock (18) and minimum (5) in Supabase
-- with the local Dexie browser balance that had not synced from the web client.
begin;

insert into public.native_sales_write_context_v1(transaction_id, negocio_id)
values (pg_catalog.txid_current(), '94600335-4f65-48ca-8905-bd12d21a756a'::uuid)
on conflict do nothing;

update public.productos
set stock_actual = 18,
    stock_minimo = 5,
    fecha_actualizacion = floor(extract(epoch from transaction_timestamp()) * 1000)::bigint
where negocio_id = '94600335-4f65-48ca-8905-bd12d21a756a'
  and id = 'a0b9ca49-356f-4ed1-8bd5-83c1df787e8f';

update public.inventario_sucursales
set stock_actual = 18,
    stock_minimo = 5,
    fecha_actualizacion = floor(extract(epoch from transaction_timestamp()) * 1000)::bigint
where sucursal_id = '10a95753-aeb4-453e-8905-e956590af31d'
  and producto_id = 'a0b9ca49-356f-4ed1-8bd5-83c1df787e8f';

update public.native_sales_stock_v1
set revision = revision + 1
where negocio_id = '94600335-4f65-48ca-8905-bd12d21a756a'
  and sucursal_id = '10a95753-aeb4-453e-8905-e956590af31d'
  and producto_id = 'a0b9ca49-356f-4ed1-8bd5-83c1df787e8f';

delete from public.native_sales_write_context_v1
where transaction_id = pg_catalog.txid_current()
  and negocio_id = '94600335-4f65-48ca-8905-bd12d21a756a'::uuid;

commit;
