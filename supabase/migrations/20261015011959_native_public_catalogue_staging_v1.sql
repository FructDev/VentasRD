-- Staging only. Applying this schema does not publish any business.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2
 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;
create table if not exists public.native_catalogue_publications_v1(
 negocio_id uuid primary key,revision bigint not null check(revision between 1 and 2147483647),operation_id uuid not null,
 foreign key(negocio_id,operation_id) references public.native_sales_ledger_v1(negocio_id,operation_id) deferrable initially deferred);
alter table public.native_catalogue_publications_v1 enable row level security;
revoke all on public.native_catalogue_publications_v1 from public,anon,authenticated;
create or replace function public.native_catalogue_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
#variable_conflict use_variable
declare v jsonb;req jsonb;doc jsonb;expected jsonb;n uuid;op uuid;i uuid;device uuid;k text;b uuid;epoch bigint;role text;revision bigint;seq bigint;effects jsonb;receipt jsonb;clock_ms text;old public.native_sales_ledger_v1%rowtype;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 or p_snapshot is not null or p_snapshot_hash is not null then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;if public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent) is distinct from p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 if v->>'protocol' is distinct from 'ventard.native.v1' or v->>'kind' is distinct from 'CONFIG_PATCH' or v->'contractVersion' is distinct from '1'::jsonb or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'expectedVersions' is distinct from '{}'::jsonb or v->'dependencies' is distinct from '[]'::jsonb or v->>'originalTurnId' is not null then raise exception 'NATIVE_INTENT_INVALID';end if;
 n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;device:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;
 role:=public.native_sales_context_v1(n,i,device,epoch,k,b);
 if op is null or role not in('owner','admin') or (v->>'actorId')::uuid is distinct from auth.uid() or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role) then raise exception using errcode='42501',message='NATIVE_CATALOGUE_DENIED';end if;
 if not exists(select 1 from public.native_sales_mode_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b) then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_text<>p_intent or old.intent_hash<>p_hash or old.snapshot_text is not null then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 req:=v->'payload'->'request';doc:=v->'payload'->'document';
 perform public.native_sales_object_v1(v->'payload',array['request','document']);
 perform public.native_sales_object_v1(req,array['kind','operationId','expectedRevision','expectedEnabled','enabled']);
 if req->>'kind' is distinct from 'CATALOGUE_PUBLISH' or req->>'operationId' is distinct from op::text or (select count(*) from pg_catalog.jsonb_object_keys(req))<>5 or pg_catalog.jsonb_typeof(req->'expectedEnabled') is distinct from 'boolean' or pg_catalog.jsonb_typeof(req->'enabled') is distinct from 'boolean' or req->'enabled'=req->'expectedEnabled' then raise exception 'NATIVE_REQUEST_INVALID';end if;
 perform 1 from public.negocios where id=n for update;
 select s.revision into revision from public.native_catalogue_publications_v1 s where s.negocio_id=n;revision:=coalesce(revision,0);
 if public.native_sales_int_v1(req->'expectedRevision',2147483646)::bigint<>revision or (req->>'expectedEnabled')::boolean is distinct from (select coalesce(catalogo_publico,false) from public.negocios where id=n) then raise exception 'NATIVE_CATALOGUE_VERSION';end if;revision:=revision+1;
 expected:=pg_catalog.jsonb_build_object('cataloguePublication',pg_catalog.jsonb_build_object('enabled',(req->>'enabled')::boolean,'revision',revision::text,'publicPath','/catalogo/'||n::text),'amountCents','0','method',null,'concept',case when (req->>'enabled')::boolean then 'Catálogo público activado' else 'Catálogo público desactivado' end);
 if doc is distinct from expected then raise exception 'NATIVE_DOCUMENT_INVALID';end if;perform public.native_sales_int_v1(v->'originAtUtcMs');
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;
 clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text;
 effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'management'),'kind','CONFIG_PATCH','payload',doc));
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',device,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',null,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',null,'ncf',null,'totalCents',null,'effects',effects,'stock','[]'::jsonb);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,device,epoch,'CONFIG_PATCH',p_intent,p_hash,null,null,null,null,seq,receipt);
 insert into public.native_management_records_v1 values(n,op,k,b,'CONFIG_PATCH',null,null,null,0,doc->>'concept',v->>'originAtUtcMs',doc);
 insert into public.native_sales_effects_v1 values(n,op,public.native_sales_effect_id_v1(op,'management'),'CONFIG_PATCH',doc);
 insert into public.native_catalogue_publications_v1 values(n,revision,op) on conflict(negocio_id) do update set revision=excluded.revision,operation_id=excluded.operation_id;
 update public.negocios set catalogo_publico=(req->>'enabled')::boolean where id=n;
 return receipt;
