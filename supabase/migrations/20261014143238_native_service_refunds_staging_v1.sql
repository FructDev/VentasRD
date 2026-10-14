-- Prepared Staging QA only. Original service payments and reservations survive.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 or pg_catalog.to_regprocedure('public.native_repairs_submit_v1(text,text,text,text)') is null then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;
create table if not exists public.native_service_refunds_v1(
 negocio_id uuid not null,operation_id uuid not null,scope_kind text not null,sucursal_id uuid,
 family text not null check(family in('repair','layaway')),service_id uuid not null,
 revision bigint not null check(revision>0),amount_cents bigint not null check(amount_cents>0),
 document jsonb not null,primary key(negocio_id,operation_id),
 foreign key(negocio_id,operation_id) references public.native_sales_ledger_v1(negocio_id,operation_id) deferrable initially deferred
);
create unique index if not exists native_service_refund_revision_v1 on public.native_service_refunds_v1(negocio_id,scope_kind,coalesce(sucursal_id,'00000000-0000-0000-0000-000000000000'::uuid),family,service_id,revision);
alter table public.native_service_refunds_v1 enable row level security;
revoke all on public.native_service_refunds_v1 from public,anon,authenticated;
create or replace function public.native_service_refund_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
#variable_conflict use_variable
declare v jsonb;req jsonb;doc jsonb;n uuid;op uuid;i uuid;d uuid;b uuid;k text;epoch bigint;role text;old public.native_sales_ledger_v1%rowtype;
 family text;sid uuid;service jsonb;previous jsonb;service_revision bigint;refund_revision bigint;amount bigint;method text;turn uuid;reason text;paid bigint;basis bigint;refunded bigint;pending bigint;expected jsonb;seq bigint;effects jsonb;receipt jsonb;clock_ms text;cash bigint;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 or p_snapshot is not null or p_snapshot_hash is not null then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;
 if v->>'kind' is distinct from 'SERVICE_REFUND' or public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent) is distinct from p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 if v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or v->'expectedVersions' is distinct from '{}'::jsonb or v->'dependencies' is distinct from '[]'::jsonb then raise exception 'NATIVE_INTENT_INVALID';end if;
 perform public.native_sales_int_v1(v->'originAtUtcMs');n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;
 role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or (v->>'actorId')::uuid is distinct from auth.uid() or role not in('owner','admin') or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role and rr.receipt->'license'->>'planTier'='pro') then raise exception using errcode='42501',message='NATIVE_PRO_REQUIRED';end if;
 perform 1 from public.native_staging_licenses_v1 where negocio_id=n and plan_tier='pro' for share;if not found then raise exception using errcode='42501',message='NATIVE_PRO_REQUIRED';end if;
 if not exists(select 1 from public.native_sales_mode_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b) then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is not null or old.snapshot_text is not null then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 perform public.native_sales_object_v1(v->'payload',array['request','document']);req:=v->'payload'->'request';doc:=v->'payload'->'document';
 perform public.native_sales_object_v1(req,array['kind','operationId','family','serviceId','expectedServiceRevision','expectedRefundRevision','amountCents','method','turnId','reason']);
 family:=req->>'family';sid:=(req->>'serviceId')::uuid;service_revision:=public.native_sales_int_v1(req->'expectedServiceRevision')::bigint;refund_revision:=public.native_sales_int_v1(req->'expectedRefundRevision',999)::bigint;amount:=public.native_sales_int_v1(req->'amountCents')::bigint;method:=req->>'method';turn:=(req->>'turnId')::uuid;reason:=req->>'reason';
 if req->>'kind' is distinct from 'SERVICE_REFUND' or req->>'operationId' is distinct from op::text or sid is null or family is null or family not in('repair','layaway') or method is null or method not in('EFECTIVO','TARJETA','TRANSFERENCIA') or pg_catalog.jsonb_typeof(req->'reason') is distinct from 'string' or pg_catalog.length(reason) not between 1 and 256 or pg_catalog.btrim(reason)<>reason or reason ~ '[[:cntrl:]]' or pg_catalog.jsonb_typeof(req->'turnId') not in('string','null') or req->'turnId' is distinct from v->'originalTurnId' then raise exception 'NATIVE_SERVICE_REFUND_INVALID';end if;
 -- The adopted view preserves original IDs/folios and old aggregate deposits.
 if pg_catalog.to_regclass('public.native_service_records_v1') is not null then
  execute 'select document from public.native_service_records_v1 where negocio_id=$1 and scope_kind=$2 and sucursal_id is not distinct from $3 and document->$4->>''id''=$5 and kind=any($6) order by (document->$4->>''revision'')::bigint desc limit 1' into previous using n,k,b,family,sid::text,case family when 'repair' then array['REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE','REPAIR_BASELINE'] else array['LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL','LAYAWAY_BASELINE'] end;
 else
  select m.document into previous from public.native_management_records_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b and m.document->family->>'id'=sid::text and m.kind=any(case family when 'repair' then array['REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE'] else array['LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL'] end) order by (m.document->family->>'revision')::bigint desc limit 1;
 end if;
 service:=previous->family;if service is null then raise exception 'SERVICE_REFUND_UNVERIFIED';end if;
 if service->>'revision' is distinct from service_revision::text then raise exception 'NATIVE_SERVICE_VERSION';end if;
 paid:=public.native_sales_int_v1(service->'paidCents')::bigint;
 basis:=case when service->>'state'='cancelado' then paid when family='repair' and service->>'state' in('no_reparado','abandonado') then greatest(0,paid-public.native_sales_int_v1(service->'totalCents')::bigint) else 0 end;
 if service->>'state' in('cancelado','no_reparado','abandonado') and service ? 'settlementPendingCents' then basis:=public.native_sales_int_v1(service->'settlementPendingCents')::bigint;if basis>paid then raise exception 'SERVICE_REFUND_DIVERGED';end if;end if;
 select coalesce(sum(amount_cents),0),count(*) into refunded,seq from public.native_service_refunds_v1 r where r.negocio_id=n and r.scope_kind=k and r.sucursal_id is not distinct from b and r.family=family and r.service_id=sid;
 if seq<>refund_revision then raise exception 'NATIVE_SERVICE_VERSION';end if;pending:=basis-refunded;
 if pending<0 then raise exception 'SERVICE_REFUND_DIVERGED';end if;if amount=0 or amount>pending then raise exception 'SERVICE_REFUND_EXCESS';end if;
 if method='EFECTIVO' and turn is null then raise exception 'NATIVE_TURN_REQUIRED';end if;
 if turn is not null and not exists(select 1 from public.native_sales_turns_v1 where negocio_id=n and turn_id=turn and scope_kind=k and sucursal_id is not distinct from b and status='OPEN' and opened_at_ms::bigint<=(v->>'originAtUtcMs')::bigint) then raise exception 'NATIVE_TURN_REQUIRED';end if;
 expected:=pg_catalog.jsonb_build_object('service',pg_catalog.jsonb_build_object('family',family,'id',sid,'revision',service_revision::text,'folio',service->>'folio','basisCents',basis::text),'refund',pg_catalog.jsonb_build_object('operationId',op,'revision',(refund_revision+1)::text,'amountCents',amount::text,'method',method,'turnId',turn,'dateMs',v->>'originAtUtcMs','reason',reason),'refundedBeforeCents',refunded::text,'refundedAfterCents',(refunded+amount)::text,'pendingBeforeCents',pending::text,'pendingAfterCents',(pending-amount)::text,'amountCents',amount::text,'method',method,'concept','Devolución de depósito '||(service->>'folio'),'business',previous->'business');
 cash:=case when method='EFECTIVO' then -amount else 0 end;
 if turn is not null then expected:=expected||pg_catalog.jsonb_build_object('cashDeltaCents',cash::text);end if;
 if doc is distinct from expected then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;if seq is null then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'management'),'kind','SERVICE_REFUND','payload',doc));clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text;
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',null,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',null,'ncf',null,'totalCents',null,'effects',effects,'stock','[]'::jsonb);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,'SERVICE_REFUND',p_intent,p_hash,null,null,null,null,seq,receipt);
 insert into public.native_sales_effects_v1 values(n,op,public.native_sales_effect_id_v1(op,'management'),'SERVICE_REFUND',doc);
 insert into public.native_management_records_v1 values(n,op,k,b,'SERVICE_REFUND',turn,null,method,amount,doc->>'concept',v->>'originAtUtcMs',doc);
 insert into public.native_service_refunds_v1 values(n,op,k,b,family,sid,refund_revision+1,amount,doc);return receipt;
