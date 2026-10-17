-- Owner confirmed efectivo for this existing RD$10 payment. No new payment,
-- balance, cash link, timestamp, stock, fiscal or schema changes. Original row
-- is retained in the verified encrypted predeployment recovery and app capture.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:864d08e5-2975-4b2d-a1e2-ba5a14f3d677',0));
do $repair$
declare original public.transacciones_fiado%rowtype;
begin
 if exists(select 1 from public.native_sales_mode_v1 where negocio_id='864d08e5-2975-4b2d-a1e2-ba5a14f3d677') then
  raise exception 'PICA_ABONO_REQUIRES_PRE_CUTOVER';
 end if;
 select * into original from public.transacciones_fiado
 where negocio_id::text='864d08e5-2975-4b2d-a1e2-ba5a14f3d677'
 and id::text='a64047b1-cc96-4af0-9f33-eaa518697d59' for update;
 if not found or original.tipo is distinct from 'abono' or original.monto is distinct from 10
  or original.sucursal_id::text is distinct from '09026e88-90f8-44d5-b8cb-9d87f715072f'
  or original.fecha_creacion is distinct from '2026-10-02T01:48:29.427+00:00'::timestamptz
  or original.venta_id is not null or original.caja_id is not null then
  raise exception 'PICA_ABONO_SOURCE_CHANGED';
 end if;
 if original.metodo_pago is not null and original.metodo_pago<>'efectivo' then
  raise exception 'PICA_ABONO_METHOD_CONFLICT';
 end if;
 if original.metodo_pago is null then
  update public.transacciones_fiado set metodo_pago='efectivo'
  where negocio_id::text='864d08e5-2975-4b2d-a1e2-ba5a14f3d677'
   and id::text='a64047b1-cc96-4af0-9f33-eaa518697d59' and metodo_pago is null;
 end if;
end $repair$;
select jsonb_build_object('paymentId',id,'method',metodo_pago,'amount',monto::text,
 'cashLinkUnchanged',caja_id is null,'newPaymentCreated',false) as reconciliation
from public.transacciones_fiado
where negocio_id::text='864d08e5-2975-4b2d-a1e2-ba5a14f3d677'
 and id::text='a64047b1-cc96-4af0-9f33-eaa518697d59';
commit;
