-- Staging only. No membership, invitation, grant or licence changes on install.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;
alter table public.usuarios_negocio add column if not exists invite_expires_at timestamptz;
-- Preserve the original cashier role: signed POS-only access, never admin.
create or replace function public.native_member_role_v1(p_negocio_id uuid) returns text language sql stable security definer set search_path='' as $f$
 select case when n."dueño_id"=auth.uid() then 'owner' else (select u.rol from public.usuarios_negocio u where u.negocio_id=n.id and u.user_id=auth.uid() and u.activo and u.rol in('admin','vendedor','cajero') order by u.id limit 1) end from public.negocios n where auth.uid() is not null and n.id=p_negocio_id and n.id in('96000000-0000-4000-8000-000000000001'::uuid,'96000000-0000-4000-8000-000000000002'::uuid);
$f$;
revoke all on function public.native_member_role_v1(uuid) from public,anon;
grant execute on function public.native_member_role_v1(uuid) to authenticated;
do $compat$ begin
 if pg_catalog.to_regclass('public.native_catalogue_snapshots_v1') is not null then
  alter table public.native_catalogue_snapshots_v1 drop constraint if exists native_catalogue_snapshots_v1_actor_role_check;
  alter table public.native_catalogue_snapshots_v1 add constraint native_catalogue_snapshots_v1_actor_role_check check(actor_role in('owner','admin','vendedor','cajero'));
 end if;
end $compat$;
create table if not exists public.native_team_operations_v1(negocio_id uuid not null,operation_id uuid not null,actor_id uuid not null,request_text text not null,request_hash text not null,result jsonb not null,primary key(negocio_id,operation_id));
create table if not exists public.native_team_redemptions_v1(token_hash text primary key,negocio_id uuid not null,member_id uuid not null,user_id uuid not null,result jsonb not null);
alter table public.native_team_operations_v1 enable row level security;
alter table public.native_team_redemptions_v1 enable row level security;
revoke all on public.native_team_operations_v1,public.native_team_redemptions_v1 from public,anon,authenticated;
create or replace function public.native_team_member_v1(m public.usuarios_negocio) returns jsonb language sql stable set search_path='' as $f$
 select pg_catalog.jsonb_build_object('id',m.id,'name',m.nombre,'email',m.email,'role',m.rol,'active',m.activo,'pending',m.user_id is null,'userId',m.user_id,'expiresAtMs',case when m.user_id is null then pg_catalog.floor(extract(epoch from coalesce(m.invite_expires_at,m.created_at+interval '24 hours'))*1000)::bigint::text else null end,'protected',coalesce(m.user_id=auth.uid() or m.user_id=(select "dueño_id" from public.negocios where id=m.negocio_id),false),'version',public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object('id',m.id,'name',m.nombre,'email',m.email,'role',m.rol,'active',m.activo,'userId',m.user_id,'token',m.invite_token,'expires',extract(epoch from coalesce(m.invite_expires_at,m.created_at+interval '24 hours'))::text) )));
$f$;
revoke all on function public.native_team_member_v1(public.usuarios_negocio) from public,anon,authenticated;
create or replace function public.native_team_context_v1(c jsonb) returns uuid language plpgsql security definer set search_path='' as $f$
declare n uuid;role text;
begin
 perform public.native_sales_object_v1(c,array['tenantId','actorId','deviceId','installationId','writerEpoch','scopeType','branchId']);
 if (select count(*) from pg_catalog.jsonb_object_keys(c))<>7 or (c->>'actorId')::uuid is distinct from auth.uid() then raise exception using errcode='42501',message='NATIVE_TEAM_DENIED';end if;
 n:=(c->>'tenantId')::uuid;
 role:=public.native_sales_context_v1(n,(c->>'installationId')::uuid,(c->>'deviceId')::uuid,public.native_sales_int_v1(c->'writerEpoch')::bigint,c->>'scopeType',(c->>'branchId')::uuid);
 if role not in('owner','admin') then raise exception using errcode='42501',message='NATIVE_TEAM_DENIED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));return n;
