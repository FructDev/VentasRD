-- STAGING ONLY. Browsers join the same journal; never reopen legacy row writes.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 or pg_catalog.to_regclass('public.native_sales_ledger_v1') is null then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;
-- Cuts must not be uploaded independently by a pre-update browser either.
do $cuts$ begin
 if pg_catalog.to_regclass('public.cortes_caja') is not null then
  drop trigger if exists native_sales_fence_v1 on public.cortes_caja;
  create trigger native_sales_fence_v1 before insert or update or delete on public.cortes_caja for each row execute function public.native_sales_fence_v1();
 end if;
end $cuts$;
create table if not exists public.native_web_channels_v1(
 negocio_id uuid not null,installation_id uuid not null,device_id uuid not null,
 actor_id uuid not null,writer_epoch bigint not null,scope_kind text not null,
 sucursal_id uuid,registration_id uuid not null,primary key(negocio_id,installation_id,actor_id),
 check((scope_kind='GLOBAL' and sucursal_id is null) or (scope_kind='BRANCH' and sucursal_id is not null)));
alter table public.native_web_channels_v1 enable row level security;
revoke all on public.native_web_channels_v1 from public,anon,authenticated;

create or replace function public.native_web_mode_v1(p_negocio_id uuid,p_sucursal_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare m public.native_sales_mode_v1%rowtype;r text;
begin
 r:=public.native_member_role_v1(p_negocio_id);
 if auth.uid() is null or r is null then raise exception using errcode='42501',message='NATIVE_WEB_ACCESS_DENIED';end if;
 select * into m from public.native_sales_mode_v1 where negocio_id=p_negocio_id;
 return pg_catalog.jsonb_build_object('protocol','ventard.web.mode.1','tenantId',p_negocio_id,'branchId',p_sucursal_id,
  'mode',case when not found then 'LEGACY' when m.scope_kind='BRANCH' and m.sucursal_id is not distinct from p_sucursal_id or m.scope_kind='GLOBAL' and p_sucursal_id is null then 'SHARED_JOURNAL' else 'SCOPE_BLOCKED' end);
end $f$;

create or replace function public.native_web_enroll_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_sucursal_id uuid,p_registration_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare m public.native_sales_mode_v1%rowtype;receipt jsonb;old public.native_web_channels_v1%rowtype;
begin
 if auth.uid() is null or public.native_member_role_v1(p_negocio_id) is null then raise exception using errcode='42501',message='NATIVE_WEB_ACCESS_DENIED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||p_negocio_id::text,0));
 select * into m from public.native_sales_mode_v1 where negocio_id=p_negocio_id;
 if not found or (m.scope_kind='BRANCH' and m.sucursal_id is distinct from p_sucursal_id) or (m.scope_kind='GLOBAL' and p_sucursal_id is not null) then raise exception 'NATIVE_WEB_SCOPE_REQUIRED';end if;
 select * into old from public.native_web_channels_v1 where negocio_id=p_negocio_id and installation_id=p_installation_id and actor_id=auth.uid();
 if found and (old.device_id is distinct from p_device_id or old.sucursal_id is distinct from p_sucursal_id) then raise exception 'NATIVE_WEB_IDENTITY_CONFLICT';end if;
 if old.installation_id is null and exists(select 1 from public.native_installations_v1 where installation_id=p_installation_id) and not exists(select 1 from public.native_web_channels_v1 w where w.negocio_id=p_negocio_id and w.installation_id=p_installation_id and w.device_id=p_device_id and w.scope_kind=m.scope_kind and w.sucursal_id is not distinct from p_sucursal_id) then raise exception 'NATIVE_WEB_INSTALLATION_ALREADY_NATIVE';end if;
 -- Existing native enrollment enforces membership, branch, license and replay.
 receipt:=public.native_registrar_instalacion_v1(p_registration_id,p_negocio_id,p_installation_id,p_device_id,m.scope_kind,p_sucursal_id);
 if not exists(select 1 from public.native_web_channels_v1 where negocio_id=p_negocio_id and installation_id=p_installation_id and actor_id=auth.uid()) then
  insert into public.native_web_channels_v1 values(p_negocio_id,p_installation_id,p_device_id,auth.uid(),(receipt->>'writerEpoch')::bigint,m.scope_kind,p_sucursal_id,p_registration_id);
 end if;
 perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,(receipt->>'writerEpoch')::bigint,m.scope_kind,p_sucursal_id);
 return receipt;
