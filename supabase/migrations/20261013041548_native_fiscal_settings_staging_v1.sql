-- STAGING ONLY. Does not authorize DGII use or reuse assigned numbers.
begin;
create table if not exists public.native_fiscal_settings_ledger_v1 (
 negocio_id uuid not null,request_id uuid not null,actor_id uuid not null,
 request_text text not null,payload_hash text not null check(payload_hash~'^[0-9a-f]{64}$'),
 receipt jsonb not null,primary key(negocio_id,request_id)
);
alter table public.native_fiscal_settings_ledger_v1 enable row level security;
revoke all on public.native_fiscal_settings_ledger_v1 from public,anon,authenticated;
create or replace function public.native_fiscal_settings_configuration_v1(n uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare r public.ncf_secuencias%rowtype;c jsonb;
begin select * into r from public.ncf_secuencias where negocio_id=n;
 if not found then return null;end if;
 if r.tipo is null or r.tipo not in('B01','B02') or r.desde is null or r.hasta is null or r.proximo is null or r.habilitado is null or r.desde<1 or r.hasta<r.desde or r.hasta>99999999 or r.proximo<r.desde or r.proximo>r.hasta+1 then raise exception 'FISCAL_SETTINGS_SOURCE_UNVERIFIABLE';end if;
 c:=pg_catalog.jsonb_build_object('type',r.tipo,'first',r.desde::text,'last',r.hasta::text,'next',r.proximo::text,'enabled',r.habilitado);
 return c||pg_catalog.jsonb_build_object('revision',public.native_sales_hash_v1(public.native_sales_canonical_v1(c)));
end $f$;
revoke all on function public.native_fiscal_settings_configuration_v1(uuid) from public,anon,authenticated;
create or replace function public.native_fiscal_settings_context_v1(n uuid,i uuid,d uuid,e bigint,k text,b uuid) returns text language plpgsql security definer set search_path='' as $f$
declare role text;
begin role:=public.native_sales_context_v1(n,i,d,e,k,b);
 if role not in('owner','admin') then raise exception using errcode='42501',message='FISCAL_SETTINGS_CONTEXT_DENIED';end if;
 if not exists(select 1 from public.native_staging_licenses_v1 where negocio_id=n and plan_active and (access_until_ms is null or access_until_ms>=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000))) then raise exception using errcode='42501',message='FISCAL_SETTINGS_CONTEXT_DENIED';end if;
 if not exists(select 1 from public.native_sales_mode_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b) then raise exception using errcode='42501',message='NATIVE_ACTIVATION_REQUIRED';end if;
 perform 1 from public.native_installations_v1 where negocio_id=n and installation_id=i for share;
 return role;
end $f$;
revoke all on function public.native_fiscal_settings_context_v1(uuid,uuid,uuid,bigint,text,uuid) from public,anon,authenticated;
create or replace function public.native_fiscal_settings_read_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
begin perform public.native_fiscal_settings_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-fiscal:'||p_negocio_id::text,0));
 return pg_catalog.jsonb_build_object('protocol','ventard.fiscal.settings.1','tenantId',p_negocio_id,'installationId',p_installation_id,'deviceId',p_device_id,'writerEpoch',p_writer_epoch::text,'actorId',auth.uid(),'scopeType',p_scope_kind,'branchId',p_sucursal_id,'configuration',public.native_fiscal_settings_configuration_v1(p_negocio_id),'capturedAtMs',pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text);