end $f$;
revoke all on function public.native_team_context_v1(jsonb) from public,anon,authenticated;
create or replace function public.native_team_read_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare role text;members jsonb;
begin
 role:=public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if role not in('owner','admin') then raise exception using errcode='42501',message='NATIVE_TEAM_DENIED';end if;
 if (select count(*) from public.usuarios_negocio where negocio_id=p_negocio_id)>500 then raise exception 'NATIVE_TEAM_TOO_LARGE';end if;
 select coalesce(pg_catalog.jsonb_agg(public.native_team_member_v1(m) order by m.created_at,m.id),'[]'::jsonb) into members from public.usuarios_negocio m where m.negocio_id=p_negocio_id;
 return pg_catalog.jsonb_build_object('version','ventard.team.view.1','tenantId',p_negocio_id,'members',members);
end $f$;
revoke all on function public.native_team_read_v1(uuid,uuid,uuid,bigint,text,uuid) from public,anon;
grant execute on function public.native_team_read_v1(uuid,uuid,uuid,bigint,text,uuid) to authenticated;
create or replace function public.native_team_request_v1(p_request text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;
begin
 if p_request is null or pg_catalog.octet_length(p_request)>8192 then raise exception 'NATIVE_TEAM_INVALID';end if;
 v:=p_request::jsonb;perform public.native_sales_object_v1(v,array['version','context','operationId','command']);
 if (select count(*) from pg_catalog.jsonb_object_keys(v))<>4 or v->>'version' is distinct from 'ventard.team.request.1' or public.native_sales_canonical_v1(v)<>p_request or public.native_sales_hash_v1(p_request) is distinct from p_hash or (v->>'operationId')::uuid is null then raise exception 'NATIVE_TEAM_INVALID';end if;
 perform public.native_team_context_v1(v->'context');return v;
end $f$;
revoke all on function public.native_team_request_v1(text,text) from public,anon,authenticated;
create or replace function public.native_team_lookup_v1(p_request text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;n uuid;old public.native_team_operations_v1%rowtype;
begin
 v:=public.native_team_request_v1(p_request,p_hash);n:=(v->'context'->>'tenantId')::uuid;
 select * into old from public.native_team_operations_v1 where negocio_id=n and operation_id=(v->>'operationId')::uuid;
 if not found then return pg_catalog.jsonb_build_object('status','NOT_FOUND','operationId',v->>'operationId','requestHash',p_hash);end if;
 if old.actor_id is distinct from auth.uid() or old.request_text<>p_request or old.request_hash<>p_hash then raise exception 'NATIVE_TEAM_ID_CONFLICT';end if;return old.result;
end $f$;
create or replace function public.native_team_submit_v1(p_request text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;n uuid;q jsonb;op uuid;old jsonb;m public.usuarios_negocio%rowtype;token uuid;expiry timestamptz;result jsonb;
begin
 old:=public.native_team_lookup_v1(p_request,p_hash);if old->>'status'<>'NOT_FOUND' then return old;end if;
 v:=p_request::jsonb;n:=(v->'context'->>'tenantId')::uuid;op:=(v->>'operationId')::uuid;q:=v->'command';
 if q->>'kind'='INVITE' then
  perform public.native_sales_object_v1(q,array['kind','name','email','role']);
  if (select count(*) from pg_catalog.jsonb_object_keys(q))<>4 or pg_catalog.jsonb_typeof(q->'name') is distinct from 'string' or pg_catalog.length(q->>'name') not between 1 and 100 or q->>'name'<>pg_catalog.btrim(q->>'name') or q->>'name'~'[[:cntrl:]]' or pg_catalog.jsonb_typeof(q->'email') is distinct from 'string' or pg_catalog.length(q->>'email')>200 or q->>'email'<>pg_catalog.lower(q->>'email') or q->>'email'!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or q->>'role' not in('admin','vendedor','cajero') then raise exception 'NATIVE_TEAM_INVALID';end if;
  if exists(select 1 from public.usuarios_negocio where negocio_id=n and pg_catalog.lower(email)=q->>'email') or exists(select 1 from public.negocios b join auth.users a on a.id=b."dueño_id" where b.id=n and pg_catalog.lower(a.email)=q->>'email') then raise exception 'NATIVE_TEAM_EMAIL_EXISTS';end if;
  if (select count(*) from public.usuarios_negocio where negocio_id=n)>=500 then raise exception 'NATIVE_TEAM_TOO_LARGE';end if;
  token:=pg_catalog.gen_random_uuid();expiry:=pg_catalog.clock_timestamp()+interval '24 hours';
  insert into public.usuarios_negocio(id,negocio_id,nombre,email,rol,activo,created_at,invite_token,invite_expires_at) values(op,n,q->>'name',q->>'email',q->>'role',true,pg_catalog.clock_timestamp(),token,expiry) returning * into m;
 elsif q->>'kind' in('PATCH','RENEW') then
  perform public.native_sales_object_v1(q,array['kind','memberId','expectedVersion']);
  select * into m from public.usuarios_negocio where negocio_id=n and id=(q->>'memberId')::uuid for update;
  if not found or m.user_id=auth.uid() or m.user_id=(select "dueño_id" from public.negocios where id=n) then raise exception 'NATIVE_TEAM_PROTECTED';end if;
  if public.native_team_member_v1(m)->>'version' is distinct from q->>'expectedVersion' then raise exception 'NATIVE_TEAM_VERSION';end if;
  if q->>'kind'='PATCH' then
   if (select count(*) from pg_catalog.jsonb_object_keys(q))<>5 or q->>'role' not in('admin','vendedor','cajero') or pg_catalog.jsonb_typeof(q->'active') is distinct from 'boolean' then raise exception 'NATIVE_TEAM_INVALID';end if;
   update public.usuarios_negocio set rol=q->>'role',activo=(q->>'active')::boolean,invite_token=case when (q->>'active')::boolean then invite_token else null end where id=m.id and negocio_id=n returning * into m;
  else
   if (select count(*) from pg_catalog.jsonb_object_keys(q))<>3 or m.user_id is not null or not m.activo then raise exception 'NATIVE_TEAM_INVALID';end if;
   token:=pg_catalog.gen_random_uuid();expiry:=pg_catalog.clock_timestamp()+interval '24 hours';
   update public.usuarios_negocio set invite_token=token,invite_expires_at=expiry where id=m.id and negocio_id=n returning * into m;
  end if;
 else raise exception 'NATIVE_TEAM_INVALID';end if;
 result:=pg_catalog.jsonb_build_object('version','ventard.team.receipt.1','status','APPLIED','operationId',op,'tenantId',n,'actorId',auth.uid(),'requestHash',p_hash,'member',public.native_team_member_v1(m),'invitePath',case when token is null then null else '/unirse?token='||token::text end);
 insert into public.native_team_operations_v1 values(n,op,auth.uid(),p_request,p_hash,result);return result;
end $f$;
revoke all on function public.native_team_lookup_v1(text,text),public.native_team_submit_v1(text,text) from public,anon;
grant execute on function public.native_team_lookup_v1(text,text),public.native_team_submit_v1(text,text) to authenticated;
create or replace function public.native_team_cancel_v1(p_request text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare old jsonb;v jsonb;n uuid;op uuid;result jsonb;
begin
 old:=public.native_team_lookup_v1(p_request,p_hash);if old->>'status'<>'NOT_FOUND' then return old;end if;
 v:=p_request::jsonb;n:=(v->'context'->>'tenantId')::uuid;op:=(v->>'operationId')::uuid;
 result:=pg_catalog.jsonb_build_object('version','ventard.team.receipt.1','status','CANCELLED','operationId',op,'tenantId',n,'actorId',auth.uid(),'requestHash',p_hash,'member',null,'invitePath',null);
 insert into public.native_team_operations_v1 values(n,op,auth.uid(),p_request,p_hash,result);return result;
end $f$;
revoke all on function public.native_team_cancel_v1(text,text) from public,anon;
grant execute on function public.native_team_cancel_v1(text,text) to authenticated;
-- These two entry points are exclusively for the existing server-side public
-- invitation API. The authenticated subject comes from verified Supabase Auth.
create or replace function public.native_team_invite_read_v1(p_token uuid) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare m public.usuarios_negocio%rowtype;
begin
 select * into m from public.usuarios_negocio where negocio_id in('96000000-0000-4000-8000-000000000001'::uuid,'96000000-0000-4000-8000-000000000002'::uuid) and invite_token=p_token and user_id is null and activo and coalesce(invite_expires_at,created_at+interval '24 hours')>pg_catalog.statement_timestamp();
 if not found then raise exception 'NATIVE_TEAM_INVITE_UNAVAILABLE';end if;
 return pg_catalog.jsonb_build_object('nombre',m.nombre,'email',m.email);
end $f$;
create or replace function public.native_team_invite_accept_v1(p_token uuid,p_user_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare m public.usuarios_negocio%rowtype;n uuid;old public.native_team_redemptions_v1%rowtype;h text;result jsonb;
begin
 if p_token is null or p_user_id is null then raise exception 'NATIVE_TEAM_INVITE_DENIED';end if;
 h:=public.native_sales_hash_v1(p_token::text);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-invite:'||h,0));
 select * into old from public.native_team_redemptions_v1 where token_hash=h;
 if found then
  if old.user_id<>p_user_id or not exists(select 1 from public.usuarios_negocio where id=old.member_id and negocio_id=old.negocio_id and user_id=p_user_id and activo) then raise exception 'NATIVE_TEAM_INVITE_DENIED';end if;return old.result;
 end if;
 select negocio_id into n from public.usuarios_negocio where negocio_id in('96000000-0000-4000-8000-000000000001'::uuid,'96000000-0000-4000-8000-000000000002'::uuid) and invite_token=p_token;
 if n is null then raise exception 'NATIVE_TEAM_INVITE_UNAVAILABLE';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into m from public.usuarios_negocio where invite_token=p_token and negocio_id=n and user_id is null and activo and coalesce(invite_expires_at,created_at+interval '24 hours')>pg_catalog.clock_timestamp() for update;
 if not found then raise exception 'NATIVE_TEAM_INVITE_UNAVAILABLE';end if;
 if not exists(select 1 from auth.users where id=p_user_id and pg_catalog.lower(email)=pg_catalog.lower(m.email) and email_confirmed_at is not null) then raise exception 'NATIVE_TEAM_INVITE_DENIED';end if;
 if exists(select 1 from public.usuarios_negocio where negocio_id=n and user_id=p_user_id and id<>m.id) or exists(select 1 from public.negocios where id=n and "dueño_id"=p_user_id) then raise exception 'NATIVE_TEAM_INVITE_DENIED';end if;
 update public.usuarios_negocio set user_id=p_user_id,invite_token=null,invite_expires_at=null where id=m.id and negocio_id=n;
 result:=pg_catalog.jsonb_build_object('status','ACCEPTED','memberId',m.id,'tenantId',n);
 insert into public.native_team_redemptions_v1 values(h,n,m.id,p_user_id,result);return result;
end $f$;
revoke all on function public.native_team_invite_read_v1(uuid),public.native_team_invite_accept_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.native_team_invite_read_v1(uuid),public.native_team_invite_accept_v1(uuid,uuid) to service_role;
do $rename$ begin
 if pg_catalog.to_regprocedure('public.native_sales_submit_team_base_v1(text,text,text,text)') is null then alter function public.native_sales_submit_v1(text,text,text,text) rename to native_sales_submit_team_base_v1;end if;
end $rename$;
revoke all on function public.native_sales_submit_team_base_v1(text,text,text,text) from public,anon,authenticated;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb:=p_intent::jsonb;begin
 if public.native_member_role_v1((v->>'negocioId')::uuid)='cajero' and v->>'kind' not in('SALE_CONFIRM','TURN_OPEN') then raise exception using errcode='42501',message='NATIVE_CASHIER_POS_ONLY';end if;
 return public.native_sales_submit_team_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end $f$;
revoke all on function public.native_sales_submit_v1(text,text,text,text) from public,anon;
grant execute on function public.native_sales_submit_v1(text,text,text,text) to authenticated;
commit;