end $f$;
revoke all on function public.native_service_refund_submit_v1(text,text,text,text) from public,anon,authenticated;
do $rename$ begin
 if pg_catalog.to_regprocedure('public.native_sales_submit_refunds_base_v1(text,text,text,text)') is null then alter function public.native_sales_submit_v1(text,text,text,text) rename to native_sales_submit_refunds_base_v1;end if;
 if pg_catalog.to_regprocedure('public.native_sales_bootstrap_refunds_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)') is null then alter function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) rename to native_sales_bootstrap_refunds_base_v1;end if;
end $rename$;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$ begin
 if p_intent::jsonb->>'kind'='SERVICE_REFUND' then return public.native_service_refund_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end if;return public.native_sales_submit_refunds_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
end $f$;
create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare result jsonb;events jsonb;begin
 result:=public.native_sales_bootstrap_refunds_base_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,p_snapshot_id);
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('intent',l.intent_text,'snapshot',null,'receipt',l.receipt) order by l.remote_sequence),'[]'::jsonb) into events from public.native_sales_ledger_v1 l join public.native_service_refunds_v1 r on r.negocio_id=l.negocio_id and r.operation_id=l.operation_id where l.negocio_id=p_negocio_id and l.scope_kind=p_scope_kind and l.sucursal_id is not distinct from p_sucursal_id and l.remote_sequence<=(result->>'watermark')::bigint;
 if pg_catalog.jsonb_array_length(events)>10000 or pg_catalog.octet_length(events::text)>1048576 then raise exception 'NATIVE_SERVICE_REFUND_CAPTURE_TOO_LARGE';end if;
 result:=result||pg_catalog.jsonb_build_object('serviceRefunds',events);update public.native_sales_snapshots_v1 set manifest=result where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;return result;
end $f$;
revoke all on function public.native_sales_submit_refunds_base_v1(text,text,text,text),public.native_sales_bootstrap_refunds_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.native_sales_submit_v1(text,text,text,text),public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) from public,anon;
grant execute on function public.native_sales_submit_v1(text,text,text,text),public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) to authenticated;
commit;