end $f$;

create or replace function public.native_web_context_v1(c jsonb) returns void language plpgsql stable security definer set search_path='' as $f$
declare n uuid:=(c->>'tenantId')::uuid;i uuid:=(c->>'installationId')::uuid;d uuid:=(c->>'deviceId')::uuid;e bigint:=(c->>'writerEpoch')::bigint;k text:=c->>'scopeType';b uuid:=(c->>'branchId')::uuid;
begin
 if c->>'actorId' is distinct from auth.uid()::text or not exists(select 1 from public.native_web_channels_v1 w where w.negocio_id=n and w.installation_id=i and w.device_id=d and w.actor_id=auth.uid() and w.writer_epoch=e and w.scope_kind=k and w.sucursal_id is not distinct from b) or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(c->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.request->>'deviceId'=d::text) then raise exception using errcode='42501',message='NATIVE_WEB_CONTEXT_DENIED';end if;
 perform public.native_sales_context_v1(n,i,d,e,k,b);
 perform pg_catalog.set_config('ventard.shared_web','1',true);
end $f$;

create or replace function public.native_web_submit_v1(p_context jsonb,p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;
begin
 perform public.native_web_context_v1(p_context);
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;
 if v->>'negocioId' is distinct from p_context->>'tenantId' or v->>'installationId' is distinct from p_context->>'installationId' or v->>'originDeviceId' is distinct from p_context->>'deviceId' or v->>'actorId' is distinct from p_context->>'actorId' or v->>'writerEpoch' is distinct from p_context->>'writerEpoch' or v->>'permissionGrantId' is distinct from p_context->>'permissionGrantId' or v->'scope' is distinct from pg_catalog.jsonb_build_object('type',p_context->>'scopeType','sucursalId',p_context->'branchId') then raise exception using errcode='42501',message='NATIVE_WEB_INTENT_CONTEXT_DENIED';end if;
 if v->>'kind' like 'FISCAL%' or v->'payload'->'sale'->'fiscal' is distinct from 'null'::jsonb and v->'payload'->'sale'->'fiscal' is not null or p_snapshot::jsonb->>'ncf' is not null then raise exception 'NATIVE_WEB_FISCAL_DEFERRED';end if;
 -- Exactly the same validators, lock, ledger, effects, stock/credit revisions,
 -- sequence and receipt as desktop. No second monetary outbox or stock replay.
 return public.native_sales_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
end $f$;

create or replace function public.native_web_lookup_v1(p_context jsonb,p_operation_id uuid,p_hash text) returns jsonb language plpgsql stable security definer set search_path='' as $f$
begin
 perform public.native_web_context_v1(p_context);
 return public.native_sales_lookup_v1((p_context->>'tenantId')::uuid,(p_context->>'installationId')::uuid,(p_context->>'deviceId')::uuid,(p_context->>'writerEpoch')::bigint,p_context->>'scopeType',(p_context->>'branchId')::uuid,p_operation_id,p_hash);
end $f$;

create or replace function public.native_web_feed_v1(p_context jsonb,p_after bigint) returns jsonb language plpgsql stable security definer set search_path='' as $f$
begin
 perform public.native_web_context_v1(p_context);
 return public.native_sales_feed_v1((p_context->>'tenantId')::uuid,(p_context->>'installationId')::uuid,(p_context->>'deviceId')::uuid,(p_context->>'writerEpoch')::bigint,p_context->>'scopeType',(p_context->>'branchId')::uuid,p_after);
end $f$;

create or replace function public.native_web_bootstrap_v1(p_context jsonb,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
begin
 perform public.native_web_context_v1(p_context);
 return public.native_sales_bootstrap_v1((p_context->>'tenantId')::uuid,(p_context->>'installationId')::uuid,(p_context->>'deviceId')::uuid,(p_context->>'writerEpoch')::bigint,p_context->>'scopeType',(p_context->>'branchId')::uuid,p_snapshot_id);
end $f$;

create or replace function public.native_web_bootstrap_page_v1(p_context jsonb,p_snapshot_id uuid,p_page_index integer) returns jsonb language plpgsql stable security definer set search_path='' as $f$
begin
 perform public.native_web_context_v1(p_context);
 return public.native_sales_bootstrap_page_v1((p_context->>'tenantId')::uuid,(p_context->>'installationId')::uuid,(p_context->>'deviceId')::uuid,(p_context->>'writerEpoch')::bigint,p_context->>'scopeType',(p_context->>'branchId')::uuid,p_snapshot_id,p_page_index);
end $f$;

-- A candidate is computed from the ORIGINAL supplied facts, never silently
-- rebased onto a newer service. It is not a receipt and has no financial effects.
create or replace function public.native_web_service_plan_v1(p_context jsonb,p_family text,p_request jsonb,p_previous jsonb,p_at text,p_folio text,p_folio_number text) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare role_name text;candidate jsonb;rid text;
begin
 perform public.native_web_context_v1(p_context);
 role_name:=public.native_member_role_v1((p_context->>'tenantId')::uuid);
 if role_name not in('owner','admin') or not exists(select 1 from public.native_staging_licenses_v1 where negocio_id=(p_context->>'tenantId')::uuid and plan_tier='pro') then raise exception using errcode='42501',message='NATIVE_PRO_REQUIRED';end if;
 if p_family not in('REPAIR','LAYAWAY') or p_family is null or pg_catalog.octet_length(p_request::text)>131072 or pg_catalog.octet_length(p_previous::text)>524288 then raise exception 'NATIVE_WEB_PLAN_INVALID';end if;
 perform public.native_sales_int_v1(pg_catalog.to_jsonb(p_at));perform public.native_sales_int_v1(pg_catalog.to_jsonb(p_folio_number));
 rid:=case when p_family='REPAIR' then p_request->>'repairId' else p_request->>'layawayId' end;
 if rid is null or rid::uuid is null or p_request->>'operationId' is null or (p_previous is not null and p_previous<>'null'::jsonb and (p_previous->>'id' is distinct from rid or p_previous->>'folio' is distinct from p_folio or p_previous->>'folioNumber' is distinct from p_folio_number)) then raise exception 'NATIVE_WEB_PLAN_INVALID';end if;
 if p_family='REPAIR' then candidate:=public.native_repair_plan_v1(p_request,nullif(p_previous,'null'::jsonb),p_at,auth.uid(),p_folio,p_folio_number);
 else candidate:=public.native_layaway_plan_v1(p_request,nullif(p_previous,'null'::jsonb),p_at,auth.uid(),p_folio,p_folio_number);end if;
 return pg_catalog.jsonb_build_object('protocol','ventard.web.service.candidate.1','family',p_family,'operationId',p_request->>'operationId','candidate',candidate);
end $f$;

-- Pure return calculation against the frozen ORIGINAL sale/prior returns.
-- This creates neither a receipt nor an inventory/debt/cash effect.
create or replace function public.native_web_return_plan_v1(p_context jsonb,p_sale jsonb,p_prior jsonb,p_items jsonb,p_serials jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $f$
begin
 perform public.native_web_context_v1(p_context);
 if public.native_member_role_v1((p_context->>'tenantId')::uuid) not in('owner','admin') then raise exception using errcode='42501',message='NATIVE_WEB_ACCESS_DENIED';end if;
 if pg_catalog.octet_length(p_sale::text)>1048576 or pg_catalog.octet_length(p_prior::text)>1048576 or pg_catalog.jsonb_typeof(p_prior) is distinct from 'array' or pg_catalog.jsonb_array_length(p_prior)>1000 then raise exception 'NATIVE_WEB_PLAN_INVALID';end if;
 return public.native_return_plan_v1(p_sale,p_prior,p_items,p_serials);
end $f$;
revoke all on function public.native_web_return_plan_v1(jsonb,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.native_web_return_plan_v1(jsonb,jsonb,jsonb,jsonb,jsonb) to authenticated;

-- Compatibility, not authorization: Auth/context/role checks remain mandatory.
-- Older binaries must upgrade before consuming merged-stock receipts. Merely
-- applying this schema enables nothing; the explicit browser enrollment opts in.
create or replace function public.native_shared_ready_v1(n uuid) returns void language plpgsql stable security definer set search_path='' as $f$
begin
 if exists(select 1 from public.native_web_channels_v1 where negocio_id=n)
 and coalesce(pg_catalog.current_setting('ventard.shared_web',true),'')<>'1'
 and coalesce(nullif(pg_catalog.current_setting('request.headers',true),'')::jsonb->>'x-ventard-journal','')<>'stock-merge-1'
 then raise exception 'NATIVE_SHARED_UPGRADE_REQUIRED';end if;
end $f$;

create or replace function public.native_shared_stock_v1(n uuid,k text,b uuid,i uuid,pid uuid,proof jsonb,cur integer,version bigint) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare base_seq bigint:=(proof->>'remoteSequence')::bigint;total numeric:=0;other_delta numeric:=0;own numeric:=0;row record;entry jsonb;others jsonb:='[]';cnt integer:=0;
begin
 if not exists(select 1 from public.native_web_channels_v1 where negocio_id=n) or base_seq>version then raise exception 'NATIVE_STOCK_VERSION_CONFLICT';end if;
 for entry in select value from pg_catalog.jsonb_array_elements(proof->'pending') loop
  if not exists(select 1 from public.native_sales_ledger_v1 l join public.native_sales_effects_v1 e on e.negocio_id=l.negocio_id and e.operation_id=l.operation_id where l.negocio_id=n and l.installation_id=i and l.scope_kind=k and l.sucursal_id is not distinct from b and l.operation_id=(entry->>'operationId')::uuid and l.remote_sequence>base_seq and e.effect_id=(entry->>'effectId')::uuid and e.kind='STOCK' and e.payload->>'productId'=pid::text and e.payload->>'delta'=entry->>'delta') then raise exception 'NATIVE_PENDING_COVERAGE_INVALID';end if;
  own:=own+(entry->>'delta')::integer;
 end loop;
 for row in select l.operation_id,l.remote_sequence,l.kind,e.effect_id,e.payload->>'delta' delta from public.native_sales_ledger_v1 l join public.native_sales_effects_v1 e on e.negocio_id=l.negocio_id and e.operation_id=l.operation_id where l.negocio_id=n and l.scope_kind=k and l.sucursal_id is not distinct from b and l.remote_sequence>base_seq and e.kind='STOCK' and e.payload->>'productId'=pid::text order by l.remote_sequence,e.effect_id loop
  cnt:=cnt+1;if cnt>1000 then raise exception 'NATIVE_STOCK_REVIEW_REQUIRED';end if;
  total:=total+row.delta::integer;
  if not exists(select 1 from pg_catalog.jsonb_array_elements(proof->'pending') p where p->>'effectId'=row.effect_id::text) then
   if row.kind='INVENTORY_COUNT' then raise exception 'NATIVE_STOCK_COUNT_REVIEW_REQUIRED';end if;
   other_delta:=other_delta+row.delta::integer;
   others:=others||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('operationId',row.operation_id,'effectId',row.effect_id,'delta',row.delta,'remoteSequence',row.remote_sequence::text,'kind',row.kind));
  end if;
 end loop;
 if cur::numeric-total<>(proof->>'remoteBaseQty')::numeric or (proof->>'remoteBaseQty')::numeric+own<>(proof->>'effectiveQty')::numeric or (proof->>'effectiveQty')::numeric+other_delta<>cur then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
 return pg_catalog.jsonb_build_object('protocol','ventard.stock.merge.1','quotedBefore',proof->>'effectiveQty','appliedBefore',cur::text,'concurrent',others);
end $f$;
revoke all on function public.native_shared_ready_v1(uuid),public.native_shared_stock_v1(uuid,text,uuid,uuid,uuid,jsonb,integer,bigint) from public,anon,authenticated;

do $sale_patch$ declare source text;needle text;
begin
 select pg_catalog.pg_get_functiondef('public.native_sales_submit_base_v1(text,text,text,text)'::regprocedure) into source;
 if pg_catalog.strpos(source,'native_shared_stock_v1')=0 then
  needle:='if version<>expected_version or num<>cur or public.native_sales_int_v1(proof->''effectiveQty'',2147483647)<>cur or eff->>''expectedRevision'' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object(''quantity'',proof->>''effectiveQty'',''remoteSequence'',proof->>''remoteSequence'',''pending'',proof->''pending''))) then raise exception ''NATIVE_STOCK_VERSION_CONFLICT'';end if;';
  if pg_catalog.strpos(source,needle)=0 or pg_catalog.strpos(source,'declare v jsonb;')=0 then raise exception 'NATIVE_SHARED_PARENT_INCOMPATIBLE';end if;
  source:=pg_catalog.replace(source,'declare v jsonb;','declare shared_merge jsonb;v jsonb;');
  source:=pg_catalog.replace(source,needle,'shared_merge:=null;if public.native_sales_int_v1(proof->''effectiveQty'',2147483647)<>num or eff->>''expectedRevision'' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object(''quantity'',proof->>''effectiveQty'',''remoteSequence'',proof->>''remoteSequence'',''pending'',proof->''pending''))) then raise exception ''NATIVE_STOCK_VERSION_CONFLICT'';end if;if version<>expected_version or num<>cur then if num+delta<0 then raise exception ''NATIVE_STOCK_UNAVAILABLE'';end if;shared_merge:=public.native_shared_stock_v1(n,k,b,i,pid,proof,cur,version);end if;');
  needle:='stock:=stock||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(''productId'',pid,''after'',after::text,''version'',seq::text));';
  if pg_catalog.strpos(source,needle)=0 then raise exception 'NATIVE_SHARED_PARENT_INCOMPATIBLE';end if;
  source:=pg_catalog.replace(source,needle,'stock:=stock||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(''productId'',pid,''after'',after::text,''version'',seq::text)||case when shared_merge is null then ''{}''::jsonb else pg_catalog.jsonb_build_object(''merge'',shared_merge) end);');execute source;
 end if;
end $sale_patch$;

-- Inventory loss and reservation are valid durable states in a new download.
-- Preserve old frozen captures; only subsequent snapshots use this mapping.
do $serial_download$ declare fn record;source text;begin
 if pg_catalog.to_regprocedure('public.native_warranty_current_v1(uuid,text,uuid,uuid,text)') is not null then
  select pg_catalog.pg_get_functiondef('public.native_warranty_current_v1(uuid,text,uuid,uuid,text)'::regprocedure) into source;
  if pg_catalog.strpos(source,'when ''merma'' then ''LOST''')=0 then execute pg_catalog.replace(source,'when ''apartado'' then ''RESERVED'' else null end','when ''apartado'' then ''RESERVED'' when ''merma'' then ''LOST'' else null end');end if;
 end if;
 for fn in select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'native_sales_bootstrap%' and p.pronargs=7 loop
  select pg_catalog.pg_get_functiondef(fn.oid) into source;
  if pg_catalog.strpos(source,'NATIVE_SERIAL_SOURCE_UNVERIFIABLE')>0 then
   source:=pg_catalog.replace(source,'s.estado not in(''disponible'',''vendido'',''reservado'')','s.estado not in(''disponible'',''vendido'',''reservado'',''apartado'',''merma'')');
   source:=pg_catalog.replace(source,'when ''reservado'' then ''RESERVED'' else ''SOLD'' end','when ''reservado'' then ''RESERVED'' when ''apartado'' then ''RESERVED'' when ''merma'' then ''LOST'' else ''SOLD'' end');execute source;
  end if;
 end loop;
end $serial_download$;
do $rename_shared$ begin
 if pg_catalog.to_regprocedure('public.native_sales_submit_shared_base_v1(text,text,text,text)') is null then alter function public.native_sales_submit_v1(text,text,text,text) rename to native_sales_submit_shared_base_v1;end if;
 if pg_catalog.to_regprocedure('public.native_sales_feed_shared_base_v1(uuid,uuid,uuid,bigint,text,uuid,bigint)') is null then alter function public.native_sales_feed_v1(uuid,uuid,uuid,bigint,text,uuid,bigint) rename to native_sales_feed_shared_base_v1;end if;
 if pg_catalog.to_regprocedure('public.native_sales_bootstrap_shared_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)') is null then alter function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) rename to native_sales_bootstrap_shared_base_v1;end if;
end $rename_shared$;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;begin if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 then raise exception 'NATIVE_COMMAND_SIZE';end if;v:=p_intent::jsonb;perform public.native_sales_context_v1((v->>'negocioId')::uuid,(v->>'installationId')::uuid,(v->>'originDeviceId')::uuid,(v->>'writerEpoch')::bigint,v->'scope'->>'type',(v->'scope'->>'sucursalId')::uuid);perform public.native_shared_ready_v1((v->>'negocioId')::uuid);return public.native_sales_submit_shared_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end $f$;
create or replace function public.native_sales_feed_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_after bigint) returns jsonb language plpgsql stable security definer set search_path='' as $f$
begin perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);perform public.native_shared_ready_v1(p_negocio_id);return public.native_sales_feed_shared_base_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,p_after);end $f$;
create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
begin perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);perform public.native_shared_ready_v1(p_negocio_id);return public.native_sales_bootstrap_shared_base_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,p_snapshot_id);end $f$;
do $read_compat$ declare spec record;source text;needle text:='perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);';begin
 for spec in select signature from (values ('public.native_sales_lookup_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,text)'),('public.native_sales_bootstrap_page_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,integer)')) f(signature) loop
  select pg_catalog.pg_get_functiondef(spec.signature::regprocedure) into source;
  if pg_catalog.strpos(source,'native_shared_ready_v1')=0 then
   if pg_catalog.strpos(source,needle)=0 then raise exception 'NATIVE_SHARED_PARENT_INCOMPATIBLE';end if;
   execute pg_catalog.replace(source,needle,needle||'perform public.native_shared_ready_v1(p_negocio_id);');
  end if;
 end loop;
