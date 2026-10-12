-- STAGING ONLY. Exact v2 request identity; no legacy policy/schema cleanup.
-- Shares the locked ncf_secuencias cursor with v1; NEVER delegates to v1 RPC.
-- No DGII authorization is invented, no sequence/range is seeded by this file.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001'::uuid and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002'::uuid and nombre='PRO00 QA B - SINTETICO'))<>2
 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;

create table if not exists public.native_fiscal_requests_v2 (
 negocio_id uuid not null references public.negocios(id), request_id uuid not null,
 actor_id uuid not null references auth.users(id), installation_id uuid not null,
 request jsonb not null, payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
 receipt jsonb not null, primary key(negocio_id,request_id),
 foreign key(negocio_id,installation_id) references public.native_installations_v1(negocio_id,installation_id),
 check(receipt->>'status' in('ALLOCATED','NO_BLOCK'))
);
alter table public.native_fiscal_requests_v2 enable row level security;
revoke all on public.native_fiscal_requests_v2 from public,anon,authenticated;
grant select on public.native_fiscal_requests_v2 to authenticated;
drop policy if exists native_fiscal_read_v2 on public.native_fiscal_requests_v2;
create policy native_fiscal_read_v2 on public.native_fiscal_requests_v2 for select to authenticated
 using(actor_id=auth.uid() and public.native_member_role_v1(negocio_id) is not null);

-- Internal validation, called on allocate AND lookup/replay. Fixed C-N1 shape
-- contains only UUIDs, enum literals and canonical decimal strings.
create or replace function public.native_fiscal_validate_v2(p_request jsonb,p_hash text)
 returns void language plpgsql security definer set search_path='' as $fn$
declare v_tenant uuid;v_install uuid;v_device uuid;v_branch uuid;v_epoch bigint;v_bytes text;
begin
 if auth.uid() is null then raise exception using errcode='42501',message='NATIVE_AUTH_REQUIRED';end if;
 if p_request is null or pg_catalog.jsonb_typeof(p_request)<>'object'
 or (select count(*) from pg_catalog.jsonb_object_keys(p_request))<>11
 or not (p_request ?& array['actorId','branchId','deviceId','installationId','kind','quantity','requestId','scopeType','tenantId','version','writerEpoch'])
 or p_request->>'version' is distinct from '2' or p_request->>'quantity' is distinct from '20'
 or p_request->>'kind' is null or p_request->>'kind' not in('B01','B02')
 or p_request->>'scopeType' is null or p_request->>'scopeType' not in('GLOBAL','BRANCH')
 or p_request->>'writerEpoch' is null or p_request->>'writerEpoch' !~ '^[1-9][0-9]{0,15}$'
 or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
 then raise exception using errcode='22023',message='NATIVE_FISCAL_REQUEST_INVALID';end if;
 -- UUID cast errors reject without side effects. Exact canonical equality also
 -- rejects JSON numbers, uppercase UUIDs, alternate spellings and extra fields.
 v_tenant:=(p_request->>'tenantId')::uuid;v_install:=(p_request->>'installationId')::uuid;
 v_device:=(p_request->>'deviceId')::uuid;v_branch:=(p_request->>'branchId')::uuid;
 v_epoch:=(p_request->>'writerEpoch')::bigint;
 if v_tenant is null or v_install is null or v_device is null
 or (p_request->>'requestId')::uuid is null or (p_request->>'actorId')::uuid is distinct from auth.uid()
 or v_epoch>9007199254740991
 or(p_request->>'scopeType'='GLOBAL' and v_branch is not null)
 or(p_request->>'scopeType'='BRANCH' and v_branch is null)
 then raise exception using errcode='42501',message='NATIVE_FISCAL_CONTEXT_DENIED';end if;
 v_bytes:=pg_catalog.format('{"actorId":"%s","branchId":%s,"deviceId":"%s","installationId":"%s","kind":"%s","quantity":"20","requestId":"%s","scopeType":"%s","tenantId":"%s","version":"2","writerEpoch":"%s"}',
 auth.uid()::text,coalesce(pg_catalog.to_json(v_branch)::text,'null'),v_device::text,v_install::text,
 p_request->>'kind',(p_request->>'requestId')::uuid::text,p_request->>'scopeType',v_tenant::text,v_epoch::text);
 if v_bytes::jsonb<>p_request or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_bytes,'UTF8')),'hex')<>p_hash
 then raise exception using errcode='22023',message='NATIVE_FISCAL_HASH_CONFLICT';end if;
 if public.native_member_role_v1(v_tenant) is null then raise exception using errcode='42501',message='NATIVE_TENANT_DENIED';end if;
 if not exists(select 1 from public.native_staging_licenses_v1 l where l.negocio_id=v_tenant and l.plan_active
 and(l.access_until_ms is null or l.access_until_ms>=extract(epoch from pg_catalog.statement_timestamp())*1000))
 then raise exception using errcode='42501',message='NATIVE_LICENSE_DENIED';end if;
 perform 1 from public.native_installations_v1 i where i.negocio_id=v_tenant and i.installation_id=v_install
 and i.device_id=v_device and i.writer_epoch=v_epoch and i.status='REGISTERED'
 and i.scope_kind=p_request->>'scopeType' and i.sucursal_id is not distinct from v_branch
 and exists(select 1 from public.native_actor_sequences_v1 a where a.negocio_id=v_tenant and a.installation_id=v_install and a.actor_id=auth.uid()) for share;
 if not found then raise exception using errcode='42501',message='NATIVE_INSTALLATION_DENIED';end if;
 if v_branch is not null and not exists(select 1 from public.sucursales s where s.id=v_branch and s.negocio_id=v_tenant)
 then raise exception using errcode='42501',message='NATIVE_BRANCH_DENIED';end if;
