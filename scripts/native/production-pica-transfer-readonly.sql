-- Only Pica Chicken. Diagnostic reads, without activation or fiscal access.
begin transaction isolation level repeatable read read only;
set local statement_timeout='30s';
with target as (select '864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid id),
branches as (select s.id,s.nombre from public.sucursales s join target t on s.negocio_id=t.id),
products as (select p.* from public.productos p join target t on p.negocio_id=t.id),
cash as (select c.* from public.cajas c join target t on c.negocio_id::text=t.id::text),
credit as (select f.* from public.transacciones_fiado f join target t on f.negocio_id::text=t.id::text),
sales as (select v.* from public.ventas v join target t on v.negocio_id::text=t.id::text)
select jsonb_build_object(
 'protocol','ventard.pica.transfer.readonly.1','capturedAt',transaction_timestamp(),
 'branches',(select coalesce(jsonb_agg(to_jsonb(b)),'[]') from branches b),
 'stockCoverage',(select coalesce(jsonb_agg(jsonb_build_object('branchId',b.id,
   'products',(select count(*) from products),
   'branchRows',(select count(*) from public.inventario_sucursales i join products p on p.id=i.producto_id where i.sucursal_id=b.id),
   'missingBranchRows',(select count(*) from products p where not exists(select 1 from public.inventario_sucursales i where i.producto_id=p.id and i.sucursal_id=b.id)),
   'globalBranchDifferences',(select count(*) from public.inventario_sucursales i join products p on p.id=i.producto_id where i.sucursal_id=b.id and i.stock_actual is distinct from p.stock_actual)
 )),'[]') from branches b),
 'cash',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'branchId',c.sucursal_id,
   'state',c.estado,'opening',c.monto_apertura::text,'counted',c.monto_cierre::text,
   'expected',c.monto_esperado::text,'difference',c.diferencia::text,'openedAt',c.fecha_apertura,'closedAt',c.fecha_cierre)),'[]') from cash c),
 'fractionalCentSales',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'total',v.total::text,'displayTotal',round(v.total::numeric,2)::text,'method',v.metodo_pago)),'[]') from sales v where v.total::numeric*100<>trunc(v.total::numeric*100)),
 'fractionalCentCredit',(select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'saleId',f.venta_id,'amount',f.monto::text,'displayAmount',round(f.monto::numeric,2)::text,'type',f.tipo)),'[]') from credit f where f.monto::numeric*100<>trunc(f.monto::numeric*100)),
 'unclassifiedPayments',(select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'amount',f.monto::text,'createdAt',f.fecha_creacion,'branchId',f.sucursal_id,'cashId',f.caja_id)),'[]') from credit f where f.tipo='abono' and (f.metodo_pago is null or f.metodo_pago not in('efectivo','tarjeta','transferencia'))),
 'nativeMode',(select coalesce(jsonb_agg(to_jsonb(m)),'[]') from public.native_sales_mode_v1 m join target t on m.negocio_id=t.id)
) as result;
rollback;
