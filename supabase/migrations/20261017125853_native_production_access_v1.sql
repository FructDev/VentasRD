-- Production access preparation. DDL only; does not enable any business.
-- Real entitlement source: negocios. No QA licences, users, PINs, NCF or seeds.
-- Reviewed pilot target: Pica Chicken (864d08e5-2975-4b2d-a1e2-ba5a14f3d677).
begin;
do $guard$ begin
 if pg_catalog.to_regclass('public.native_staging_licenses_v1') is not null then raise exception 'NATIVE_PRODUCTION_ONLY';end if;
end $guard$;
create table if not exists public.native_production_cohort_v1(
 negocio_id uuid primary key references public.negocios(id),enabled boolean not null default false,
 approved_at timestamptz,check(not enabled or approved_at is not null));
alter table public.native_production_cohort_v1 enable row level security;
revoke all on public.native_production_cohort_v1 from public,anon,authenticated;
create table if not exists public.native_installations_v1(
 negocio_id uuid not null references public.negocios(id),
 installation_id uuid not null,device_id uuid not null,
 scope_kind text not null check(scope_kind in('GLOBAL','BRANCH')),
 sucursal_id uuid,writer_epoch bigint not null default 1 check(writer_epoch between 1 and 9007199254740991),
 registered_by uuid not null references auth.users(id),
 status text not null default 'REGISTERED' check(status in('REGISTERED','REVOKED')),
 primary key(negocio_id,installation_id),unique(negocio_id,device_id),
 check((scope_kind='GLOBAL' and sucursal_id is null) or(scope_kind='BRANCH' and sucursal_id is not null))
);
create table if not exists public.native_actor_sequences_v1(
 negocio_id uuid not null,installation_id uuid not null,actor_id uuid not null references auth.users(id),
 grant_sequence bigint not null check(grant_sequence between 1 and 9007199254740991),primary key(negocio_id,installation_id,actor_id),
 foreign key(negocio_id,installation_id) references public.native_installations_v1(negocio_id,installation_id)
);
create table if not exists public.native_registration_requests_v1(
 actor_id uuid not null references auth.users(id),request_id uuid not null,
 request jsonb not null,receipt jsonb not null,primary key(actor_id,request_id)
);


create or replace function public.native_member_role_v1(p_negocio_id uuid) returns text
 language sql stable security definer set search_path='' as $fn$
 select case when n."dueño_id"=auth.uid() then 'owner' else (
  select u.rol from public.usuarios_negocio u where u.negocio_id=n.id and u.user_id=auth.uid()
   and u.activo=true and u.rol in('admin','vendedor','cajero') order by u.id limit 1) end
 from public.negocios n join public.native_production_cohort_v1 c on c.negocio_id=n.id and c.enabled
 where auth.uid() is not null and n.id=p_negocio_id
$fn$;
revoke all on function public.native_member_role_v1(uuid) from public,anon;
grant execute on function public.native_member_role_v1(uuid) to authenticated;
create or replace view public.native_entitlements_v1 with(security_barrier=true) as
 select n.id as negocio_id,n.plan_activo as plan_active,n.plan_tier,
 n.acceso_hasta as access_until_ms,n.trial_hasta as trial_until_ms
 from public.negocios n where public.native_member_role_v1(n.id) is not null;
