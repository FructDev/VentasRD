-- Compatibility repair for the read-only observation RPC. The deployed legacy
-- tables use both UUID and text identifiers. Returns without a branch column
-- must prove their branch through the same tenant's sale; never add a fabricated
-- sucursal_id to the original row. No business data or permissions are changed.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2
 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;
create or replace function public.native_web_observe_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_observation_id uuid,p_table text,p_ids text[])
 returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare role text;relation oid;parent_relation oid;item record;row_json jsonb;encoded jsonb;rows jsonb:='[]'::jsonb;col record;clock_ms text;answer jsonb;
 scope_filter text:='';parent_join text:='';evidence_expr text:='null::jsonb';evidence jsonb:='[]'::jsonb;
begin
 role:=public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if role not in('owner','admin') then raise exception using errcode='42501',message='WEB_OBSERVATION_DENIED';end if;
 if p_observation_id is null or p_ids is null or pg_catalog.cardinality(p_ids) not between 1 and 100
 or exists(select 1 from pg_catalog.unnest(p_ids) x where x is null or pg_catalog.length(x) not between 1 and 512)
 or (select count(distinct x) from pg_catalog.unnest(p_ids) x)<>pg_catalog.cardinality(p_ids) then raise exception 'WEB_OBSERVATION_REQUEST';end if;
 if p_table is null or p_table not in('apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas') then raise exception 'WEB_OBSERVATION_TABLE';end if;
 relation:=pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(p_table));
 if relation is null or (select count(*) from pg_catalog.pg_attribute where attrelid=relation and attname in('id','negocio_id') and not attisdropped and atttypid in('pg_catalog.uuid'::pg_catalog.regtype,'pg_catalog.text'::pg_catalog.regtype))<>2 then raise exception 'WEB_OBSERVATION_UNAVAILABLE';end if;
 if p_scope_kind='BRANCH' and p_table in('apartados','cajas','cortes_caja','devoluciones','gastos','movimientos_stock','reparaciones','transacciones_fiado','venta_detalles','ventas') then
  if exists(select 1 from pg_catalog.pg_attribute where attrelid=relation and attname='sucursal_id' and not attisdropped and atttypid in('pg_catalog.uuid'::pg_catalog.regtype,'pg_catalog.text'::pg_catalog.regtype)) then
   scope_filter:=' and t.sucursal_id::text=$3::text';
  elsif p_table='devoluciones' and not exists(select 1 from pg_catalog.pg_attribute where attrelid=relation and attname='sucursal_id' and not attisdropped) then
   parent_relation:=pg_catalog.to_regclass('public.ventas');
   if parent_relation is null or (select count(*) from pg_catalog.pg_attribute where attrelid=parent_relation and attname in('id','negocio_id','sucursal_id') and not attisdropped and atttypid in('pg_catalog.uuid'::pg_catalog.regtype,'pg_catalog.text'::pg_catalog.regtype))<>3
   or not exists(select 1 from pg_catalog.pg_attribute where attrelid=relation and attname='venta_id' and not attisdropped and atttypid in('pg_catalog.uuid'::pg_catalog.regtype,'pg_catalog.text'::pg_catalog.regtype)) then raise exception 'WEB_OBSERVATION_UNAVAILABLE';end if;
   parent_join:=' join public.ventas parent on parent.id::text=t.venta_id::text and parent.negocio_id::text=$1::text and parent.sucursal_id::text=$3::text';
   evidence_expr:='pg_catalog.jsonb_build_object(''rowId'',t.id::text,''sourceTable'',''ventas'',''sourceId'',parent.id::text,''tenantId'',parent.negocio_id::text,''branchId'',parent.sucursal_id::text)';
  else raise exception 'WEB_OBSERVATION_UNAVAILABLE';end if;
 end if;
 -- Keep original row fields intact. Scope evidence is a separate observation
 -- of the sale relationship, and never evidence of financial application.
 for item in execute pg_catalog.format('select pg_catalog.to_jsonb(t) as row_data,%s as scope_evidence from public.%I t%s where t.negocio_id::text=$1::text and t.id::text=any($2)%s order by t.id limit 101',evidence_expr,p_table,parent_join,scope_filter) using p_negocio_id,p_ids,p_sucursal_id loop
  row_json:=item.row_data;encoded:=public.native_web_observation_json_v1(row_json);
  for col in select attname from pg_catalog.pg_attribute where attrelid=relation and attnum>0 and not attisdropped and atttypid='pg_catalog.timestamptz'::pg_catalog.regtype loop
   if row_json->col.attname<>'null'::jsonb then encoded:=pg_catalog.jsonb_set(encoded,array[col.attname],pg_catalog.jsonb_build_object('$milliseconds',((extract(epoch from (row_json->>col.attname)::timestamptz)*1000)::numeric)::text));end if;
  end loop;
  rows:=rows||pg_catalog.jsonb_build_array(encoded);
  if item.scope_evidence is not null then evidence:=evidence||pg_catalog.jsonb_build_array(item.scope_evidence);end if;
 end loop;
 clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.statement_timestamp())*1000)::bigint::text;
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.web.observation.1','observationId',p_observation_id,'tenantId',p_negocio_id,'actorId',auth.uid(),'installationId',p_installation_id,'deviceId',p_device_id,'writerEpoch',p_writer_epoch::text,'scope',pg_catalog.jsonb_build_object('type',p_scope_kind,'branchId',p_sucursal_id),'table',p_table,'requestedIds',pg_catalog.to_jsonb(p_ids),'capturedAtMs',clock_ms,'coverage','REQUESTED_IDS_ONLY','decimalEncoding','TAGGED_NUMBERS_V1','rows',rows);
 -- Preserve the existing response shape for direct-scope rows. Older clients
 -- fail closed only on inherited return scope they could not previously read.
 if evidence<>'[]'::jsonb then answer:=answer||pg_catalog.jsonb_build_object('scopeEvidence',evidence);end if;
 if pg_catalog.octet_length(answer::text)>2097152 then raise exception 'WEB_OBSERVATION_TOO_LARGE';end if;
 return answer;
end $f$;
revoke all on function public.native_web_observe_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.native_web_observe_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,text,text[]) to authenticated;
commit;
