-- Staging QA A/B only. No cutover, activation, license or source writes by DDL.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;
create table if not exists public.native_web_cutovers_v1 (
 negocio_id uuid not null references public.negocios(id),cutover_id uuid not null,
 intent text not null,intent_hash text not null check(intent_hash~'^[0-9a-f]{64}$'),receipt jsonb not null,
 actor_id uuid not null,created_at timestamptz not null default pg_catalog.now(),primary key(negocio_id,cutover_id)
);
alter table public.native_web_cutovers_v1 enable row level security;
revoke all on public.native_web_cutovers_v1 from public,anon,authenticated;
create or replace function public.native_web_cutover_normalize_v1(v jsonb,depth integer default 0) returns jsonb language plpgsql immutable set search_path='' as $f$
declare k text;x jsonb;r jsonb:='{}';a jsonb:='[]';s text;n numeric;
begin
 if depth>64 then raise exception 'CUTOVER_INVALID';end if;
 if pg_catalog.jsonb_typeof(v)='object' and (v ? '$number' or v ? '$milliseconds') then
  if (select count(*) from pg_catalog.jsonb_object_keys(v))<>1 then raise exception 'CUTOVER_INVALID';end if;
  s:=coalesce(v->>'$number',v->>'$milliseconds');n:=s::numeric;s:=n::text;
  if n=0 then s:='0';elsif pg_catalog.strpos(s,'.')>0 then s:=pg_catalog.rtrim(pg_catalog.rtrim(s,'0'),'.');end if;
  return pg_catalog.jsonb_build_object('$number',s);
 elsif pg_catalog.jsonb_typeof(v)='object' then
  for k,x in select key,value from pg_catalog.jsonb_each(v) loop
   if k='estado_sincronizacion' or pg_catalog.starts_with(k,'inventory_') or pg_catalog.starts_with(k,'sync_') or k=any(array['remote_receipt','payload_hash','attempt_count','last_attempt_at','next_attempt_at','last_outcome_code','error_class','claim_id','lease_until','conflict','origin_device_id','expected_remote_sequence']) then continue;end if;
   r:=r||pg_catalog.jsonb_build_object(k,public.native_web_cutover_normalize_v1(x,depth+1));
  end loop;return r;
 elsif pg_catalog.jsonb_typeof(v)='array' then
  for x in select value from pg_catalog.jsonb_array_elements(v) loop a:=a||pg_catalog.jsonb_build_array(public.native_web_cutover_normalize_v1(x,depth+1));end loop;return a;
 elsif pg_catalog.jsonb_typeof(v)='number' then raise exception 'CUTOVER_INVALID';
 else return v;end if;
end $f$;
create or replace function public.native_web_cutover_tables_v1(capture jsonb) returns jsonb language plpgsql immutable set search_path='' as $f$
declare t jsonb;rows jsonb;block jsonb;blocks jsonb;offset_n integer;result jsonb:='[]';
begin
 for t in select value from pg_catalog.jsonb_array_elements(capture->'tables') order by value->>'name' collate "C" loop
  select coalesce(pg_catalog.jsonb_agg(public.native_web_cutover_normalize_v1(value) order by value->>'id' collate "C"),'[]'::jsonb) into rows from pg_catalog.jsonb_array_elements(t->'rows');
  offset_n:=0;blocks:='[]';
  while offset_n<pg_catalog.jsonb_array_length(rows) loop
   select pg_catalog.jsonb_agg(value order by ordinality) into block from pg_catalog.jsonb_array_elements(rows) with ordinality where ordinality>offset_n and ordinality<=offset_n+100;
   blocks:=blocks||pg_catalog.jsonb_build_array(public.native_sales_hash_v1(public.native_sales_canonical_v1(block)));offset_n:=offset_n+100;
  end loop;
  result:=result||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('name',t->>'name','count',pg_catalog.jsonb_array_length(rows),'blocks',blocks));
 end loop;return result;