revoke all on public.native_entitlements_v1 from public,anon,authenticated;
grant select on public.native_entitlements_v1 to authenticated;
alter table public.native_installations_v1 enable row level security;
revoke all on public.native_installations_v1 from public,anon,authenticated;
grant select on public.native_installations_v1 to authenticated;
alter table public.native_actor_sequences_v1 enable row level security;
revoke all on public.native_actor_sequences_v1 from public,anon,authenticated;
grant select on public.native_actor_sequences_v1 to authenticated;
alter table public.native_registration_requests_v1 enable row level security;
revoke all on public.native_registration_requests_v1 from public,anon,authenticated;
grant select on public.native_registration_requests_v1 to authenticated;
drop policy if exists native_installation_read_v1 on public.native_installations_v1;
create policy native_installation_read_v1 on public.native_installations_v1 for select to authenticated using(public.native_member_role_v1(negocio_id) is not null);
drop policy if exists native_sequence_read_v1 on public.native_actor_sequences_v1;
create policy native_sequence_read_v1 on public.native_actor_sequences_v1 for select to authenticated using(actor_id=auth.uid() and public.native_member_role_v1(negocio_id) is not null);
drop policy if exists native_request_read_v1 on public.native_registration_requests_v1;
create policy native_request_read_v1 on public.native_registration_requests_v1 for select to authenticated using(actor_id=auth.uid() and public.native_member_role_v1((request->>'tenantId')::uuid) is not null);
create or replace function public.native_registrar_instalacion_v1(
 p_registration_id uuid,p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,
 p_scope_kind text,p_sucursal_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
 v_actor uuid:=auth.uid();v_role text;v_request jsonb;v_old jsonb;v_receipt jsonb;
 v_install public.native_installations_v1%rowtype;v_license public.native_entitlements_v1%rowtype;
 v_seq bigint;v_ms text;
begin
 if v_actor is null then raise exception using errcode='42501',message='NATIVE_AUTH_REQUIRED';end if;
 if p_registration_id is null or p_installation_id is null or p_device_id is null or p_negocio_id is null
  or p_scope_kind not in('GLOBAL','BRANCH') or p_scope_kind is null
  or(p_scope_kind='GLOBAL' and p_sucursal_id is not null)or(p_scope_kind='BRANCH' and p_sucursal_id is null)
 then raise exception using errcode='22023',message='NATIVE_REQUEST_INVALID';end if;
 v_role:=public.native_member_role_v1(p_negocio_id);
 if v_role is null then raise exception using errcode='42501',message='NATIVE_TENANT_DENIED';end if;
 if p_sucursal_id is not null and not exists(select 1 from public.sucursales s where s.id=p_sucursal_id and s.negocio_id=p_negocio_id)
 then raise exception using errcode='42501',message='NATIVE_BRANCH_DENIED';end if;
 select * into v_license from public.native_entitlements_v1 where negocio_id=p_negocio_id for share;
 if not found then raise exception using errcode='55000',message='NATIVE_LICENSE_UNAVAILABLE';end if;
 v_request:=pg_catalog.jsonb_build_object('registrationId',p_registration_id,'tenantId',p_negocio_id,'installationId',p_installation_id,'deviceId',p_device_id,'scopeType',p_scope_kind,'branchId',p_sucursal_id);
 -- Serialize registration/replay/device binding per tenant before looking up.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-register:'||p_negocio_id::text,0));
 select request,receipt into v_old,v_receipt from public.native_registration_requests_v1 where actor_id=v_actor and request_id=p_registration_id;
 if found then
  if v_old<>v_request then raise exception using errcode='22023',message='NATIVE_REGISTRATION_CONFLICT';end if;
  if v_receipt->>'role'<>v_role then raise exception using errcode='42501',message='NATIVE_ROLE_CHANGED';end if;
  if v_receipt->'license' is distinct from (pg_catalog.jsonb_build_object('planActive',v_license.plan_active,'accessUntilMs',v_license.access_until_ms::text,'trialUntilMs',v_license.trial_until_ms::text) || case when v_license.plan_tier is null then '{}'::jsonb else pg_catalog.jsonb_build_object('planTier',v_license.plan_tier) end)
  then raise exception using errcode='42501',message='NATIVE_POLICY_CHANGED';end if;
  if not exists(select 1 from public.native_installations_v1 where negocio_id=p_negocio_id and installation_id=p_installation_id and status='REGISTERED')
  then raise exception using errcode='42501',message='NATIVE_DEVICE_REVOKED';end if;
  if not exists(select 1 from public.native_installations_v1 where negocio_id=p_negocio_id and installation_id=p_installation_id and writer_epoch::text=v_receipt->>'writerEpoch')
  then raise exception using errcode='42501',message='NATIVE_EPOCH_CHANGED';end if;
  return v_receipt;
 end if;
 select * into v_install from public.native_installations_v1 where negocio_id=p_negocio_id and installation_id=p_installation_id for update;
 if found then
  if v_install.device_id<>p_device_id or v_install.scope_kind<>p_scope_kind or v_install.sucursal_id is distinct from p_sucursal_id or v_install.status<>'REGISTERED'
  then raise exception using errcode='42501',message='NATIVE_DEVICE_CONTEXT_MISMATCH';end if;
 else
  if v_role not in('owner','admin') then raise exception using errcode='42501',message='NATIVE_OWNER_SETUP_REQUIRED';end if;
  insert into public.native_installations_v1(negocio_id,installation_id,device_id,scope_kind,sucursal_id,registered_by)
   values(p_negocio_id,p_installation_id,p_device_id,p_scope_kind,p_sucursal_id,v_actor) returning * into v_install;
 end if;
 insert into public.native_actor_sequences_v1(negocio_id,installation_id,actor_id,grant_sequence) values(p_negocio_id,p_installation_id,v_actor,1)
 on conflict(negocio_id,installation_id,actor_id)do update set grant_sequence=public.native_actor_sequences_v1.grant_sequence+1 returning grant_sequence into v_seq;
 v_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text;
 v_receipt:=v_request||pg_catalog.jsonb_build_object('actorId',v_actor,'role',v_role,'writerEpoch',v_install.writer_epoch::text,'grantSequence',v_seq::text,'issuedAtMs',v_ms,
 'license',(pg_catalog.jsonb_build_object('planActive',v_license.plan_active,'accessUntilMs',v_license.access_until_ms::text,'trialUntilMs',v_license.trial_until_ms::text) || case when v_license.plan_tier is null then '{}'::jsonb else pg_catalog.jsonb_build_object('planTier',v_license.plan_tier) end));
 insert into public.native_registration_requests_v1(actor_id,request_id,request,receipt)values(v_actor,p_registration_id,v_request,v_receipt);
 return v_receipt;
end $fn$;
revoke all on function public.native_registrar_instalacion_v1(uuid,uuid,uuid,uuid,text,uuid) from public,anon;
grant execute on function public.native_registrar_instalacion_v1(uuid,uuid,uuid,uuid,text,uuid) to authenticated;



commit;
