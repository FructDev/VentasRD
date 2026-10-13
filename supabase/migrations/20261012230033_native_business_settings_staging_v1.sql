-- Prepared for explicit Staging authorization. No production deployment.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2
 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;
create table if not exists public.native_business_settings_v1(
 negocio_id uuid primary key, revision bigint not null check(revision between 1 and 2147483647),
 definition jsonb not null,operation_id uuid not null,
 foreign key(negocio_id,operation_id) references public.native_sales_ledger_v1(negocio_id,operation_id) deferrable initially deferred);
alter table public.native_business_settings_v1 enable row level security;
revoke all on public.native_business_settings_v1 from public,anon,authenticated;
create or replace function public.native_settings_definition_v1(d jsonb) returns void language plpgsql immutable set search_path='' as $f$
declare key text;v text;max_size integer;data bytea;encoded text;w bigint;h bigint;
begin
 if pg_catalog.jsonb_typeof(d)<>'object' or not(d ?& array['name','whatsapp','phone','rnc','address','footer','logo','color','font','bank']) or (select count(*) from pg_catalog.jsonb_object_keys(d))<>10 then raise exception 'NATIVE_SETTINGS_INVALID';end if;
 foreach key in array array['name','whatsapp','phone','rnc','address','footer'] loop
  v:=d->>key;max_size:=case key when 'name' then 256 when 'rnc' then 32 when 'address' then 1000 when 'footer' then 1000 else 64 end;
  if pg_catalog.jsonb_typeof(d->key) is distinct from 'string' or pg_catalog.btrim(v,E' \t\r\n')<>v or pg_catalog.length(v)>max_size or pg_catalog.regexp_replace(v,case when key in('address','footer') then E'\n' else '' end,'','g')~'[[:cntrl:]]' then raise exception 'NATIVE_SETTINGS_INVALID';end if;
 end loop;
 if d->>'name'='' or pg_catalog.jsonb_typeof(d->'color') is distinct from 'string' or pg_catalog.jsonb_typeof(d->'font') is distinct from 'string' or d->>'color' not in('dorado','ambar','naranja','coral','rosa','lima','esmeralda','turquesa','cielo') or d->>'font' not in('syne','poppins','montserrat','spacegro','sora','outfit','playfair') then raise exception 'NATIVE_SETTINGS_INVALID';end if;
 if d->'bank'<>'null'::jsonb then
  if pg_catalog.jsonb_typeof(d->'bank') is distinct from 'object' or not(d->'bank' ?& array['name','account','holder']) or (select count(*) from pg_catalog.jsonb_object_keys(d->'bank'))<>3 then raise exception 'NATIVE_SETTINGS_INVALID';end if;
  foreach key in array array['name','account','holder'] loop v:=d->'bank'->>key;
   if pg_catalog.jsonb_typeof(d->'bank'->key) is distinct from 'string' or pg_catalog.btrim(v,E' \t\r\n')<>v or pg_catalog.length(v)>(case key when 'holder' then 256 else 128 end) or v~'[[:cntrl:]]' or(key='account' and v='') then raise exception 'NATIVE_SETTINGS_INVALID';end if;
  end loop;
 end if;
 if d->'logo'<>'null'::jsonb then
  v:=d->>'logo';if pg_catalog.jsonb_typeof(d->'logo') is distinct from 'string' or pg_catalog.left(v,22)<>'data:image/png;base64,' or pg_catalog.length(v)>131094 then raise exception 'NATIVE_SETTINGS_LOGO_INVALID';end if;
  encoded:=pg_catalog.substr(v,23);if encoded !~ '^[A-Za-z0-9+/]*={0,2}$' then raise exception 'NATIVE_SETTINGS_LOGO_INVALID';end if;
  data:=pg_catalog.decode(encoded,'base64');
  if pg_catalog.octet_length(data) not between 45 and 98304 or pg_catalog.replace(pg_catalog.encode(data,'base64'),E'\n','')<>encoded or pg_catalog.encode(pg_catalog.substr(data,1,16),'hex')<>'89504e470d0a1a0a0000000d49484452' or pg_catalog.encode(pg_catalog.substr(data,pg_catalog.octet_length(data)-11),'hex')<>'0000000049454e44ae426082' then raise exception 'NATIVE_SETTINGS_LOGO_INVALID';end if;
  w:=pg_catalog.get_byte(data,16)::bigint*16777216+pg_catalog.get_byte(data,17)*65536+pg_catalog.get_byte(data,18)*256+pg_catalog.get_byte(data,19);
  h:=pg_catalog.get_byte(data,20)::bigint*16777216+pg_catalog.get_byte(data,21)*65536+pg_catalog.get_byte(data,22)*256+pg_catalog.get_byte(data,23);
  if w not between 1 and 480 or h not between 1 and 480 or pg_catalog.get_byte(data,24)<>8 or pg_catalog.get_byte(data,25) not in(2,6) or pg_catalog.encode(pg_catalog.substr(data,27,3),'hex')<>'000000' then raise exception 'NATIVE_SETTINGS_LOGO_INVALID';end if;
 end if;
