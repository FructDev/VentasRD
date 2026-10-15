-- Staging QA only. Handoff is explicit; schema deployment retires no device.
begin;
do $guard$ begin if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;end $guard$;
create table if not exists public.native_recovery_handoffs_v1(negocio_id uuid not null,request_id uuid not null,actor_id uuid not null,intent_text text not null,intent_hash text not null check(intent_hash~'^[0-9a-f]{64}$'),receipt jsonb not null,primary key(negocio_id,request_id));
alter table public.native_recovery_handoffs_v1 enable row level security;
revoke all on public.native_recovery_handoffs_v1 from public,anon,authenticated;
-- Context verification must happen inside the same tenant lock as handoff.
-- Otherwise a queued old writer could pass permission checks before retirement.
do $fence$ declare definition text;needle text:='begin r:=public.native_member_role_v1(n);';begin
 select pg_catalog.pg_get_functiondef('public.native_sales_context_v1(uuid,uuid,uuid,bigint,text,uuid)'::regprocedure) into definition;
 if pg_catalog.strpos(definition,'RECOVERY_CONTEXT_FENCE')=0 then
  if pg_catalog.strpos(definition,needle)=0 then raise exception 'NATIVE_RECOVERY_CONTEXT_PARENT_INCOMPATIBLE';end if;
  definition:=pg_catalog.replace(definition,needle,'begin /* RECOVERY_CONTEXT_FENCE */ perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(''native-sales:''||n::text,0));r:=public.native_member_role_v1(n);');execute definition;
 end if;
end $fence$;
alter function public.native_sales_context_v1(uuid,uuid,uuid,bigint,text,uuid) volatile;
create or replace function public.native_recovery_context_v1(p_intent text,p_hash text) returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare v jsonb;t jsonb;s jsonb;n uuid;role_name text;
begin
 if pg_catalog.octet_length(p_intent)>1048576 or p_hash is null or p_hash<>public.native_sales_hash_v1(p_intent) then raise exception 'RECOVERY_HASH_INVALID';end if;
 v:=p_intent::jsonb;perform public.native_sales_object_v1(v,array['protocol','requestId','backupId','backupHash','source','target','snapshotId','confirmation','pending']);
 if public.native_sales_canonical_v1(v) is distinct from p_intent or v->>'protocol' is distinct from 'ventard.native.recovery.1' or v->>'confirmation' is distinct from 'ORIGINAL_DEVICE_RETIRED_BACKUP_RECONCILED' or pg_catalog.jsonb_typeof(v->'backupHash') is distinct from 'string' or v->>'backupHash'!~'^[0-9a-f]{64}$' then raise exception 'RECOVERY_INVALID';end if;
 perform (v->>'requestId')::uuid;perform (v->>'backupId')::uuid;perform (v->>'snapshotId')::uuid;
 t:=v->'target';s:=v->'source';perform public.native_sales_object_v1(t,array['tenantId','actorId','deviceId','installationId','writerEpoch','scopeType','branchId']);perform public.native_sales_object_v1(s,array['localAnchorHash','tenantId','vaultId','installationId','deviceId','actorId','writerEpoch','scopeType','branchId','keyVersion','capturedAtMs']);
 n:=(t->>'tenantId')::uuid;
 if s->'keyVersion' is distinct from '1'::jsonb or pg_catalog.jsonb_typeof(s->'vaultId') is distinct from 'string' or pg_catalog.jsonb_typeof(s->'actorId') is distinct from 'string' or pg_catalog.jsonb_typeof(s->'capturedAtMs') is distinct from 'string' or s->>'capturedAtMs'!~'^(0|[1-9][0-9]{0,15})$' then raise exception 'RECOVERY_INVALID';end if;
 perform (s->>'vaultId')::uuid;perform (s->>'actorId')::uuid;
 if (s->>'capturedAtMs')::numeric>9007199254740991 or (s->'localAnchorHash'<>'null'::jsonb and (pg_catalog.jsonb_typeof(s->'localAnchorHash') is distinct from 'string' or s->>'localAnchorHash'!~'^[0-9a-f]{64}$')) then raise exception 'RECOVERY_INVALID';end if;
 role_name:=public.native_sales_context_v1(n,(t->>'installationId')::uuid,(t->>'deviceId')::uuid,(t->>'writerEpoch')::bigint,t->>'scopeType',(t->>'branchId')::uuid);
 if role_name not in('owner','admin') or (t->>'actorId')::uuid is distinct from auth.uid() then raise exception using errcode='42501',message='RECOVERY_OWNER_REQUIRED';end if;
 if s->>'tenantId' is distinct from t->>'tenantId' or s->>'scopeType' is distinct from t->>'scopeType' or s->'branchId' is distinct from t->'branchId' or s->>'installationId'=t->>'installationId' or s->>'deviceId'=t->>'deviceId' then raise exception 'RECOVERY_NEW_IDENTITY_REQUIRED';end if;
 if pg_catalog.jsonb_typeof(v->'pending') is distinct from 'array' or pg_catalog.jsonb_array_length(v->'pending')>1000 then raise exception 'RECOVERY_INVALID';end if;
 return v;
