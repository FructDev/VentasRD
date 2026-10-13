-- Prepared for explicit Staging approval. Read-only observations, no adoption.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2
 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;
-- Preserve numeric lexemes, including numbers nested in payments/items. A
-- tagged number is an observation, never native cents or an APPLIED receipt.
create or replace function public.native_web_observation_json_v1(v jsonb,depth integer default 0)
 returns jsonb language plpgsql immutable set search_path='' as $f$
declare result jsonb;key text;item jsonb;
begin
 if depth>64 then raise exception 'WEB_OBSERVATION_DEPTH';end if;
 case pg_catalog.jsonb_typeof(v)
 when 'number' then return pg_catalog.jsonb_build_object('$number',v#>>'{}');
 when 'array' then
  result:='[]'::jsonb;for item in select value from pg_catalog.jsonb_array_elements(v) loop result:=result||pg_catalog.jsonb_build_array(public.native_web_observation_json_v1(item,depth+1));end loop;return result;
 when 'object' then
  result:='{}'::jsonb;for key,item in select * from pg_catalog.jsonb_each(v) loop
   if key in('$number','$milliseconds') then raise exception 'WEB_OBSERVATION_RESERVED_KEY';end if;
   result:=result||pg_catalog.jsonb_build_object(key,public.native_web_observation_json_v1(item,depth+1));end loop;return result;
 else return v;end case;
end $f$;
revoke all on function public.native_web_observation_json_v1(jsonb,integer) from public,anon,authenticated;
create or replace function public.native_web_observe_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_observation_id uuid,p_table text,p_ids text[])
 returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare role text;relation oid;row_json jsonb;encoded jsonb;rows jsonb:='[]'::jsonb;col record;clock_ms text;answer jsonb;scope_filter text:='';
begin
 role:=public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if role not in('owner','admin') then raise exception using errcode='42501',message='WEB_OBSERVATION_DENIED';end if;
 if p_observation_id is null or p_ids is null or pg_catalog.cardinality(p_ids) not between 1 and 100
 or exists(select 1 from pg_catalog.unnest(p_ids) x where x is null or pg_catalog.length(x) not between 1 and 512)
 or (select count(distinct x) from pg_catalog.unnest(p_ids) x)<>pg_catalog.cardinality(p_ids) then raise exception 'WEB_OBSERVATION_REQUEST';end if;
 if p_table is null or p_table not in('apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas') then raise exception 'WEB_OBSERVATION_TABLE';end if;
 relation:=pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(p_table));
 if relation is null or (select count(*) from pg_catalog.pg_attribute where attrelid=relation and attname in('id','negocio_id') and not attisdropped)<>2 then raise exception 'WEB_OBSERVATION_UNAVAILABLE';end if;
 if p_scope_kind='BRANCH' and p_table in('apartados','cajas','cortes_caja','devoluciones','gastos','movimientos_stock','reparaciones','transacciones_fiado','venta_detalles','ventas') then
  if not exists(select 1 from pg_catalog.pg_attribute where attrelid=relation and attname='sucursal_id' and not attisdropped) then raise exception 'WEB_OBSERVATION_UNAVAILABLE';end if;
  scope_filter:=' and t.sucursal_id=$3';
 end if;
 -- One statement snapshot per batch; separate batches may observe different
 -- moments. No server ledger, allocation, cursor, stock or financial mutation.
 for row_json in execute pg_catalog.format('select pg_catalog.to_jsonb(t) from public.%I t where t.negocio_id=$1 and t.id::text=any($2)%s order by t.id limit 101',p_table,scope_filter) using p_negocio_id,p_ids,p_sucursal_id loop
  encoded:=public.native_web_observation_json_v1(row_json);
  for col in select attname,atttypid from pg_catalog.pg_attribute where attrelid=relation and attnum>0 and not attisdropped and atttypid='pg_catalog.timestamptz'::pg_catalog.regtype loop
   if row_json->col.attname<>'null'::jsonb then encoded:=pg_catalog.jsonb_set(encoded,array[col.attname],pg_catalog.jsonb_build_object('$milliseconds',((extract(epoch from (row_json->>col.attname)::timestamptz)*1000)::numeric)::text));end if;
  end loop;
  rows:=rows||pg_catalog.jsonb_build_array(encoded);
 end loop;
 clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.statement_timestamp())*1000)::bigint::text;
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.web.observation.1','observationId',p_observation_id,'tenantId',p_negocio_id,'actorId',auth.uid(),'installationId',p_installation_id,'deviceId',p_device_id,'writerEpoch',p_writer_epoch::text,'scope',pg_catalog.jsonb_build_object('type',p_scope_kind,'branchId',p_sucursal_id),'table',p_table,'requestedIds',pg_catalog.to_jsonb(p_ids),'capturedAtMs',clock_ms,'coverage','REQUESTED_IDS_ONLY','decimalEncoding','TAGGED_NUMBERS_V1','rows',rows);
 if pg_catalog.octet_length(answer::text)>2097152 then raise exception 'WEB_OBSERVATION_TOO_LARGE';end if;
 return answer;
end $f$;
revoke all on function public.native_web_observe_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.native_web_observe_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,text,text[]) to authenticated;
commit;
