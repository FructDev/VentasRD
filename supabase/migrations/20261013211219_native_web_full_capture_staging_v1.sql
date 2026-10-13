-- Full read-only legacy capture. No adoption, business writes or new grants to
-- tables/helpers. All stable reads share the invoking statement's MVCC snapshot.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2
 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;
create or replace function public.native_web_capture_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_capture_id uuid)
 returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare role text;table_name text;relation oid;ids text[];chunk text[];observation jsonb;
 table_rows jsonb;scope_evidence jsonb;tables jsonb:='[]'::jsonb;answer jsonb;
 offset_row integer;row_count integer;total_count integer:=0;byte_count integer:=0;
begin
 role:=public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if role not in('owner','admin') then raise exception using errcode='42501',message='WEB_OBSERVATION_DENIED';end if;
 if p_capture_id is null then raise exception 'WEB_CAPTURE_REQUEST';end if;
 foreach table_name in array array['apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas'] loop
  relation:=pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(table_name));
  if relation is null or (select count(*) from pg_catalog.pg_attribute where attrelid=relation and attname in('id','negocio_id') and not attisdropped and atttypid in('pg_catalog.uuid'::pg_catalog.regtype,'pg_catalog.text'::pg_catalog.regtype))<>2 then raise exception 'WEB_OBSERVATION_UNAVAILABLE';end if;
  -- Explicit cap: never present a truncated history as a complete capture.
  execute pg_catalog.format('select pg_catalog.array_agg(id::text order by id::text) from (select id from public.%I where negocio_id::text=$1::text order by id::text limit 200001) bounded',table_name) into ids using p_negocio_id;
  if coalesce(pg_catalog.cardinality(ids),0)>200000 then raise exception 'WEB_OBSERVATION_TOO_LARGE';end if;
  table_rows:='[]'::jsonb;scope_evidence:='[]'::jsonb;offset_row:=1;
  while offset_row<=coalesce(pg_catalog.cardinality(ids),0) loop
   chunk:=ids[offset_row:offset_row+99];
   observation:=public.native_web_observe_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,p_capture_id,table_name,chunk);
   table_rows:=table_rows||(observation->'rows');
   scope_evidence:=scope_evidence||coalesce(observation->'scopeEvidence','[]'::jsonb);
   byte_count:=byte_count+pg_catalog.octet_length((observation->'rows')::text)+pg_catalog.octet_length(coalesce(observation->'scopeEvidence','[]'::jsonb)::text);
   if byte_count>33000000 then raise exception 'WEB_OBSERVATION_TOO_LARGE';end if;
   offset_row:=offset_row+100;
  end loop;
  row_count:=pg_catalog.jsonb_array_length(table_rows);total_count:=total_count+row_count;
  if total_count>200000 then raise exception 'WEB_OBSERVATION_TOO_LARGE';end if;
  tables:=tables||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('name',table_name,'count',row_count,'rows',table_rows,'scopeEvidence',scope_evidence));
 end loop;
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.web.capture.1','captureId',p_capture_id,
 'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'installationId',p_installation_id,'deviceId',p_device_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),
 'capturedAtMs',pg_catalog.floor(extract(epoch from pg_catalog.statement_timestamp())*1000)::bigint::text,
 'coverage','SCOPE_COMPLETE_SINGLE_SNAPSHOT','decimalEncoding','TAGGED_NUMBERS_V1','tables',tables);
 if pg_catalog.octet_length(answer::text)>33554432 then raise exception 'WEB_OBSERVATION_TOO_LARGE';end if;
 return answer;
end $f$;
revoke all on function public.native_web_capture_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.native_web_capture_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) to authenticated;
commit;
