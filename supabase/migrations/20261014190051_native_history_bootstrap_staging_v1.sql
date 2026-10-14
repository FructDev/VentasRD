-- Native historical facts share the frozen operational snapshot. No replay.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 or pg_catalog.to_regprocedure('public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)') is null then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
 if pg_catalog.to_regprocedure('public.native_sales_bootstrap_history_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)') is null then alter function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) rename to native_sales_bootstrap_history_base_v1;end if;
end $guard$;
create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare result jsonb;events jsonb;batch jsonb;pages jsonb;native_wire text;idx integer;cnt integer;source record;original jsonb;changed jsonb;owner uuid;
begin
 result:=public.native_sales_bootstrap_history_base_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,p_snapshot_id);
 -- Parent authenticates the exact request and reuses its frozen snapshot.
 if result->>'historyCoverage'='NATIVE_LEDGER_THROUGH_WATERMARK' then return result;end if;
 -- Preserve only explicit native ownership for sold serials, in this scope.
 for source in select page_index,payload from public.native_sales_pages_v1 where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id order by page_index loop
  changed:='[]'::jsonb;
  for original in select value from pg_catalog.jsonb_array_elements(source.payload::jsonb) loop
   if original->>'kind'='SERIAL' and original->>'state'='SOLD' then
    owner:=null;
    select l.operation_id into owner from public.seriales s join public.native_sales_ledger_v1 l on l.negocio_id=s.negocio_id and l.operation_id=s.venta_id and l.kind='SALE_CONFIRM' where s.negocio_id=p_negocio_id and s.producto_id=(original->>'productId')::uuid and s.numero_serial=original->>'text' and s.estado='vendido' and l.scope_kind=p_scope_kind and l.sucursal_id is not distinct from p_sucursal_id and l.remote_sequence<=(result->>'watermark')::bigint;
    if owner is not null then original:=original||pg_catalog.jsonb_build_object('saleOperationId',owner);end if;
   end if;
   changed:=changed||pg_catalog.jsonb_build_array(original);
  end loop;
  native_wire:=public.native_sales_canonical_v1(changed);
  if pg_catalog.octet_length(native_wire)>1048576 then raise exception 'NATIVE_BOOTSTRAP_PAGE_SIZE';end if;
  update public.native_sales_pages_v1 set payload=native_wire where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id and page_index=source.page_index;
  result:=pg_catalog.jsonb_set(result,array['pages',source.page_index::text,'byteLength'],pg_catalog.to_jsonb(pg_catalog.octet_length(native_wire)));
  result:=pg_catalog.jsonb_set(result,array['pages',source.page_index::text,'sha256'],pg_catalog.to_jsonb(public.native_sales_hash_v1(native_wire)));
 end loop;
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind','HISTORY_EVENT','id',l.operation_id,'event',pg_catalog.jsonb_build_object('intent',l.intent_text,'snapshot',l.snapshot_text,'receipt',l.receipt)) order by l.remote_sequence),'[]'::jsonb) into events from public.native_sales_ledger_v1 l where l.negocio_id=p_negocio_id and l.scope_kind=p_scope_kind and l.sucursal_id is not distinct from p_sucursal_id and l.remote_sequence<=(result->>'watermark')::bigint;
 cnt:=pg_catalog.jsonb_array_length(events);
 if cnt+(result->>'totalCount')::integer>60000 then raise exception 'NATIVE_BOOTSTRAP_SIZE';end if;
 pages:=result->'pages';idx:=pg_catalog.jsonb_array_length(pages);
 for batch in select pg_catalog.jsonb_agg(value order by ordinality) from (select value,ordinality,pg_catalog.sum(pg_catalog.octet_length(public.native_sales_canonical_v1(value))+1) over(order by ordinality) bytes from pg_catalog.jsonb_array_elements(events) with ordinality) sized group by ((bytes-1)/800000),((ordinality-1)/200) order by pg_catalog.min(ordinality) loop
  native_wire:=public.native_sales_canonical_v1(batch);if pg_catalog.octet_length(native_wire)>1048576 or idx>=300 then raise exception 'NATIVE_BOOTSTRAP_PAGE_SIZE';end if;
  insert into public.native_sales_pages_v1 values(p_negocio_id,p_snapshot_id,idx,native_wire);
  pages:=pages||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',idx,'count',pg_catalog.jsonb_array_length(batch),'byteLength',pg_catalog.octet_length(native_wire),'sha256',public.native_sales_hash_v1(native_wire)));idx:=idx+1;
 end loop;
 result:=result||pg_catalog.jsonb_build_object('historyCoverage','NATIVE_LEDGER_THROUGH_WATERMARK','historyCount',cnt,'totalCount',cnt+(result->>'totalCount')::integer,'pages',pages);
 update public.native_sales_snapshots_v1 set manifest=result where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;
 return result;
end $f$;
revoke all on function public.native_sales_bootstrap_history_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) from public,anon;
grant execute on function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) to authenticated;
commit;