end $read_compat$;
revoke all on function public.native_sales_submit_shared_base_v1(text,text,text,text),public.native_sales_feed_shared_base_v1(uuid,uuid,uuid,bigint,text,uuid,bigint),public.native_sales_bootstrap_shared_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.native_sales_submit_v1(text,text,text,text),public.native_sales_feed_v1(uuid,uuid,uuid,bigint,text,uuid,bigint),public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) from public,anon;
grant execute on function public.native_sales_submit_v1(text,text,text,text),public.native_sales_feed_v1(uuid,uuid,uuid,bigint,text,uuid,bigint),public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) to authenticated;
revoke all on function public.native_web_context_v1(jsonb) from public,anon,authenticated;
revoke all on function public.native_web_mode_v1(uuid,uuid),public.native_web_enroll_v1(uuid,uuid,uuid,uuid,uuid),public.native_web_submit_v1(jsonb,text,text,text,text),public.native_web_lookup_v1(jsonb,uuid,text),public.native_web_feed_v1(jsonb,bigint) from public,anon,authenticated;
grant execute on function public.native_web_mode_v1(uuid,uuid),public.native_web_enroll_v1(uuid,uuid,uuid,uuid,uuid),public.native_web_submit_v1(jsonb,text,text,text,text),public.native_web_lookup_v1(jsonb,uuid,text),public.native_web_feed_v1(jsonb,bigint) to authenticated;
revoke all on function public.native_web_bootstrap_v1(jsonb,uuid),public.native_web_bootstrap_page_v1(jsonb,uuid,integer) from public,anon,authenticated;
grant execute on function public.native_web_bootstrap_v1(jsonb,uuid),public.native_web_bootstrap_page_v1(jsonb,uuid,integer) to authenticated;
revoke all on function public.native_web_service_plan_v1(jsonb,text,jsonb,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.native_web_service_plan_v1(jsonb,text,jsonb,jsonb,text,text,text) to authenticated;
commit;