end $f$;
create or replace function public.native_settings_profile_v1(d jsonb,rev bigint,op uuid) returns jsonb language sql immutable set search_path='' as $f$
 select pg_catalog.jsonb_build_object('name',d->>'name','rnc',nullif(d->>'rnc',''),'address',nullif(d->>'address',''),'phone',nullif(d->>'phone',''),'footer',nullif(d->>'footer',''),'whatsapp',nullif(d->>'whatsapp',''),'logo',d->'logo','color',d->>'color','font',d->>'font','bank',d->'bank','settingsRevision',rev::text,'settingsOperationId',op);
$f$;
revoke all on function public.native_settings_definition_v1(jsonb),public.native_settings_profile_v1(jsonb,bigint,uuid) from public,anon,authenticated;
create or replace function public.native_settings_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
#variable_conflict use_variable
declare v jsonb;req jsonb;d jsonb;doc jsonb;expected jsonb;n uuid;op uuid;i uuid;device uuid;k text;b uuid;epoch bigint;role text;revision bigint;seq bigint;effects jsonb;receipt jsonb;clock_ms text;old public.native_sales_ledger_v1%rowtype;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 or p_snapshot is not null or p_snapshot_hash is not null then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;if public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent) is distinct from p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 if v->>'protocol' is distinct from 'ventard.native.v1' or v->>'kind' is distinct from 'CONFIG_PATCH' or v->'contractVersion' is distinct from '1'::jsonb or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'expectedVersions' is distinct from '{}'::jsonb or v->'dependencies' is distinct from '[]'::jsonb or v->>'originalTurnId' is not null then raise exception 'NATIVE_INTENT_INVALID';end if;
 n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;device:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;
 role:=public.native_sales_context_v1(n,i,device,epoch,k,b);
 if op is null or role not in('owner','admin') or (v->>'actorId')::uuid is distinct from auth.uid() or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role) then raise exception using errcode='42501',message='NATIVE_SETTINGS_DENIED';end if;
 if not exists(select 1 from public.native_sales_mode_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b) then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_text<>p_intent or old.intent_hash<>p_hash or old.snapshot_text is not null then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 req:=v->'payload'->'request';doc:=v->'payload'->'document';
 perform public.native_sales_object_v1(req,array['kind','operationId','expectedRevision','definition']);
 if req->>'kind' is distinct from 'BUSINESS_SAVE' or req->>'operationId' is distinct from op::text or (select count(*) from pg_catalog.jsonb_object_keys(req))<>4 then raise exception 'NATIVE_REQUEST_INVALID';end if;
 d:=req->'definition';perform public.native_settings_definition_v1(d);
 select s.revision into revision from public.native_business_settings_v1 s where s.negocio_id=n for update;revision:=coalesce(revision,0);
 if public.native_sales_int_v1(req->'expectedRevision',2147483646)::bigint<>revision then raise exception 'NATIVE_SETTINGS_VERSION';end if;revision:=revision+1;
 expected:=pg_catalog.jsonb_build_object('operationId',op,'businessSettings',pg_catalog.jsonb_build_object('revision',revision::text,'definition',d),'business',public.native_settings_profile_v1(d,revision,op),'amountCents','0','method',null,'concept','Configuración del negocio');
 if doc is distinct from expected then raise exception 'NATIVE_DOCUMENT_INVALID';end if;perform public.native_sales_int_v1(v->'originAtUtcMs');
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;
 clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text;
 effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'management'),'kind','CONFIG_PATCH','payload',doc));
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',device,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',null,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',null,'ncf',null,'totalCents',null,'effects',effects,'stock','[]'::jsonb);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,device,epoch,'CONFIG_PATCH',p_intent,p_hash,null,null,null,null,seq,receipt);
 insert into public.native_management_records_v1 values(n,op,k,b,'CONFIG_PATCH',null,null,null,0,'Configuración del negocio',v->>'originAtUtcMs',doc);
 insert into public.native_sales_effects_v1 values(n,op,public.native_sales_effect_id_v1(op,'management'),'CONFIG_PATCH',doc);
 insert into public.native_business_settings_v1 values(n,revision,d,op) on conflict(negocio_id) do update set revision=excluded.revision,definition=excluded.definition,operation_id=excluded.operation_id;
 -- The original negocios name remains the fixed Staging safety guard. Native
 -- public configuration is independently versioned; it does not mutate plans.
 return receipt;