end $f$;
create or replace function public.native_web_cutover_v1(p_intent text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;ctx jsonb;n uuid;i uuid;d uuid;b uuid;e bigint;k text;op uuid;role_name text;old public.native_web_cutovers_v1%rowtype;capture jsonb;t jsonb;row_json jsonb;answer jsonb;activation jsonb;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>524288 then raise exception 'CUTOVER_INVALID';end if;
 v:=p_intent::jsonb;
 if p_hash is null or p_hash!~'^[0-9a-f]{64}$' or public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent)<>p_hash or v->>'protocol' is distinct from 'ventard.web.cutover.1' or v->>'confirmation' is distinct from 'WEB_WRITERS_CLOSED_BALANCES_REVIEWED' then raise exception 'CUTOVER_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','cutoverId','runId','revision','context','backupId','backupHash','runHash','confirmation','freeTax','sources','tables']);
 if (select count(*) from pg_catalog.jsonb_object_keys(v))<>12 or v->>'backupHash'!~'^[0-9a-f]{64}$' or v->>'runHash'!~'^[0-9a-f]{64}$' or v->>'freeTax' not in('0','0.18') or pg_catalog.jsonb_typeof(v->'revision') is distinct from 'number' or pg_catalog.jsonb_typeof(v->'sources') is distinct from 'array' or pg_catalog.jsonb_array_length(v->'sources') not between 1 and 51 then raise exception 'CUTOVER_INVALID';end if;
 perform (v->>'runId')::uuid;perform (v->>'backupId')::uuid;
 ctx:=v->'context';n:=(ctx->>'tenantId')::uuid;i:=(ctx->>'installationId')::uuid;d:=(ctx->>'deviceId')::uuid;e:=public.native_sales_int_v1(ctx->'writerEpoch')::bigint;k:=ctx->>'scopeType';b:=(ctx->>'branchId')::uuid;op:=(v->>'cutoverId')::uuid;
 if n is null or n not in('96000000-0000-4000-8000-000000000001'::uuid,'96000000-0000-4000-8000-000000000002'::uuid) or op is null or (ctx->>'actorId')::uuid is distinct from auth.uid() then raise exception 'CUTOVER_CONTEXT';end if;
 role_name:=public.native_sales_context_v1(n,i,d,e,k,b);if role_name not in('owner','admin') then raise exception using errcode='42501',message='CUTOVER_DENIED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_web_cutovers_v1 where negocio_id=n and cutover_id=op;
 if found then if old.intent<>p_intent or old.intent_hash<>p_hash then raise exception 'CUTOVER_ID_CONFLICT';end if;return old.receipt;end if;
 -- Same locks/fence used by native sale dispatch. Waiting old writes finish;
 -- later old writers fail when the mode is activated. Offline clients require
 -- the declared operational closure; this is no instant remote offline stop.
 for t in select pg_catalog.to_jsonb(name) from pg_catalog.unnest(array['apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','inventario_sucursales','movimientos_stock','ncf_secuencias','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas']) as name loop
  execute pg_catalog.format('lock table public.%I in share row exclusive mode',t#>>'{}');
 end loop;
 capture:=public.native_web_capture_v1(n,i,d,e,k,b,op);
 if public.native_web_cutover_tables_v1(capture) is distinct from v->'tables' then raise exception 'CUTOVER_SOURCE_CHANGED';end if;
 for t in select value from pg_catalog.jsonb_array_elements(capture->'tables') loop
  for row_json in select value from pg_catalog.jsonb_array_elements(t->'rows') loop
   if t->>'name'='cajas' and row_json->>'estado' is distinct from 'cerrada' then raise exception 'CUTOVER_CLOSE_WEB_CASH';end if;
   if t->>'name'='reparaciones' and coalesce(row_json->>'estado','') not in('entregado','cancelado','no_reparado') or t->>'name'='apartados' and coalesce(row_json->>'estado','') not in('completado','cancelado') then raise exception 'CUTOVER_SERVICE_REQUIRES_RECONCILIATION';end if;
  end loop;
 end loop;
 -- Baseline authority comes from present cloud facts, never an old sync flag.
 -- Already adopted accounts are compared; their journals/balances are untouched.
 if exists(select 1 from public.transacciones_fiado f where f.negocio_id=n and (f.tipo not in('cargo','abono') or f.tipo is null or f.monto is null or f.monto<0 or f.monto*100<>pg_catalog.trunc(f.monto*100) or not exists(select 1 from public.clientes c where c.id=f.cliente_id and c.negocio_id=n))) then raise exception 'CUTOVER_CREDIT_UNVERIFIABLE';end if;
 if exists(select 1 from public.clientes c where c.negocio_id=n and (coalesce((select sum(case when f.tipo='cargo' then f.monto else -f.monto end)*100 from public.transacciones_fiado f where f.negocio_id=n and f.cliente_id=c.id),0)<0 or coalesce((select sum(case when f.tipo='cargo' then f.monto else -f.monto end)*100 from public.transacciones_fiado f where f.negocio_id=n and f.cliente_id=c.id),0)>9007199254740991)) then raise exception 'CUTOVER_CREDIT_UNVERIFIABLE';end if;
 if exists(select 1 from public.native_sales_mode_v1 where negocio_id=n) and exists(select 1 from public.clientes c left join public.native_sales_credit_v1 x on x.negocio_id=c.negocio_id and x.cliente_id=c.id where c.negocio_id=n and (x.cliente_id is null or x.balance_cents is distinct from coalesce((select sum(case when f.tipo='cargo' then f.monto else -f.monto end)*100 from public.transacciones_fiado f where f.negocio_id=n and f.cliente_id=c.id),0)::bigint)) then raise exception 'CUTOVER_ACTIVE_BALANCE_CONFLICT';end if;
 activation:=public.native_sales_activate_v1(n,i,d,e,k,b,'QA_SYNTHETIC_QUIESCED',v->>'freeTax');
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.web.cutover.receipt.1','status','BASELINE_ADOPTED','cutoverId',op,'planHash',p_hash,'context',ctx,'runId',v->'runId','revision',v->'revision','backupId',v->'backupId','coverage','CLOUD_CONVERGED_BASELINE','legacyReplay',false);
 insert into public.native_web_cutovers_v1(negocio_id,cutover_id,intent,intent_hash,receipt,actor_id) values(n,op,p_intent,p_hash,answer,auth.uid());return answer;
end $f$;
create or replace function public.native_web_cutover_abandon_v1(p_intent text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;ctx jsonb;n uuid;op uuid;role_name text;old public.native_web_cutovers_v1%rowtype;answer jsonb;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>524288 then raise exception 'CUTOVER_INVALID';end if;
 v:=p_intent::jsonb;ctx:=v->'context';n:=(ctx->>'tenantId')::uuid;op:=(v->>'cutoverId')::uuid;
 if p_hash is null or public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent)<>p_hash or v->>'protocol' is distinct from 'ventard.web.cutover.1' or n not in('96000000-0000-4000-8000-000000000001'::uuid,'96000000-0000-4000-8000-000000000002'::uuid) or (ctx->>'actorId')::uuid is distinct from auth.uid() then raise exception 'CUTOVER_INVALID';end if;
 role_name:=public.native_sales_context_v1(n,(ctx->>'installationId')::uuid,(ctx->>'deviceId')::uuid,(ctx->>'writerEpoch')::bigint,ctx->>'scopeType',(ctx->>'branchId')::uuid);
 if role_name not in('owner','admin') then raise exception using errcode='42501',message='CUTOVER_DENIED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_web_cutovers_v1 where negocio_id=n and cutover_id=op;
 if found then if old.intent<>p_intent or old.intent_hash<>p_hash then raise exception 'CUTOVER_ID_CONFLICT';end if;return old.receipt;end if;
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.web.cutover.receipt.1','status','ABANDONED','cutoverId',op,'planHash',p_hash,'context',ctx,'runId',v->'runId','revision',v->'revision','backupId',v->'backupId','coverage','NO_BASELINE_CHANGE','legacyReplay',false);
 insert into public.native_web_cutovers_v1(negocio_id,cutover_id,intent,intent_hash,receipt,actor_id) values(n,op,p_intent,p_hash,answer,auth.uid());return answer;
end $f$;
revoke all on function public.native_web_cutover_normalize_v1(jsonb,integer),public.native_web_cutover_tables_v1(jsonb),public.native_web_cutover_v1(text,text),public.native_web_cutover_abandon_v1(text,text) from public,anon,authenticated;
grant execute on function public.native_web_cutover_v1(text,text),public.native_web_cutover_abandon_v1(text,text) to authenticated;
-- Preserve source data and deny every legacy table writer after native mode.
do $fence$ declare t text;begin
 foreach t in array array['apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas'] loop
  if pg_catalog.to_regclass('public.'||t) is not null then
   execute pg_catalog.format('drop trigger if exists native_sales_fence_v1 on public.%I',t);
   execute pg_catalog.format('create trigger native_sales_fence_v1 before insert or update or delete on public.%I for each row execute function public.native_sales_fence_v1()',t);
  end if;
 end loop;
end $fence$;
commit;