end $fn$;
revoke all on function public.native_fiscal_validate_v2(jsonb,text) from public,anon,authenticated;

create or replace function public.native_fiscal_lookup_v2(p_request jsonb,p_hash text)
 returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_old public.native_fiscal_requests_v2%rowtype;
begin
 perform public.native_fiscal_validate_v2(p_request,p_hash);
 select * into v_old from public.native_fiscal_requests_v2 where negocio_id=(p_request->>'tenantId')::uuid and request_id=(p_request->>'requestId')::uuid;
 if not found then return pg_catalog.jsonb_build_object('status','NOT_FOUND','requestId',p_request->>'requestId','payloadHash',p_hash);end if;
 if v_old.request<>p_request or v_old.payload_hash<>p_hash then raise exception using errcode='22023',message='NATIVE_FISCAL_ID_CONFLICT';end if;
 return v_old.receipt;
end $fn$;

create or replace function public.native_fiscal_allocate_v2(p_request jsonb,p_hash text)
 returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_tenant uuid;v_old public.native_fiscal_requests_v2%rowtype;v_seq public.ncf_secuencias%rowtype;
 v_first bigint;v_last bigint;v_reason text;v_status text;v_receipt jsonb;
begin
 perform public.native_fiscal_validate_v2(p_request,p_hash);
 v_tenant:=(p_request->>'tenantId')::uuid;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-fiscal:'||v_tenant::text,0));
 select * into v_old from public.native_fiscal_requests_v2 where negocio_id=v_tenant and request_id=(p_request->>'requestId')::uuid;
 if found then
  if v_old.request<>p_request or v_old.payload_hash<>p_hash then raise exception using errcode='22023',message='NATIVE_FISCAL_ID_CONFLICT';end if;
  return v_old.receipt;
 end if;
 select * into v_seq from public.ncf_secuencias where negocio_id=v_tenant for update;
 if not found then v_reason:='NOT_CONFIGURED';
 elsif not v_seq.habilitado then v_reason:='DISABLED';
 elsif v_seq.tipo<>p_request->>'kind' then v_reason:='KIND_NOT_CONFIGURED';
 elsif v_seq.desde<1 or v_seq.hasta>99999999 or v_seq.hasta<v_seq.desde or v_seq.proximo<v_seq.desde then
  raise exception using errcode='22023',message='NATIVE_FISCAL_SEQUENCE_INVALID';
 elsif v_seq.proximo>v_seq.hasta then v_reason:='EXHAUSTED';
 else v_first:=v_seq.proximo;v_last:=least(v_seq.hasta,v_first+19);end if;
 v_status:=case when v_reason is null then 'ALLOCATED' else 'NO_BLOCK' end;
 v_receipt:=p_request||pg_catalog.jsonb_build_object('payloadHash',p_hash,'status',v_status,'first',v_first::text,'last',v_last::text,'sourceRef',pg_catalog.gen_random_uuid()::text,'reason',v_reason);
 -- The cursor and immutable receipt are one PG transaction. Lost replies and
 -- concurrent repeats return this same receipt without advancing it again.
 insert into public.native_fiscal_requests_v2(negocio_id,request_id,actor_id,installation_id,request,payload_hash,receipt)
 values(v_tenant,(p_request->>'requestId')::uuid,auth.uid(),(p_request->>'installationId')::uuid,p_request,p_hash,v_receipt);
 if v_status='ALLOCATED' then update public.ncf_secuencias set proximo=v_last+1 where negocio_id=v_tenant;end if;
 return v_receipt;
end $fn$;
revoke all on function public.native_fiscal_lookup_v2(jsonb,text),public.native_fiscal_allocate_v2(jsonb,text) from public,anon,authenticated;
grant execute on function public.native_fiscal_lookup_v2(jsonb,text),public.native_fiscal_allocate_v2(jsonb,text) to authenticated;
commit;
