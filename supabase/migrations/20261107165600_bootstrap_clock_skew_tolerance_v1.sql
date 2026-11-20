-- Ensure server-issued snapshot timestamps (capturedAtMs) are never rejected
-- by native clients whose Windows PC clock is slightly behind internet time.
-- By subtracting 45 seconds (45000 ms) from capturedAtMs while keeping expiresAtMs
-- within the 24-hour (86400000 ms) window, `captured.saturating_sub(now) > 5000`
-- in `sales_sync.rs` and `catalogue_preview.rs` passes even on PCs with up to
-- 50 seconds of clock lag.

begin;

create or replace function public.native_sales_bootstrap_settings_base_v1(
 p_negocio_id uuid,
 p_installation_id uuid,
 p_device_id uuid,
 p_writer_epoch bigint,
 p_scope_kind text,
 p_sucursal_id uuid,
 p_snapshot_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
 m public.native_sales_mode_v1%rowtype;
 old public.native_sales_snapshots_v1%rowtype;
 rows jsonb;
 batch jsonb;
 pages jsonb:='[]';
 header jsonb;
 payload text;
 idx integer:=0;
 cnt integer;
 at_ms bigint;
 watermark bigint;
 last_ticket bigint;
 turn_event jsonb;
begin
 perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if p_snapshot_id is null then raise exception 'NATIVE_SNAPSHOT_ID_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||p_negocio_id::text,0));
 select * into old from public.native_sales_snapshots_v1 x where x.negocio_id=p_negocio_id and x.snapshot_id=p_snapshot_id;
 if found then
  if old.actor_id is distinct from auth.uid() or old.installation_id is distinct from p_installation_id or old.device_id is distinct from p_device_id or old.writer_epoch is distinct from p_writer_epoch or old.scope_kind is distinct from p_scope_kind or old.sucursal_id is distinct from p_sucursal_id then raise exception using errcode='42501',message='NATIVE_SNAPSHOT_CONTEXT_DENIED';end if;
  return old.manifest;
 end if;
 perform public.native_auto_activate_tenant_baseline_v1(p_negocio_id,p_scope_kind,p_sucursal_id,auth.uid(),p_installation_id,p_device_id,p_writer_epoch);
 select * into m from public.native_sales_mode_v1 x where x.negocio_id=p_negocio_id and x.scope_kind=p_scope_kind and x.sucursal_id is not distinct from p_sucursal_id;
 if not found then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_venta is null or p.precio_venta<0 or p.precio_venta*100<>pg_catalog.trunc(p.precio_venta*100) or p.precio_venta*100>9007199254740991 or p.costo<0 or p.costo*100<>pg_catalog.trunc(p.costo*100) or p.tasa_itbis is null or p.tasa_itbis not between 0 and 1 or p.tasa_itbis*100<>pg_catalog.trunc(p.tasa_itbis*100))) then raise exception 'NATIVE_PRODUCT_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.composiciones c where c.negocio_id=p_negocio_id and (c.cantidad_necesaria is null or c.cantidad_necesaria<=0 or c.cantidad_necesaria*10000<>pg_catalog.trunc(c.cantidad_necesaria*10000))) then raise exception 'NATIVE_RECIPE_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_2<0 or p.precio_3<0 or p.precio_2*100<>pg_catalog.trunc(p.precio_2*100) or p.precio_3*100<>pg_catalog.trunc(p.precio_3*100) or p.precio_2*100>9007199254740991 or p.precio_3*100>9007199254740991)) then raise exception 'NATIVE_PRICE_TIER_UNVERIFIABLE';end if;
 if exists(select 1 from public.seriales s where s.negocio_id=p_negocio_id and not exists(select 1 from public.native_web_legacy_catalogue_rows_v1 archived_series where archived_series.negocio_id=p_negocio_id and archived_series.table_name='seriales' and archived_series.row_id=s.id::text and archived_series.source_row=pg_catalog.to_jsonb(s) and not exists(select 1 from public.productos own_product where own_product.id=s.producto_id and own_product.negocio_id=p_negocio_id)) and (s.estado is null or s.estado not in('merma','disponible','vendido','reservado','apartado') or (s.estado='apartado' and not exists(select 1 from (select distinct on (mr.document->'layaway'->>'id') mr.* from public.native_service_records_v1 mr where mr.negocio_id=p_negocio_id and mr.kind in('LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL','LAYAWAY_BASELINE') order by mr.document->'layaway'->>'id',(mr.document->'layaway'->>'revision')::bigint desc) a,pg_catalog.jsonb_array_elements(a.document->'layaway'->'definition'->'items') item where a.document->'layaway'->>'state'='activo' and item->>'productId'=s.producto_id::text and item->>'serial'=s.numero_serial)))) then raise exception 'NATIVE_SERIAL_SOURCE_UNVERIFIABLE';end if;
 select x.last_sequence into watermark from public.native_sales_counter_v1 x where x.negocio_id=p_negocio_id;
 select coalesce(max(pg_catalog.split_part(x.ticket,'-',2)::bigint),0) into last_ticket from public.native_sales_ledger_v1 x where x.negocio_id=p_negocio_id and x.installation_id=p_installation_id and x.writer_epoch=p_writer_epoch and x.ticket is not null;
 select pg_catalog.jsonb_build_object('receipt',l.receipt,'intent',l.intent_text,'snapshot',l.snapshot_text) into turn_event from public.native_sales_turns_v1 t join public.native_sales_ledger_v1 l on l.negocio_id=t.negocio_id and l.operation_id=t.turn_id where t.negocio_id=p_negocio_id and t.scope_kind=p_scope_kind and t.sucursal_id is not distinct from p_sucursal_id and t.status='OPEN';
 select coalesce(pg_catalog.jsonb_agg(v order by kind,id),'[]'::jsonb) into rows from (
  select 'PRODUCT' kind,p.id::text id,pg_catalog.jsonb_build_object('kind','PRODUCT','id',p.id,'name',p.nombre,'code',p.codigo_barras,'revision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),'1'),'deleted',coalesce(p.eliminado,false),'priceTiers',pg_catalog.jsonb_build_object('retailCents',(p.precio_venta*100)::bigint::text,'tier2Cents',(p.precio_2*100)::bigint::text,'tier3Cents',(p.precio_3*100)::bigint::text),'metadata',public.native_product_photo_metadata_v1(p_negocio_id,p.id)||pg_catalog.jsonb_build_object('costCents',public.native_product_cost_v1(p_negocio_id,p.id)::bigint::text,'taxRate',pg_catalog.jsonb_build_object('numerator',(p.tasa_itbis*100)::bigint::text,'denominator','100'),'productType',p.tipo,'recipeCostPolicy',case when p.tipo='combo' and exists(select 1 from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id) then 'NATIVE_EXACT' else 'DECLARED' end,'location',coalesce((select pm.location from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),pg_catalog.to_jsonb(p)->>'ubicacion',''),'minimum',coalesce((select pm.minimum::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),pg_catalog.to_jsonb(p)->>'stock_minimo'),'serialRequired',coalesce(p.serializable,false),'recipe',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productId',c.insumo_id,'perUnit',pg_catalog.jsonb_build_object('numerator',(c.cantidad_necesaria*10000)::bigint::text,'denominator','10000'),'revision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=c.insumo_id),'1')) order by c.insumo_id) from public.composiciones c where c.negocio_id=p_negocio_id and c.producto_padre_id=p.id),'[]'::jsonb)),'stock',pg_catalog.jsonb_build_object('quantity',case when p_scope_kind='GLOBAL' then p.stock_actual::text else inv.stock_actual::text end,'version',st.revision::text,'authority',case when st.revision is null or (p_scope_kind='BRANCH' and inv.stock_actual is null) then 'UNKNOWN' when p_scope_kind='BRANCH' and p.stock_actual is distinct from (select sum(z.stock_actual) from public.inventario_sucursales z where z.producto_id=p.id) then 'DIVERGED' else 'VERIFIED' end)) v from public.productos p left join public.inventario_sucursales inv on inv.producto_id=p.id and inv.sucursal_id=p_sucursal_id left join public.native_sales_stock_v1 st on st.negocio_id=p_negocio_id and st.producto_id=p.id and st.scope_kind=p_scope_kind and st.sucursal_id is not distinct from p_sucursal_id where p.negocio_id=p_negocio_id
  union all select 'CUSTOMER',c.id::text,pg_catalog.jsonb_build_object('kind','CUSTOMER','id',c.id,'name',c.nombre,'balanceCents',x.balance_cents::text,'limitCents',(c.limite_credito*100)::bigint::text,'active',not coalesce(c.eliminado,false),'revision',x.revision::text,'priceTier',coalesce(c.tipo_precio,1)::text,'metadataRevision',coalesce((select cm.revision::text from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id),'1'),'phone',case when exists(select 1 from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id) then (select cm.phone from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id) else pg_catalog.to_jsonb(c)->>'telefono' end,'wholesale',coalesce((select cm.wholesale from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id),(pg_catalog.to_jsonb(c)->>'al_por_mayor')::boolean,false)) from public.clientes c join public.native_sales_credit_v1 x on x.negocio_id=c.negocio_id and x.cliente_id=c.id where c.negocio_id=p_negocio_id
  union all select 'REPAIR',mr.document->'repair'->>'id',pg_catalog.jsonb_build_object('kind','REPAIR','id',mr.document->'repair'->>'id','event',pg_catalog.jsonb_build_object('intent',l.intent_text,'snapshot',null,'receipt',l.receipt)) from
  (select distinct on (source_repair.document->'repair'->>'id') source_repair.* from public.native_management_records_v1 source_repair where source_repair.negocio_id=p_negocio_id and source_repair.scope_kind=p_scope_kind and source_repair.sucursal_id is not distinct from p_sucursal_id and source_repair.kind in('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') order by source_repair.document->'repair'->>'id',(source_repair.document->'repair'->>'revision')::bigint desc) mr join public.native_sales_ledger_v1 l on l.negocio_id=mr.negocio_id and l.operation_id=mr.operation_id where public.native_member_role_v1(p_negocio_id) in('owner','admin')
  union all select 'LAYAWAY',mr.document->'layaway'->>'id',pg_catalog.jsonb_build_object('kind','LAYAWAY','id',mr.document->'layaway'->>'id','event',pg_catalog.jsonb_build_object('intent',l.intent_text,'snapshot',null,'receipt',l.receipt)) from
  (select distinct on (source_repair.document->'layaway'->>'id') source_repair.* from public.native_management_records_v1 source_repair where source_repair.negocio_id=p_negocio_id and source_repair.scope_kind=p_scope_kind and source_repair.sucursal_id is not distinct from p_sucursal_id and source_repair.kind in('LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL') order by source_repair.document->'layaway'->>'id',(source_repair.document->'layaway'->>'revision')::bigint desc) mr join public.native_sales_ledger_v1 l on l.negocio_id=mr.negocio_id and l.operation_id=mr.operation_id where public.native_member_role_v1(p_negocio_id) in('owner','admin')
  union all select 'WARRANTY_RECORD',mr.operation_id::text,pg_catalog.jsonb_build_object('kind','WARRANTY_RECORD','id',mr.operation_id,'event',pg_catalog.jsonb_build_object('intent',l.intent_text,'snapshot',null,'receipt',l.receipt)) from
  (select distinct on(coalesce(r.document->'warranty'->>'sourceHash','DEFAULT')) r.* from public.native_management_records_v1 r where r.negocio_id=p_negocio_id and r.scope_kind=p_scope_kind and r.sucursal_id is not distinct from p_sucursal_id and (r.kind='WARRANTY_PATCH' or (r.kind='CONFIG_PATCH' and r.document ? 'warrantyDefault')) order by coalesce(r.document->'warranty'->>'sourceHash','DEFAULT'),coalesce((r.document->'warranty'->>'version')::bigint,(r.document->'warrantyDefault'->>'revision')::bigint) desc) mr join public.native_sales_ledger_v1 l on l.negocio_id=mr.negocio_id and l.operation_id=mr.operation_id where public.native_member_role_v1(p_negocio_id) in('owner','admin')
  union all select 'SERIAL',s.id::text,pg_catalog.jsonb_build_object('kind','SERIAL','productId',s.producto_id,'text',s.numero_serial,'revision','1','warranty',public.native_warranty_current_v1(p_negocio_id,p_scope_kind,p_sucursal_id,s.producto_id,s.numero_serial),'state',case s.estado when 'merma' then 'LOST' when 'disponible' then 'AVAILABLE' when 'reservado' then 'RESERVED' when 'apartado' then 'RESERVED' else 'SOLD' end) from public.seriales s where s.negocio_id=p_negocio_id and not exists(select 1 from public.native_web_legacy_catalogue_rows_v1 archived_series where archived_series.negocio_id=p_negocio_id and archived_series.table_name='seriales' and archived_series.row_id=s.id::text and archived_series.source_row=pg_catalog.to_jsonb(s) and not exists(select 1 from public.productos own_product where own_product.id=s.producto_id and own_product.negocio_id=p_negocio_id))
 ) q;
 cnt:=pg_catalog.jsonb_array_length(rows);if cnt>60000 then raise exception 'NATIVE_BOOTSTRAP_SIZE';end if;
 -- Subtract 45000 ms (45s) so client PCs whose clock is slightly behind NTP do not reject capturedAtMs.
 at_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint - 45000;
 header:=pg_catalog.jsonb_build_object('version','ventard.native.operational.1','namespace','NATIVE1','snapshotId',p_snapshot_id,'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'deviceId',p_device_id,'installationId',p_installation_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),'capturedAtMs',at_ms::text,'expiresAtMs',(at_ms+86400000)::text,'coverage','CLOUD_ADOPTED_V1','watermark',watermark::text,'totalCount',cnt,'ticketPrefix','N'||pg_catalog.replace(p_installation_id::text,'-',''),'lastTicket',last_ticket::text,'freeTax',pg_catalog.jsonb_build_object('numerator',(m.free_tax*100)::bigint::text,'denominator','100'),'turn',turn_event,'business',(select pg_catalog.jsonb_build_object('name',g.nombre,'rnc',pg_catalog.to_jsonb(g)->>'rnc','address',pg_catalog.to_jsonb(g)->>'direccion','phone',pg_catalog.to_jsonb(g)->>'telefono','footer',pg_catalog.to_jsonb(g)->>'mensaje_ticket') from public.negocios g where g.id=p_negocio_id),'cashBase',public.native_cash_base_v1(p_negocio_id,p_scope_kind,p_sucursal_id,watermark),'pages','[]'::jsonb);
 insert into public.native_sales_snapshots_v1 values(p_negocio_id,p_snapshot_id,auth.uid(),p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,header,at_ms+86400000);
 for batch in select pg_catalog.jsonb_agg(value order by ordinality) from (select value,ordinality,pg_catalog.sum(pg_catalog.octet_length(public.native_sales_canonical_v1(value))+1) over(order by ordinality) bytes from pg_catalog.jsonb_array_elements(rows) with ordinality) sized group by ((bytes-1)/800000),((ordinality-1)/200) order by pg_catalog.min(ordinality) loop
  payload:=public.native_sales_canonical_v1(batch);if pg_catalog.octet_length(payload)>1048576 then raise exception 'NATIVE_BOOTSTRAP_PAGE_SIZE';end if;
  pages:=pages||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',idx,'count',pg_catalog.jsonb_array_length(batch),'byteLength',pg_catalog.octet_length(payload),'sha256',public.native_sales_hash_v1(payload)));
  insert into public.native_sales_pages_v1 values(p_negocio_id,p_snapshot_id,idx,payload);idx:=idx+1;
 end loop;
 header:=pg_catalog.jsonb_set(header,'{pages}',pages);update public.native_sales_snapshots_v1 set manifest=header where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;return header;
end $function$;

create or replace function public.native_catalogue_begin_v1(
 p_snapshot_id uuid,
 p_negocio_id uuid,
 p_installation_id uuid,
 p_device_id uuid,
 p_writer_epoch bigint,
 p_scope_kind text,
 p_sucursal_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_role text;v_ms bigint;v_old public.native_catalogue_snapshots_v1%rowtype;v_manifest jsonb;v_count bigint;
begin
 v_role:=public.native_catalogue_authorize_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if p_snapshot_id is null then raise exception using errcode='22023',message='NATIVE_REQUEST_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-catalogue:'||p_snapshot_id::text,0));
 select * into v_old from public.native_catalogue_snapshots_v1 where snapshot_id=p_snapshot_id;
 v_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint - 45000;
 if found then
  if v_old.negocio_id<>p_negocio_id or v_old.actor_id<>auth.uid() or v_old.installation_id<>p_installation_id or v_old.device_id<>p_device_id
   or v_old.writer_epoch<>p_writer_epoch or v_old.scope_kind<>p_scope_kind or v_old.sucursal_id is distinct from p_sucursal_id or v_old.actor_role<>v_role
  then raise exception using errcode='42501',message='NATIVE_SNAPSHOT_CONTEXT_MISMATCH';end if;
  if v_ms>=v_old.expires_at_ms then raise exception using errcode='55000',message='NATIVE_SNAPSHOT_EXPIRED';end if;
  return v_old.manifest;
 end if;
 insert into public.native_catalogue_snapshots_v1(snapshot_id,negocio_id,actor_id,installation_id,device_id,writer_epoch,scope_kind,sucursal_id,actor_role,captured_at_ms,expires_at_ms)
 values(p_snapshot_id,p_negocio_id,auth.uid(),p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,v_role,v_ms,v_ms+86400000);
 with source as materialized(
  select p.id,p.nombre,p.codigo_barras,p.precio_venta,
   case when p_scope_kind='BRANCH' then i.stock_actual else p.stock_actual end as stock,
   case when p_scope_kind='BRANCH' and i.producto_id is null then 'MISSING_BRANCH_AUTHORITY'
        when p_scope_kind='GLOBAL' and p.stock_actual is null then 'MISSING_GLOBAL_AUTHORITY' else 'POINT_IN_TIME' end as evidence
  from public.productos p left join public.inventario_sucursales i on p_scope_kind='BRANCH' and i.producto_id=p.id and i.sucursal_id=p_sucursal_id
  where p.negocio_id=p_negocio_id and p.eliminado=false order by p.id limit 10001
 ), numbered as(
  select ((pg_catalog.row_number()over(order by id)-1)/200)::integer as page_index,id,
   pg_catalog.jsonb_build_object('id',id,'name',nombre,'code',codigo_barras,
   'priceCents',case when precio_venta>=0 and precio_venta*100=pg_catalog.trunc(precio_venta*100) and precio_venta*100<=9007199254740991 then (precio_venta*100)::bigint::text else null end,
   'stock',stock::text,'stockEvidence',evidence)as row from source
 ), grouped as(
  select page_index,count(*)::integer as n,pg_catalog.jsonb_agg(row order by id)::text as payload from numbered group by page_index
 )insert into public.native_catalogue_pages_v1(snapshot_id,page_index,row_count,payload_text,byte_length,sha256)
 select p_snapshot_id,page_index,n,payload,pg_catalog.octet_length(payload),pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload,'UTF8')),'hex')from grouped;
 select coalesce(sum(row_count),0)into v_count from public.native_catalogue_pages_v1 where snapshot_id=p_snapshot_id;
 if v_count>10000 then raise exception using errcode='54000',message='NATIVE_CATALOGUE_LIMIT';end if;
 select pg_catalog.jsonb_build_object('version','ventard.native.catalogue.preview.1','snapshotId',p_snapshot_id,
 'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'deviceId',p_device_id,'installationId',p_installation_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),
 'capturedAtMs',v_ms::text,'expiresAtMs',(v_ms+86400000)::text,'coverage','CATALOGUE_PREVIEW_V1','watermark',null,'totalCount',v_count,
 'pages',coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('index',page_index,'count',row_count,'byteLength',byte_length,'sha256',sha256)order by page_index),'[]'::jsonb))into v_manifest
 from public.native_catalogue_pages_v1 where snapshot_id=p_snapshot_id;
 update public.native_catalogue_snapshots_v1 set manifest=v_manifest where snapshot_id=p_snapshot_id;
 return v_manifest;
end $function$;

commit;