end $f$;
revoke all on function public.native_catalogue_submit_v1(text,text,text,text) from public,anon,authenticated;
create or replace function public.native_catalogue_settings_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare role text;v jsonb;
begin
 role:=public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if role not in('owner','admin') then raise exception using errcode='42501',message='NATIVE_CATALOGUE_DENIED';end if;
 select pg_catalog.jsonb_build_object('version','ventard.catalogue.publication.1','tenantId',n.id,'enabled',coalesce(n.catalogo_publico,false),'revision',coalesce(c.revision,0)::text,'publicPath','/catalogo/'||n.id::text) into v from public.negocios n left join public.native_catalogue_publications_v1 c on c.negocio_id=n.id where n.id=p_negocio_id;
 if v is null then raise exception 'NATIVE_CATALOGUE_DENIED';end if;return v;
end $f$;
revoke all on function public.native_catalogue_settings_v1(uuid,uuid,uuid,bigint,text,uuid) from public,anon;
grant execute on function public.native_catalogue_settings_v1(uuid,uuid,uuid,bigint,text,uuid) to authenticated;
do $rename$ begin
 if pg_catalog.to_regprocedure('public.native_sales_submit_catalogue_base_v1(text,text,text,text)') is null then alter function public.native_sales_submit_v1(text,text,text,text) rename to native_sales_submit_catalogue_base_v1;end if;
end $rename$;
revoke all on function public.native_sales_submit_catalogue_base_v1(text,text,text,text) from public,anon,authenticated;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb:=p_intent::jsonb;begin
 if v->>'kind'='CONFIG_PATCH' and v->'payload'->'request'->>'kind'='CATALOGUE_PUBLISH' then return public.native_catalogue_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end if;
 return public.native_sales_submit_catalogue_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end $f$;
revoke all on function public.native_sales_submit_v1(text,text,text,text) from public,anon;
grant execute on function public.native_sales_submit_v1(text,text,text,text) to authenticated;
-- Called exclusively by the existing rate-limited web API, with service role.
create or replace function public.native_public_catalogue_page_v1(p_negocio_id uuid,p_after_id uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare n public.negocios%rowtype;d jsonb;rows jsonb;last_id uuid;has_more boolean;
begin
 select * into n from public.negocios where id=p_negocio_id and catalogo_publico is true;
 if not found then raise exception 'NATIVE_CATALOGUE_UNAVAILABLE';end if;
 select definition into d from public.native_business_settings_v1 where negocio_id=p_negocio_id;
 with page as (select p.id,p.nombre,p.precio_venta,case when m.photo is not null then m.photo->>'data' else p.imagen_url end as imagen_url from public.productos p left join public.native_product_metadata_v1 m on m.producto_id=p.id and m.negocio_id=p.negocio_id where p.negocio_id=p_negocio_id and coalesce(p.eliminado,false)=false and (p_after_id is null or p.id>p_after_id) order by p.id limit 200)
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(page) order by id),'[]'::jsonb) into rows from page;
 last_id:=(rows->-1->>'id')::uuid;
 select exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and coalesce(p.eliminado,false)=false and p.id>last_id) into has_more;
 return pg_catalog.jsonb_build_object('negocio',pg_catalog.jsonb_build_object('nombre',coalesce(d->>'name',n.nombre),'whatsapp',case when d is null then coalesce(nullif(n.whatsapp_dueno,''),nullif(n.telefono,'')) else coalesce(nullif(d->>'whatsapp',''),nullif(d->>'phone','')) end,'direccion',case when d is null then n.direccion else nullif(d->>'address','') end,'logo_url',case when d is null then n.logo_url else d->>'logo' end,'color_marca',coalesce(d->>'color',n.color_marca,'dorado')),'productos',rows,'nextId',case when has_more then last_id else null end);
end $f$;
revoke all on function public.native_public_catalogue_page_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.native_public_catalogue_page_v1(uuid,uuid) to service_role;
commit;