end $f$;
revoke all on function public.native_settings_submit_v1(text,text,text,text) from public,anon,authenticated;
create or replace function public.native_settings_header_valid_v1(n uuid,i uuid,k text,b uuid,header jsonb) returns boolean language sql stable set search_path='' as $f$
 select exists(select 1 from public.native_sales_snapshots_v1 ss where ss.negocio_id=n and ss.installation_id=i and ss.scope_kind=k and ss.sucursal_id is not distinct from b and ss.manifest->'business'=header)
 or exists(select 1 from public.native_management_records_v1 mr where mr.negocio_id=n and mr.kind='CONFIG_PATCH' and mr.document ? 'businessSettings' and mr.document->'business'=header);
$f$;
revoke all on function public.native_settings_header_valid_v1(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
-- Extend only the identical header predicate, preserving all commercial rules.
do $patch$ declare name text;source text;needle text:='not exists(select 1 from public.native_sales_snapshots_v1 ss where ss.negocio_id=n and ss.installation_id=i and ss.scope_kind=k and ss.sucursal_id is not distinct from b and ss.manifest->''business''=business)';
begin foreach name in array array['native_repairs_submit_v1','native_layaways_submit_v1','native_warranty_submit_v1'] loop
 select pg_catalog.pg_get_functiondef(p.oid) into source from pg_catalog.pg_proc p join pg_catalog.pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname=name;
 if source is null then raise exception 'NATIVE_SETTINGS_PARENT_INCOMPATIBLE';end if;
 if position(needle in source)>0 then execute pg_catalog.replace(source,needle,'not public.native_settings_header_valid_v1(n,i,k,b,business)');
 elsif position('native_settings_header_valid_v1' in source)=0 then raise exception 'NATIVE_SETTINGS_PARENT_INCOMPATIBLE';end if;
end loop;end $patch$;
do $rename$ begin
 if pg_catalog.to_regprocedure('public.native_sales_submit_settings_base_v1(text,text,text,text)') is null then alter function public.native_sales_submit_v1(text,text,text,text) rename to native_sales_submit_settings_base_v1;end if;
 if pg_catalog.to_regprocedure('public.native_sales_bootstrap_settings_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)') is null then alter function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) rename to native_sales_bootstrap_settings_base_v1;end if;
 if pg_catalog.to_regprocedure('public.native_sales_feed_settings_base_v1(uuid,uuid,uuid,bigint,text,uuid,bigint)') is null then alter function public.native_sales_feed_v1(uuid,uuid,uuid,bigint,text,uuid,bigint) rename to native_sales_feed_settings_base_v1;end if;