end $f$;
create or replace function public.native_fiscal_settings_validate_v1(p_request text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;n uuid;i uuid;d uuid;b uuid;e bigint;role text;field text;
begin
 if p_request is null or pg_catalog.octet_length(p_request)>8192 then raise exception 'FISCAL_SETTINGS_REQUEST_INVALID';end if;
 v:=p_request::jsonb;
 if pg_catalog.jsonb_typeof(v) is distinct from 'object' or (select count(*) from pg_catalog.jsonb_object_keys(v))<>16 or not(v ?& array['protocol','version','requestId','actorId','tenantId','installationId','deviceId','writerEpoch','scopeType','branchId','permissionGrantId','expectedRevision','type','first','last','enabled']) or v->>'protocol' is distinct from 'ventard.fiscal.settings.request.1' or v->>'version' is distinct from '1' or v->>'type' is null or v->>'type' not in('B01','B02') or pg_catalog.jsonb_typeof(v->'enabled') is distinct from 'boolean' or v->>'expectedRevision' is null or (v->>'expectedRevision'<>'0' and v->>'expectedRevision'!~'^[0-9a-f]{64}$') or public.native_sales_canonical_v1(v)<>p_request or public.native_sales_hash_v1(p_request) is distinct from p_hash then raise exception 'FISCAL_SETTINGS_REQUEST_INVALID';end if;
 foreach field in array array['requestId','actorId','tenantId','installationId','deviceId','permissionGrantId'] loop if (v->>field)::uuid::text is distinct from v->>field then raise exception 'FISCAL_SETTINGS_REQUEST_INVALID';end if;end loop;
 n:=(v->>'tenantId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'deviceId')::uuid;b:=(v->>'branchId')::uuid;e:=public.native_sales_int_v1(v->'writerEpoch')::bigint;
 if b is not null and b::text is distinct from v->>'branchId' then raise exception 'FISCAL_SETTINGS_REQUEST_INVALID';end if;
 if (v->>'actorId')::uuid is distinct from auth.uid() then raise exception using errcode='42501',message='FISCAL_SETTINGS_CONTEXT_DENIED';end if;
 role:=public.native_fiscal_settings_context_v1(n,i,d,e,v->>'scopeType',b);
 if not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role) then raise exception using errcode='42501',message='FISCAL_SETTINGS_CONTEXT_DENIED';end if;
 if public.native_sales_int_v1(v->'first',99999999)<1 or public.native_sales_int_v1(v->'last',99999999)<public.native_sales_int_v1(v->'first',99999999) then raise exception 'FISCAL_SETTINGS_REQUEST_INVALID';end if;
 return v;
end $f$;
revoke all on function public.native_fiscal_settings_validate_v1(text,text) from public,anon,authenticated;
create or replace function public.native_fiscal_settings_lookup_v1(p_request text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;r public.native_fiscal_settings_ledger_v1%rowtype;
begin v:=public.native_fiscal_settings_validate_v1(p_request,p_hash);
 select * into r from public.native_fiscal_settings_ledger_v1 where negocio_id=(v->>'tenantId')::uuid and request_id=(v->>'requestId')::uuid;
 if not found then return pg_catalog.jsonb_build_object('status','NOT_FOUND','requestId',v->>'requestId','payloadHash',p_hash);end if;
 if r.request_text<>p_request or r.payload_hash<>p_hash or r.actor_id<>auth.uid() then raise exception 'FISCAL_SETTINGS_ID_CONFLICT';end if;return r.receipt;
end $f$;
create or replace function public.native_fiscal_settings_finish_v1(p_request text,p_hash text,p_abandon boolean) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;n uuid;r public.native_fiscal_settings_ledger_v1%rowtype;c jsonb;next_value bigint;receipt jsonb;
begin v:=public.native_fiscal_settings_validate_v1(p_request,p_hash);n:=(v->>'tenantId')::uuid;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-fiscal:'||n::text,0));
 select * into r from public.native_fiscal_settings_ledger_v1 where negocio_id=n and request_id=(v->>'requestId')::uuid;
 if found then if r.request_text<>p_request or r.payload_hash<>p_hash or r.actor_id<>auth.uid() then raise exception 'FISCAL_SETTINGS_ID_CONFLICT';end if;return r.receipt;end if;
 if not p_abandon then
  perform 1 from public.ncf_secuencias where negocio_id=n for update;c:=public.native_fiscal_settings_configuration_v1(n);
  if coalesce(c->>'revision','0')<>v->>'expectedRevision' then raise exception 'FISCAL_SETTINGS_VERSION_CONFLICT';end if;
  -- One source sequence per business. Kind replacement requires a separate,
  -- proven handoff of all old allocations; never discard another kind's cursor.
  if c is not null and c->>'type'<>v->>'type' then raise exception 'FISCAL_SETTINGS_KIND_TRANSITION_REQUIRED';end if;
  next_value:=greatest(public.native_sales_int_v1(v->'first',99999999)::bigint,coalesce((c->>'next')::bigint,1));
  if public.native_sales_int_v1(v->'last',99999999)<next_value-1 then raise exception 'FISCAL_SETTINGS_ALLOCATED_RANGE_CONFLICT';end if;
  insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n) on conflict do nothing;
  insert into public.ncf_secuencias(negocio_id,tipo,desde,hasta,proximo,habilitado) values(n,v->>'type',(v->>'first')::bigint,(v->>'last')::bigint,next_value,(v->>'enabled')::boolean)
   on conflict(negocio_id) do update set tipo=excluded.tipo,desde=excluded.desde,hasta=excluded.hasta,proximo=excluded.proximo,habilitado=excluded.habilitado;
  delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;
 end if;
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.fiscal.settings.receipt.1','status',case when p_abandon then 'ABANDONED' else 'APPLIED' end,'request',v,'payloadHash',p_hash,'configuration',public.native_fiscal_settings_configuration_v1(n),'capturedAtMs',pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text);
 insert into public.native_fiscal_settings_ledger_v1 values(n,(v->>'requestId')::uuid,auth.uid(),p_request,p_hash,receipt);return receipt;
end $f$;
revoke all on function public.native_fiscal_settings_finish_v1(text,text,boolean) from public,anon,authenticated;
create or replace function public.native_fiscal_settings_submit_v1(p_request text,p_hash text) returns jsonb language sql security definer set search_path='' as $f$ select public.native_fiscal_settings_finish_v1(p_request,p_hash,false) $f$;
create or replace function public.native_fiscal_settings_abandon_v1(p_request text,p_hash text) returns jsonb language sql security definer set search_path='' as $f$ select public.native_fiscal_settings_finish_v1(p_request,p_hash,true) $f$;
revoke all on function public.native_fiscal_settings_read_v1(uuid,uuid,uuid,bigint,text,uuid),public.native_fiscal_settings_lookup_v1(text,text),public.native_fiscal_settings_submit_v1(text,text),public.native_fiscal_settings_abandon_v1(text,text) from public,anon,authenticated;
grant execute on function public.native_fiscal_settings_read_v1(uuid,uuid,uuid,bigint,text,uuid),public.native_fiscal_settings_lookup_v1(text,text),public.native_fiscal_settings_submit_v1(text,text),public.native_fiscal_settings_abandon_v1(text,text) to authenticated;
commit;
