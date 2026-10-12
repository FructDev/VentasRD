-- STAGING QA only. No plan is upgraded by this migration.
-- Old signed grants remain valid; missing tier never authorizes Pro services.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001'::uuid and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002'::uuid and nombre='PRO00 QA B - SINTETICO'))<>2
 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;
alter table public.native_staging_licenses_v1 add column if not exists plan_tier text check(plan_tier in('basico','pro'));
create or replace function public.native_registrar_instalacion_v1(
 p_registration_id uuid,p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,
 p_scope_kind text,p_sucursal_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
 v_actor uuid:=auth.uid();v_role text;v_request jsonb;v_old jsonb;v_receipt jsonb;
 v_install public.native_installations_v1%rowtype;v_license public.native_staging_licenses_v1%rowtype;
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
 select * into v_license from public.native_staging_licenses_v1 where negocio_id=p_negocio_id for share;
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