end $rename$;
revoke all on function public.native_sales_submit_settings_base_v1(text,text,text,text),public.native_sales_bootstrap_settings_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid),public.native_sales_feed_settings_base_v1(uuid,uuid,uuid,bigint,text,uuid,bigint) from public,anon,authenticated;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb:=p_intent::jsonb;header jsonb;begin
 if v->>'kind'='SALE_CONFIRM' and p_snapshot is not null and not exists(select 1 from public.native_sales_ledger_v1 where negocio_id=(v->>'negocioId')::uuid and operation_id=(v->>'operationId')::uuid) then
  header:=p_snapshot::jsonb->'business';
  if header is not null and header<>'null'::jsonb and not public.native_settings_header_valid_v1((v->>'negocioId')::uuid,(v->>'installationId')::uuid,v->'scope'->>'type',(v->'scope'->>'sucursalId')::uuid,header) then raise exception 'NATIVE_SERVICE_HEADER_INVALID';end if;
 end if;
 if v->>'kind'='CONFIG_PATCH' and v->'payload'->'request'->>'kind'='BUSINESS_SAVE' then return public.native_settings_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end if;
 return public.native_sales_submit_settings_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end $f$;
create or replace function public.native_settings_current_event_v1(n uuid,through bigint) returns jsonb language sql stable set search_path='' as $f$
 select pg_catalog.jsonb_build_object('intent',l.intent_text,'snapshot',null,'receipt',l.receipt) from public.native_management_records_v1 mr join public.native_sales_ledger_v1 l on l.negocio_id=mr.negocio_id and l.operation_id=mr.operation_id where mr.negocio_id=n and mr.kind='CONFIG_PATCH' and mr.document ? 'businessSettings' and l.remote_sequence<=through order by (mr.document->'businessSettings'->>'revision')::bigint desc limit 1;
$f$;
revoke all on function public.native_settings_current_event_v1(uuid,bigint) from public,anon,authenticated;
create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare m jsonb;event jsonb;old boolean;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||p_negocio_id::text,0));
 select exists(select 1 from public.native_sales_snapshots_v1 where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id) into old;
 m:=public.native_sales_bootstrap_settings_base_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,p_snapshot_id);
 if old then return m;end if;
 m:=m||pg_catalog.jsonb_build_object('businessSettingsProtocol','ventard.business.settings.1');
 event:=public.native_settings_current_event_v1(p_negocio_id,(m->>'watermark')::bigint);
 if event is not null then m:=m||pg_catalog.jsonb_build_object('business',event->'receipt'->'effects'->0->'payload'->'business','businessSettings',event);end if;
 update public.native_sales_snapshots_v1 set manifest=m where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;return m;
end $f$;
create or replace function public.native_sales_feed_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_after bigint) returns jsonb language plpgsql security definer set search_path='' as $f$
declare page jsonb;event jsonb;begin
 page:=public.native_sales_feed_settings_base_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,p_after);
 page:=page||pg_catalog.jsonb_build_object('businessSettingsProtocol','ventard.business.settings.1');
 event:=public.native_settings_current_event_v1(p_negocio_id,(page->>'scannedThrough')::bigint);
 if event is not null then page:=page||pg_catalog.jsonb_build_object('business',event->'receipt'->'effects'->0->'payload'->'business','businessSettings',event);end if;return page;
end $f$;
revoke all on function public.native_sales_submit_v1(text,text,text,text),public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid),public.native_sales_feed_v1(uuid,uuid,uuid,bigint,text,uuid,bigint) from public,anon;
grant execute on function public.native_sales_submit_v1(text,text,text,text),public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid),public.native_sales_feed_v1(uuid,uuid,uuid,bigint,text,uuid,bigint) to authenticated;
commit;