end $f$;
revoke all on function public.native_recovery_context_v1(text,text) from public,anon,authenticated;
create or replace function public.native_recovery_lookup_v1(p_intent text,p_hash text) returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare v jsonb;old public.native_recovery_handoffs_v1%rowtype;begin
 v:=public.native_recovery_context_v1(p_intent,p_hash);select * into old from public.native_recovery_handoffs_v1 where negocio_id=(v->'target'->>'tenantId')::uuid and request_id=(v->>'requestId')::uuid;
 if not found then return pg_catalog.jsonb_build_object('status','NOT_FOUND','requestId',v->>'requestId','requestHash',p_hash);end if;
 if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.actor_id<>auth.uid() then raise exception 'RECOVERY_ID_CONFLICT';end if;return old.receipt;
end $f$;
create or replace function public.native_recovery_submit_v1(p_intent text,p_hash text,p_abandon boolean default false) returns jsonb language plpgsql volatile security definer set search_path='' as $f$
declare v jsonb;t jsonb;s jsonb;n uuid;answer jsonb;capture public.native_sales_snapshots_v1%rowtype;pending jsonb;l public.native_sales_ledger_v1%rowtype;seen uuid[]:='{}';op uuid;retired boolean:=false;
begin
 v:=public.native_recovery_context_v1(p_intent,p_hash);answer:=public.native_recovery_lookup_v1(p_intent,p_hash);if answer->>'status'<>'NOT_FOUND' then return answer;end if;
 if p_abandon is null then raise exception 'RECOVERY_INVALID';end if;
 t:=v->'target';s:=v->'source';n:=(t->>'tenantId')::uuid;
 if not p_abandon then
  select * into capture from public.native_sales_snapshots_v1 where negocio_id=n and snapshot_id=(v->>'snapshotId')::uuid;
  if not found or capture.actor_id<>auth.uid() or capture.installation_id<>(t->>'installationId')::uuid or capture.device_id<>(t->>'deviceId')::uuid or capture.writer_epoch<>(t->>'writerEpoch')::bigint or capture.scope_kind<>t->>'scopeType' or capture.sucursal_id is distinct from (t->>'branchId')::uuid or capture.manifest->>'historyCoverage' is distinct from 'NATIVE_LEDGER_THROUGH_WATERMARK' then raise exception 'RECOVERY_SNAPSHOT_REQUIRED';end if;
  if capture.expires_at_ms<=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000) then raise exception 'RECOVERY_SNAPSHOT_EXPIRED';end if;
  for pending in select value from pg_catalog.jsonb_array_elements(v->'pending') loop
   perform public.native_sales_object_v1(pending,array['operationId','intentHash','snapshotHash']);op:=(pending->>'operationId')::uuid;
   if op is null or op=any(seen) then raise exception 'RECOVERY_INVALID';end if;seen:=pg_catalog.array_append(seen,op);
   select * into l from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op and scope_kind=t->>'scopeType' and sucursal_id is not distinct from (t->>'branchId')::uuid;
   if not found or l.intent_hash is distinct from pending->>'intentHash' or l.snapshot_hash is distinct from pending->>'snapshotHash' or l.remote_sequence>(capture.manifest->>'watermark')::bigint then raise exception 'RECOVERY_PENDING_UNVERIFIED';end if;
  end loop;
  update public.native_installations_v1 set status='REVOKED' where negocio_id=n and installation_id=(s->>'installationId')::uuid and device_id=(s->>'deviceId')::uuid and writer_epoch=(s->>'writerEpoch')::bigint and scope_kind=s->>'scopeType' and sucursal_id is not distinct from (s->>'branchId')::uuid and status='REGISTERED';
  if not found then raise exception 'RECOVERY_SOURCE_NOT_ACTIVE';end if;retired:=true;
 end if;
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.native.recovery.receipt.1','requestId',v->>'requestId','requestHash',p_hash,'backupId',v->>'backupId','backupHash',v->>'backupHash','source',s,'target',t,'status',case when retired then 'APPLIED' else 'ABANDONED' end,'retiredSource',retired,'replay',false,'recordedAtMs',pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text);
 insert into public.native_recovery_handoffs_v1 values(n,(v->>'requestId')::uuid,auth.uid(),p_intent,p_hash,answer);return answer;
end $f$;
revoke all on function public.native_recovery_lookup_v1(text,text),public.native_recovery_submit_v1(text,text,boolean) from public,anon;
grant execute on function public.native_recovery_lookup_v1(text,text),public.native_recovery_submit_v1(text,text,boolean) to authenticated;
commit;
