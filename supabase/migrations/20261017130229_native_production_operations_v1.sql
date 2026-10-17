-- Production pilot operations; source-equivalent financial protocol.
-- LOCAL PREPARATION ONLY. Applying schema activates no business or writer.
-- Requires production access migration; reads real entitlements, never seeds QA.
-- NCF provisioning/allocation/settings/sequence triggers are excluded.
begin;
do $production_guard$ begin
 if pg_catalog.to_regclass('public.native_staging_licenses_v1') is not null or pg_catalog.to_regclass('public.native_production_cohort_v1') is null then raise exception 'NATIVE_PRODUCTION_ACCESS_REQUIRED';end if;
end $production_guard$;
-- Source: 20261009235809_native_catalogue_snapshot_v1.sql SHA256 5172eadc7c744100067c61fca3144d886650f95f7083108d2912bc0d0a4400f4
-- snapshot writes only. NOT a convergence feed, saleable base or sync receipt.

do $guard$ begin

end $guard$;

create table if not exists public.native_catalogue_snapshots_v1(
 snapshot_id uuid primary key,negocio_id uuid not null references public.negocios(id),
 actor_id uuid not null references auth.users(id),installation_id uuid not null,device_id uuid not null,
 writer_epoch bigint not null,scope_kind text not null check(scope_kind in('GLOBAL','BRANCH')),
 sucursal_id uuid,actor_role text not null check(actor_role in('owner','admin','vendedor')),
 captured_at_ms bigint not null,expires_at_ms bigint not null,manifest jsonb,
 foreign key(negocio_id,installation_id) references public.native_installations_v1(negocio_id,installation_id),
 check((scope_kind='GLOBAL' and sucursal_id is null)or(scope_kind='BRANCH' and sucursal_id is not null)),
 check(expires_at_ms>captured_at_ms and expires_at_ms-captured_at_ms=86400000)
);
create table if not exists public.native_catalogue_pages_v1(
 snapshot_id uuid not null references public.native_catalogue_snapshots_v1(snapshot_id),
 page_index integer not null check(page_index between 0 and 49),
 row_count integer not null check(row_count between 1 and 200),
 payload_text text not null,byte_length integer not null check(byte_length between 1 and 1048576),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),primary key(snapshot_id,page_index)
);
create index if not exists native_catalogue_actor_v1 on public.native_catalogue_snapshots_v1(negocio_id,actor_id,installation_id);
alter table public.native_catalogue_snapshots_v1 enable row level security;
alter table public.native_catalogue_pages_v1 enable row level security;
-- Deliberately no direct client policies or table grants: both tables deny all.
revoke all on public.native_catalogue_snapshots_v1,public.native_catalogue_pages_v1 from public,anon,authenticated;

create or replace function public.native_catalogue_authorize_v1(
 p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid
)returns text language plpgsql stable security definer set search_path='' as $fn$
declare v_role text;
begin
 if auth.uid() is null then raise exception using errcode='42501',message='NATIVE_AUTH_REQUIRED';end if;
 v_role:=public.native_member_role_v1(p_negocio_id);
 if v_role is null or not exists(select 1 from public.native_actor_sequences_v1 a where a.negocio_id=p_negocio_id and a.installation_id=p_installation_id and a.actor_id=auth.uid())
 then raise exception using errcode='42501',message='NATIVE_TENANT_DENIED';end if;
 if not exists(select 1 from public.native_installations_v1 i where i.negocio_id=p_negocio_id and i.installation_id=p_installation_id and i.device_id=p_device_id
 and i.writer_epoch=p_writer_epoch and i.scope_kind=p_scope_kind and i.sucursal_id is not distinct from p_sucursal_id and i.status='REGISTERED')
 then raise exception using errcode='42501',message='NATIVE_DEVICE_CONTEXT_MISMATCH';end if;
 if p_scope_kind='BRANCH' and not exists(select 1 from public.sucursales s where s.id=p_sucursal_id and s.negocio_id=p_negocio_id)
 then raise exception using errcode='42501',message='NATIVE_BRANCH_DENIED';end if;
 return v_role;
end $fn$;
revoke all on function public.native_catalogue_authorize_v1(uuid,uuid,uuid,bigint,text,uuid) from public,anon,authenticated;

create or replace function public.native_catalogue_begin_v1(
 p_snapshot_id uuid,p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid
)returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_role text;v_ms bigint;v_old public.native_catalogue_snapshots_v1%rowtype;v_manifest jsonb;v_count bigint;
begin
 v_role:=public.native_catalogue_authorize_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if p_snapshot_id is null then raise exception using errcode='22023',message='NATIVE_REQUEST_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-catalogue:'||p_snapshot_id::text,0));
 select * into v_old from public.native_catalogue_snapshots_v1 where snapshot_id=p_snapshot_id;
 v_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint;
 if found then
  if v_old.negocio_id<>p_negocio_id or v_old.actor_id<>auth.uid() or v_old.installation_id<>p_installation_id or v_old.device_id<>p_device_id
   or v_old.writer_epoch<>p_writer_epoch or v_old.scope_kind<>p_scope_kind or v_old.sucursal_id is distinct from p_sucursal_id or v_old.actor_role<>v_role
  then raise exception using errcode='42501',message='NATIVE_SNAPSHOT_CONTEXT_MISMATCH';end if;
  if v_ms>=v_old.expires_at_ms then raise exception using errcode='55000',message='NATIVE_SNAPSHOT_EXPIRED';end if;
  return v_old.manifest;
 end if;
 insert into public.native_catalogue_snapshots_v1(snapshot_id,negocio_id,actor_id,installation_id,device_id,writer_epoch,scope_kind,sucursal_id,actor_role,captured_at_ms,expires_at_ms)
 values(p_snapshot_id,p_negocio_id,auth.uid(),p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,v_role,v_ms,v_ms+86400000);
 -- All product/branch values captured in ONE source statement, then immutable.
 -- No per-page live query and no fabricated feed watermark. JSONB text is NOT
 -- C-N1: checksum is SHA256-UTF8-v1 over the exact stored payload_text bytes.
 with source as materialized(
  select p.id,p.nombre,p.codigo_barras,p.precio_venta,
   case when p_scope_kind='BRANCH' then i.stock_actual else p.stock_actual end as stock,
   case when p_scope_kind='BRANCH' and i.producto_id is null then 'MISSING_BRANCH_AUTHORITY'
        when p_scope_kind='GLOBAL' and p.stock_actual is null then 'MISSING_GLOBAL_AUTHORITY' else 'POINT_IN_TIME' end as evidence
  from public.productos p left join public.inventario_sucursales i on p_scope_kind='BRANCH' and i.producto_id=p.id and i.sucursal_id=p_sucursal_id
  where p.negocio_id=p_negocio_id and p.eliminado=false order by p.id limit 10001
 ), numbered as(
  select ((pg_catalog.row_number()over(order by id)-1)/200)::integer as page_index,id,
   pg_catalog.jsonb_build_object('id',id,'name',nombre,'code',codigo_barras,
   'priceCents',case when precio_venta>=0 and precio_venta*100=pg_catalog.trunc(precio_venta*100) and precio_venta*100<=9007199254740991 then (precio_venta*100)::bigint::text else null end,
   'stock',stock::text,'stockEvidence',evidence)as row from source
 ), grouped as(
  select page_index,count(*)::integer as n,pg_catalog.jsonb_agg(row order by id)::text as payload from numbered group by page_index
 )insert into public.native_catalogue_pages_v1(snapshot_id,page_index,row_count,payload_text,byte_length,sha256)
 select p_snapshot_id,page_index,n,payload,pg_catalog.octet_length(payload),pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload,'UTF8')),'hex')from grouped;
 select coalesce(sum(row_count),0)into v_count from public.native_catalogue_pages_v1 where snapshot_id=p_snapshot_id;
 if v_count>10000 then raise exception using errcode='54000',message='NATIVE_CATALOGUE_LIMIT';end if;
 select pg_catalog.jsonb_build_object('version','ventard.native.catalogue.preview.1','snapshotId',p_snapshot_id,
 'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'deviceId',p_device_id,'installationId',p_installation_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),
 'capturedAtMs',v_ms::text,'expiresAtMs',(v_ms+86400000)::text,'coverage','CATALOGUE_PREVIEW_V1','watermark',null,'totalCount',v_count,
 'pages',coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('index',page_index,'count',row_count,'byteLength',byte_length,'sha256',sha256)order by page_index),'[]'::jsonb))into v_manifest
 from public.native_catalogue_pages_v1 where snapshot_id=p_snapshot_id;
 update public.native_catalogue_snapshots_v1 set manifest=v_manifest where snapshot_id=p_snapshot_id;
 return v_manifest;
end $fn$;

create or replace function public.native_catalogue_page_v1(p_snapshot_id uuid,p_page_index integer)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_snapshot public.native_catalogue_snapshots_v1%rowtype;v_role text;v_payload text;
begin
 select * into v_snapshot from public.native_catalogue_snapshots_v1 where snapshot_id=p_snapshot_id and actor_id=auth.uid();
 if not found then raise exception using errcode='42501',message='NATIVE_SNAPSHOT_DENIED';end if;
 v_role:=public.native_catalogue_authorize_v1(v_snapshot.negocio_id,v_snapshot.installation_id,v_snapshot.device_id,v_snapshot.writer_epoch,v_snapshot.scope_kind,v_snapshot.sucursal_id);
 if v_role<>v_snapshot.actor_role then raise exception using errcode='42501',message='NATIVE_ROLE_CHANGED';end if;
 if pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint>=v_snapshot.expires_at_ms
 then raise exception using errcode='55000',message='NATIVE_SNAPSHOT_EXPIRED';end if;
 select payload_text into v_payload from public.native_catalogue_pages_v1 where snapshot_id=p_snapshot_id and page_index=p_page_index;
 if not found then raise exception using errcode='22023',message='NATIVE_PAGE_INVALID';end if;
 return pg_catalog.jsonb_build_object('snapshotId',p_snapshot_id,'index',p_page_index,'payload',v_payload);
end $fn$;
revoke all on function public.native_catalogue_begin_v1(uuid,uuid,uuid,uuid,bigint,text,uuid),public.native_catalogue_page_v1(uuid,integer) from public,anon;
grant execute on function public.native_catalogue_begin_v1(uuid,uuid,uuid,uuid,bigint,text,uuid),public.native_catalogue_page_v1(uuid,integer) to authenticated;

-- Source: 20261011111415_native_sales_staging_v1.sql SHA256 f6bb6f6cf3ec88921b0df70b0e07a3c7765399ad2953bc12fd3e9ffc75257507
-- ACTIVE fences old writers; this cannot stop an old client that is offline.

do $guard$ begin

end $guard$;
create table if not exists public.native_sales_mode_v1(negocio_id uuid primary key references public.negocios(id),scope_kind text not null check(scope_kind in('GLOBAL','BRANCH')),sucursal_id uuid,free_tax numeric not null check(free_tax between 0 and 1),activated_by uuid not null,source_approval text not null,check((scope_kind='GLOBAL' and sucursal_id is null)or(scope_kind='BRANCH' and sucursal_id is not null)));
create table if not exists public.native_sales_counter_v1(negocio_id uuid primary key,last_sequence bigint not null default 0 check(last_sequence>=0));
create table if not exists public.native_sales_ledger_v1(negocio_id uuid not null,operation_id uuid not null,scope_kind text not null,sucursal_id uuid,actor_id uuid not null,installation_id uuid not null,device_id uuid not null,writer_epoch bigint not null,kind text not null,intent_text text not null,intent_hash text not null check(intent_hash~'^[0-9a-f]{64}$'),snapshot_text text,snapshot_hash text,ticket text,ncf text,remote_sequence bigint not null,receipt jsonb not null,primary key(negocio_id,operation_id),unique(negocio_id,remote_sequence),unique(negocio_id,ticket),unique(negocio_id,ncf));
create table if not exists public.native_sales_stock_v1(negocio_id uuid not null,scope_kind text not null,sucursal_id uuid,producto_id uuid not null,revision bigint not null default 0);
create unique index if not exists native_sales_stock_scope_v1 on public.native_sales_stock_v1(negocio_id,scope_kind,sucursal_id,producto_id) nulls not distinct;
create table if not exists public.native_sales_credit_v1(negocio_id uuid not null,cliente_id uuid not null,balance_cents bigint not null,revision bigint not null default 1,primary key(negocio_id,cliente_id));
create table if not exists public.native_sales_turns_v1(negocio_id uuid not null,turn_id uuid not null,scope_kind text not null,sucursal_id uuid,installation_id uuid not null,device_id uuid not null,actor_id uuid not null,opening_cents bigint not null,opened_at_ms text not null,status text not null check(status in('OPEN','CLOSED')),revision bigint not null,primary key(negocio_id,turn_id));
create unique index if not exists native_sales_one_turn_v1 on public.native_sales_turns_v1(negocio_id,scope_kind,sucursal_id) nulls not distinct where status='OPEN';
create table if not exists public.native_sales_effects_v1(negocio_id uuid not null,operation_id uuid not null,effect_id uuid not null,kind text not null,payload jsonb not null,primary key(negocio_id,effect_id),foreign key(negocio_id,operation_id) references public.native_sales_ledger_v1(negocio_id,operation_id) deferrable initially deferred);
create table if not exists public.native_sales_write_context_v1(transaction_id bigint not null,negocio_id uuid not null,primary key(transaction_id,negocio_id));
create table if not exists public.native_sales_snapshots_v1(negocio_id uuid not null,snapshot_id uuid not null,actor_id uuid not null,installation_id uuid not null,device_id uuid not null,writer_epoch bigint not null,scope_kind text not null,sucursal_id uuid,manifest jsonb not null,expires_at_ms bigint not null,primary key(negocio_id,snapshot_id));
create table if not exists public.native_sales_pages_v1(negocio_id uuid not null,snapshot_id uuid not null,page_index integer not null,payload text not null,primary key(negocio_id,snapshot_id,page_index),foreign key(negocio_id,snapshot_id) references public.native_sales_snapshots_v1(negocio_id,snapshot_id));
-- Exact C-N1 subset. Raw duplicate keys/escapes/ordering rejected by equality
-- with reconstructed bytes. Never hash jsonb::text as if it were C-N1.
create or replace function public.native_sales_canonical_v1(v jsonb,depth integer default 0) returns text language plpgsql immutable set search_path='' as $f$
declare k text;x jsonb;r text;pieces text[]:=array[]::text[];t text:=pg_catalog.jsonb_typeof(v);
begin
 if v is null then raise exception 'NATIVE_CANON_INVALID';end if;
 if depth>64 then raise exception 'NATIVE_CANON_DEPTH';end if;
 if t='object' then for k,x in select key,value from pg_catalog.jsonb_each(v) order by key collate "C" loop if k~'[^\x00-\x7F]' then raise exception 'NATIVE_CANON_KEY';end if;pieces:=pg_catalog.array_append(pieces,pg_catalog.to_json(k)::text||':'||public.native_sales_canonical_v1(x,depth+1));end loop;return '{'||pg_catalog.array_to_string(pieces,',')||'}';
 elsif t='array' then for x in select value from pg_catalog.jsonb_array_elements(v) loop pieces:=pg_catalog.array_append(pieces,public.native_sales_canonical_v1(x,depth+1));end loop;return '['||pg_catalog.array_to_string(pieces,',')||']';
 elsif t='string' then return pg_catalog.to_json(v#>>'{}')::text;
 elsif t='number' then r:=v::text;if r!~'^(0|[1-9][0-9]*)$' or r::numeric>9007199254740991 then raise exception 'NATIVE_CANON_NUMBER';end if;return r;
 else return v::text;end if;
end $f$;
create or replace function public.native_sales_hash_v1(v text) returns text language sql immutable set search_path='' as $f$ select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v,'UTF8')),'hex') $f$;
create or replace function public.native_sales_int_v1(v jsonb,maximum numeric default 9007199254740991) returns numeric language plpgsql immutable set search_path='' as $f$
declare s text:=v#>>'{}';begin if v is null or pg_catalog.jsonb_typeof(v) is distinct from 'string' or s!~'^(0|[1-9][0-9]*)$' or pg_catalog.length(s)>400 or s::numeric>maximum then raise exception 'NATIVE_INTEGER_INVALID';end if;return s::numeric;end $f$;
create or replace function public.native_sales_effect_id_v1(op uuid,part text) returns uuid language plpgsql immutable set search_path='' as $f$
declare h text:=public.native_sales_hash_v1('ventard.local-effect.v1/'||op::text||'/'||part);begin return (pg_catalog.substr(h,1,12)||'8'||pg_catalog.substr(h,14,3)||pg_catalog.to_hex((('x'||pg_catalog.substr(h,17,1))::bit(4)::integer & 3)|8)||pg_catalog.substr(h,18,15))::uuid;end $f$;
create or replace function public.native_sales_object_v1(v jsonb,required text[]) returns void language plpgsql immutable set search_path='' as $f$
begin if pg_catalog.jsonb_typeof(v) is distinct from 'object' or not(v ?& required) then raise exception 'NATIVE_OBJECT_INVALID';end if;end $f$;
create or replace function public.native_sales_context_v1(n uuid,i uuid,d uuid,e bigint,k text,b uuid) returns text language plpgsql stable security definer set search_path='' as $f$
declare r text;
begin r:=public.native_member_role_v1(n);
 if auth.uid() is null or r is null or not exists(select 1 from public.native_installations_v1 x join public.native_actor_sequences_v1 a on a.negocio_id=x.negocio_id and a.installation_id=x.installation_id where x.negocio_id=n and x.installation_id=i and x.device_id=d and x.writer_epoch=e and x.scope_kind=k and x.sucursal_id is not distinct from b and x.status='REGISTERED' and a.actor_id=auth.uid()) then raise exception using errcode='42501',message='NATIVE_CONTEXT_DENIED';end if;
 if k is null or k not in('BRANCH','GLOBAL') or (k='GLOBAL' and b is not null) or (k='BRANCH' and not exists(select 1 from public.sucursales where id=b and negocio_id=n)) then raise exception using errcode='42501',message='NATIVE_BRANCH_DENIED';end if;
 if not exists(select 1 from public.native_entitlements_v1 where negocio_id=n and plan_active and (access_until_ms is null or access_until_ms+432000000>=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000))) then raise exception using errcode='42501',message='NATIVE_LICENSE_DENIED';end if;
 return r;end $f$;
create or replace function public.native_sales_fence_v1() returns trigger language plpgsql security definer set search_path='' as $f$
declare j jsonb;n uuid;p uuid;items jsonb[];
begin
 items:=case when TG_OP='UPDATE' then array[pg_catalog.to_jsonb(OLD),pg_catalog.to_jsonb(NEW)] when TG_OP='DELETE' then array[pg_catalog.to_jsonb(OLD)] else array[pg_catalog.to_jsonb(NEW)] end;
 foreach j in array items loop
  if TG_TABLE_NAME='inventario_sucursales' then p:=(j->>'producto_id')::uuid;select x.negocio_id into n from public.productos x where x.id=p;else n:=nullif(j->>'negocio_id','')::uuid;end if;
  if exists(select 1 from public.native_sales_mode_v1 m where m.negocio_id=n) and not exists(select 1 from public.native_sales_write_context_v1 w where w.transaction_id=pg_catalog.txid_current() and w.negocio_id=n) then raise exception using errcode='42501',message='NATIVE_LEGACY_WRITER_FENCED';end if;
 end loop;
 if TG_OP='DELETE' then return OLD;else return NEW;end if;
end $f$;
do $ddl$ declare t text;begin
 foreach t in array array['productos','inventario_sucursales','clientes','composiciones','seriales','transacciones_fiado','ventas','venta_detalles','cajas','gastos','devoluciones','reparaciones','apartados'] loop
 if pg_catalog.to_regclass('public.'||t) is not null then execute pg_catalog.format('drop trigger if exists native_sales_fence_v1 on public.%I',t);execute pg_catalog.format('create trigger native_sales_fence_v1 before insert or update or delete on public.%I for each row execute function public.native_sales_fence_v1()',t);end if;end loop;
 foreach t in array array['native_sales_mode_v1','native_sales_counter_v1','native_sales_ledger_v1','native_sales_stock_v1','native_sales_credit_v1','native_sales_turns_v1','native_sales_effects_v1','native_sales_write_context_v1','native_sales_snapshots_v1','native_sales_pages_v1'] loop execute pg_catalog.format('alter table public.%I enable row level security',t);execute pg_catalog.format('revoke all on public.%I from public,anon,authenticated',t);end loop;
end $ddl$;
create or replace function public.native_sales_activate_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_confirmation text,p_free_tax text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare r text;m public.native_sales_mode_v1%rowtype;
begin r:=public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if r not in('owner','admin') or p_confirmation is distinct from 'PRODUCTION_CLOUD_BASELINE_REVIEWED' or p_free_tax is null or p_free_tax!~'^(0(\.[0-9]{1,2})?|1(\.0{1,2})?)$' then raise exception using errcode='42501',message='NATIVE_SETUP_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||p_negocio_id::text,0));
 select * into m from public.native_sales_mode_v1 where negocio_id=p_negocio_id;
 if found and (m.scope_kind<>p_scope_kind or m.sucursal_id is distinct from p_sucursal_id or m.free_tax<>p_free_tax::numeric) then raise exception 'NATIVE_ACTIVE_SCOPE_CONFLICT';end if;
 if not found then
  -- Fence all old mutations before adopting the current synthetic baseline.
  lock table public.productos,public.inventario_sucursales,public.clientes,public.seriales,public.composiciones,public.transacciones_fiado in share row exclusive mode;
  insert into public.native_sales_counter_v1 values(p_negocio_id,0) on conflict do nothing;
  insert into public.native_sales_stock_v1 select p_negocio_id,p_scope_kind,p_sucursal_id,id,0 from public.productos where negocio_id=p_negocio_id on conflict do nothing;
  if exists(select 1 from public.transacciones_fiado f where f.negocio_id=p_negocio_id and (f.tipo is null or f.tipo not in('cargo','abono') or f.monto is null or f.monto<0 or f.monto*100<>pg_catalog.trunc(f.monto*100))) then raise exception 'NATIVE_CREDIT_SOURCE_UNVERIFIABLE';end if;
  insert into public.native_sales_credit_v1 select p_negocio_id,c.id,coalesce((select sum(case when f.tipo='cargo' then f.monto else -f.monto end)*100 from public.transacciones_fiado f where f.negocio_id=p_negocio_id and f.cliente_id=c.id),0)::bigint,1 from public.clientes c where c.negocio_id=p_negocio_id on conflict do nothing;
  insert into public.native_sales_mode_v1 values(p_negocio_id,p_scope_kind,p_sucursal_id,p_free_tax::numeric,auth.uid(),p_confirmation);
 end if;
 return pg_catalog.jsonb_build_object('protocol','ventard.native.activation.1','tenantId',p_negocio_id,'installationId',p_installation_id,'deviceId',p_device_id,'writerEpoch',p_writer_epoch::text,'scope',pg_catalog.jsonb_build_object('type',p_scope_kind,'branchId',p_sucursal_id),'namespace','NATIVE1','ticketPrefix','N'||pg_catalog.replace(p_installation_id::text,'-',''),'lastTicket','0','coverage','CLOUD_ADOPTED_V1');
end $f$;
create or replace function public.native_sales_lookup_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_operation_id uuid,p_hash text) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare x public.native_sales_ledger_v1%rowtype;begin perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 select * into x from public.native_sales_ledger_v1 where negocio_id=p_negocio_id and operation_id=p_operation_id and scope_kind=p_scope_kind and sucursal_id is not distinct from p_sucursal_id;
 if not found then return pg_catalog.jsonb_build_object('status','NOT_FOUND','operationId',p_operation_id,'intentHash',p_hash);end if;
 if x.intent_hash<>p_hash then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return x.receipt;end $f$;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;s jsonb;doc jsonb;pay jsonb;n uuid;op uuid;i uuid;d uuid;b uuid;k text;epoch bigint;role text;old public.native_sales_ledger_v1%rowtype;
 mode public.native_sales_mode_v1%rowtype;ln jsonb;eff jsonb;proof jsonb;pend jsonb;product public.productos%rowtype;pid uuid;qty numeric;price numeric;rate numeric;sub numeric:=0;tax numeric:=0;disc numeric;total numeric;cash numeric;credit numeric;transfer numeric;card numeric;tender numeric;change numeric;debt numeric;limit_credit numeric;cid uuid;turn uuid;seq bigint;cur integer;after integer;version bigint;expected_version bigint;delta integer;stock jsonb:='[]';effects jsonb:='[]';eid uuid;clock_ms text;receipt jsonb;expected jsonb:='{}';part jsonb;ingredient uuid;part_qty numeric;num numeric;den numeric;method text;serial jsonb;rows_n integer;sn text;ncftype text;ncfnum bigint;own_projection numeric;price_base numeric;tier integer;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 or (p_snapshot is not null and pg_catalog.octet_length(p_snapshot)>1048576) then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;if public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent)<>p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 perform public.native_sales_int_v1(v->'originAtUtcMs');
 if p_hash is null or p_hash!~'^[0-9a-f]{64}$' or pg_catalog.jsonb_typeof(v->'dependencies') is distinct from 'array' or pg_catalog.jsonb_array_length(v->'dependencies')>100 then raise exception 'NATIVE_INTENT_INVALID';end if;
 n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;
 role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or (v->>'actorId')::uuid is distinct from auth.uid() or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role) then raise exception using errcode='42501',message='NATIVE_INTENT_CONTEXT_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is distinct from p_snapshot_hash or old.snapshot_text is distinct from p_snapshot then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 select * into mode from public.native_sales_mode_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b;
 if not found then raise exception using errcode='42501',message='NATIVE_ACTIVATION_REQUIRED';end if;
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;
 clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 if v->>'kind'='TURN_OPEN' then
  if p_snapshot is not null or p_snapshot_hash is not null or exists(select 1 from public.native_sales_turns_v1 where negocio_id=n and status='OPEN' and scope_kind=k and sucursal_id is not distinct from b) then raise exception 'NATIVE_TURN_CONFLICT';end if;
  cash:=public.native_sales_int_v1(v->'payload'->'openingCents');
  insert into public.native_sales_turns_v1 values(n,op,k,b,i,d,auth.uid(),cash::bigint,v->>'originAtUtcMs','OPEN',seq);
  effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',op,'kind','TURN_OPEN','amountCents',cash::text));
 elsif v->>'kind'='SALE_CONFIRM' then
  if p_snapshot is null or p_snapshot_hash is null then raise exception 'NATIVE_SNAPSHOT_REQUIRED';end if;
  s:=p_snapshot::jsonb;if public.native_sales_canonical_v1(s)<>p_snapshot or public.native_sales_hash_v1(p_snapshot)<>p_snapshot_hash then raise exception 'NATIVE_SNAPSHOT_HASH_INVALID';end if;
  doc:=v->'payload'->'sale';pay:=doc->'payment';
  perform public.native_sales_object_v1(s,array['version','operationId','tenantId','actorId','originAtUtcMs','scope','ticket','ncf','customerName','sale']);
  perform public.native_sales_object_v1(doc,array['currency','calculationVersion','lines','discount','totals','payment','inventory','serials','stockEvidence','fiscal']);
  if v->'payload'->>'quoteHash' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_set(doc,'{fiscal}','null'::jsonb))) then raise exception 'NATIVE_QUOTE_HASH_INVALID';end if;
  perform public.native_sales_object_v1(pay,array['method','customerId','paidCents','creditChargeCents','cashNetCents','cardCents','transferCents','tenderCents','changeCents','turnId','bankSettlementVerified']);
  if pg_catalog.jsonb_typeof(doc->'lines') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'inventory') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'serials') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'stockEvidence') is distinct from 'array' then raise exception 'NATIVE_SALE_ARRAY_INVALID';end if;
  if s->'sale' is distinct from doc or s->>'version' is distinct from 'ventard.ticket.snapshot.1' or s->>'operationId' is distinct from op::text or s->>'tenantId' is distinct from n::text or s->>'actorId' is distinct from auth.uid()::text or s->>'originAtUtcMs' is distinct from v->>'originAtUtcMs' or s->'scope' is distinct from pg_catalog.jsonb_build_object('type',k,'branchId',b) or s->>'ticket' is null or s->>'ticket'!~('^N'||pg_catalog.replace(i::text,'-','')||'-[0-9]{6,}$') or doc->>'currency' is distinct from 'DOP' or doc->>'calculationVersion' is distinct from 'ventard.sale.calculation.1' or pg_catalog.jsonb_array_length(doc->'lines') not between 1 and 100 then raise exception 'NATIVE_SALE_INVALID';end if;
  if doc ? 'customer' then
   perform public.native_sales_object_v1(doc->'customer',array['id','name','revision']);
   if s->>'customerName' is distinct from doc->'customer'->>'name' or pg_catalog.length(s->>'customerName') not between 1 and 256 or s->>'customerName' ~ '[[:cntrl:]]' then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   cid:=(doc->'customer'->>'id')::uuid;
   if cid is not null and not exists(select 1 from public.clientes c where c.id=cid and c.negocio_id=n and c.estado='activo' and c.nombre=doc->'customer'->>'name' and doc->'customer'->>'revision'='1') then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   if pay->>'method'='FIADO' and (cid is null or cid::text is distinct from pay->>'customerId') then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  elsif s->>'customerName' is not null and pay->>'method'<>'FIADO' then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  for ln in select value from pg_catalog.jsonb_array_elements(doc->'lines') loop
   perform public.native_sales_object_v1(ln,array['productId','productRevision','name','unitPriceCents','quantity','taxRate','costCents','serial','recipe']);
   qty:=public.native_sales_int_v1(ln->'quantity'->'numerator',2147483647);if qty=0 or ln->'quantity'->>'denominator' is distinct from '1' or pg_catalog.jsonb_typeof(ln->'recipe') is distinct from 'array' then raise exception 'NATIVE_QUANTITY_INVALID';end if;
   price:=public.native_sales_int_v1(ln->'unitPriceCents');pid:=(ln->>'productId')::uuid;
   if pid is null then rate:=mode.free_tax;if ln->>'name' is null or pg_catalog.length(ln->>'name') not between 1 and 256 or ln->>'name' ~ '[[:cntrl:]]' or ln->>'productRevision' is not null or ln->>'costCents' is not null or pg_catalog.jsonb_array_length(ln->'recipe')<>0 or ln->>'serial' is not null then raise exception 'NATIVE_FREE_LINE_INVALID';end if;
   else
    select * into product from public.productos where id=pid and negocio_id=n and eliminado=false;
    if not found then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;
    price_base:=product.precio_venta;
    if ln ? 'pricePolicy' then
     if ln->'pricePolicy'->>'source' is distinct from 'CUSTOMER' then raise exception 'NATIVE_CUSTOMER_PRICING_INVALID';end if;cid:=(ln->'pricePolicy'->>'customerId')::uuid;tier:=public.native_sales_int_v1(ln->'pricePolicy'->'tier',3)::integer;
     if tier<1 or cid::text is distinct from coalesce(doc->'customer'->>'id',pay->>'customerId') or not exists(select 1 from public.clientes c where c.negocio_id=n and c.id=cid and c.estado='activo' and coalesce(c.tipo_precio,1)=tier) then raise exception 'NATIVE_CUSTOMER_PRICING_INVALID';end if;
     price_base:=case tier when 2 then coalesce(nullif(product.precio_2,0),product.precio_venta) when 3 then coalesce(nullif(product.precio_3,0),product.precio_venta) else product.precio_venta end;
    end if;
    if ln->>'name' is distinct from product.nombre or ln->>'productRevision' is distinct from '1' or price<>price_base*100 or (ln->>'costCents')::numeric is distinct from product.costo*100 then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;rate:=product.tasa_itbis;
    if product.tipo='combo' then
     if pg_catalog.jsonb_array_length(ln->'recipe')<>(select count(*) from public.composiciones where negocio_id=n and producto_padre_id=pid) or pg_catalog.jsonb_array_length(ln->'recipe')<>(select count(distinct x->>'productId') from pg_catalog.jsonb_array_elements(ln->'recipe') x) then raise exception 'NATIVE_RECIPE_INVALID';end if;
     for part in select value from pg_catalog.jsonb_array_elements(ln->'recipe') loop ingredient:=(part->>'productId')::uuid;num:=public.native_sales_int_v1(part->'perUnit'->'numerator');den:=public.native_sales_int_v1(part->'perUnit'->'denominator');if den=0 then raise exception 'NATIVE_RECIPE_INVALID';end if;part_qty:=qty*num/den;
      if part->>'revision' is distinct from '1' or part_qty<>pg_catalog.trunc(part_qty) or not exists(select 1 from public.composiciones c join public.productos p on p.id=c.insumo_id where c.negocio_id=n and c.producto_padre_id=pid and c.insumo_id=ingredient and c.cantidad=num/den and p.negocio_id=n and p.tipo<>'combo' and not coalesce(p.serializable,false) and not coalesce(p.eliminado,false)) then raise exception 'NATIVE_RECIPE_INVALID';end if;
      expected:=pg_catalog.jsonb_set(expected,array[ingredient::text],pg_catalog.to_jsonb(coalesce((expected->>ingredient::text)::numeric,0)-part_qty));end loop;
    else if pg_catalog.jsonb_array_length(ln->'recipe')<>0 then raise exception 'NATIVE_RECIPE_INVALID';end if;expected:=pg_catalog.jsonb_set(expected,array[pid::text],pg_catalog.to_jsonb(coalesce((expected->>pid::text)::numeric,0)-qty));end if;
    if product.serializable and (qty<>1 or ln->>'serial' is null or not exists(select 1 from pg_catalog.jsonb_array_elements(doc->'serials') x where x->>'productId'=pid::text and x->>'text'=ln->>'serial')) then raise exception 'NATIVE_SERIAL_REQUIRED';end if;
    if not product.serializable and ln->>'serial' is not null then raise exception 'NATIVE_SERIAL_INVALID';end if;
   end if;
   num:=public.native_sales_int_v1(ln->'taxRate'->'numerator');den:=public.native_sales_int_v1(ln->'taxRate'->'denominator');if den=0 or num<>rate*den then raise exception 'NATIVE_TAX_INVALID';end if;sub:=sub+price*qty;tax:=tax+price*qty*rate;
   eid:=public.native_sales_effect_id_v1(op,'line/'||(pg_catalog.jsonb_array_length(effects))::text);effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',eid,'kind','LINE','payload',ln));
  end loop;
  tax:=pg_catalog.floor(tax+0.5);
  if doc->'discount'->>'type'='AMOUNT' then disc:=least(public.native_sales_int_v1(doc->'discount'->'amountCents'),sub+tax);
  elsif doc->'discount'->>'type'='PERCENT' then num:=public.native_sales_int_v1(doc->'discount'->'ratio'->'numerator');den:=public.native_sales_int_v1(doc->'discount'->'ratio'->'denominator');if den=0 or num>100*den then raise exception 'NATIVE_DISCOUNT_INVALID';end if;disc:=pg_catalog.floor((sub+tax)*num/(den*100)+0.5);
  else raise exception 'NATIVE_DISCOUNT_INVALID';end if;total:=sub+tax-disc;
  if public.native_sales_int_v1(doc->'totals'->'subtotalCents')<>sub or public.native_sales_int_v1(doc->'totals'->'itbisCents')<>tax or public.native_sales_int_v1(doc->'totals'->'discountCents')<>disc or public.native_sales_int_v1(doc->'totals'->'totalCents')<>total then raise exception 'NATIVE_TOTALS_INVALID';end if;
  if pg_catalog.jsonb_array_length(doc->'inventory')<>(select count(*) from pg_catalog.jsonb_each(expected)) or pg_catalog.jsonb_array_length(doc->'stockEvidence')<>pg_catalog.jsonb_array_length(doc->'inventory') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
  for eff in select value from pg_catalog.jsonb_array_elements(doc->'inventory') loop
   pid:=(eff->>'productId')::uuid;delta:=(eff->>'delta')::integer;if delta>=0 or eff->>'delta' is distinct from delta::text or delta::numeric is distinct from (expected->>pid::text)::numeric then raise exception 'NATIVE_STOCK_EFFECT_INVALID';end if;expected:=expected-pid::text;
   select value into proof from pg_catalog.jsonb_array_elements(doc->'stockEvidence') where value->>'productId'=pid::text;
   if (select count(*) from pg_catalog.jsonb_array_elements(doc->'stockEvidence') x where x->>'productId'=pid::text)<>1 or pg_catalog.jsonb_typeof(proof->'pending') is distinct from 'array' or pg_catalog.jsonb_array_length(proof->'pending')>1000 or (select count(distinct x->>'effectId') from pg_catalog.jsonb_array_elements(proof->'pending') x)<>pg_catalog.jsonb_array_length(proof->'pending') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
   expected_version:=public.native_sales_int_v1(proof->'remoteSequence')::bigint;
   select revision into version from public.native_sales_stock_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid for update;
   if not found then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
   if k='BRANCH' then select stock_actual into cur from public.inventario_sucursales where sucursal_id=b and producto_id=pid for update;else select stock_actual into cur from public.productos where id=pid and negocio_id=n for update;end if;
   if cur is null then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
   num:=public.native_sales_int_v1(proof->'remoteBaseQty',2147483647);
   for pend in select value from pg_catalog.jsonb_array_elements(proof->'pending') loop
    select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=(pend->>'operationId')::uuid and installation_id=i and scope_kind=k and sucursal_id is not distinct from b;
    if not found or not exists(select 1 from public.native_sales_effects_v1 x where x.negocio_id=n and x.operation_id=old.operation_id and x.effect_id=(pend->>'effectId')::uuid and x.kind='STOCK' and x.payload->>'productId'=pid::text and x.payload->>'delta'=pend->>'delta') then raise exception 'NATIVE_PENDING_COVERAGE_INVALID';end if;
    num:=num+(pend->>'delta')::integer;expected_version:=greatest(expected_version,old.remote_sequence);
   end loop;
   if version<>expected_version or num<>cur or public.native_sales_int_v1(proof->'effectiveQty',2147483647)<>cur or eff->>'expectedRevision' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object('quantity',proof->>'effectiveQty','remoteSequence',proof->>'remoteSequence','pending',proof->'pending'))) then raise exception 'NATIVE_STOCK_VERSION_CONFLICT';end if;
   after:=cur+delta;if after<0 then raise exception 'NATIVE_STOCK_UNAVAILABLE';end if;
   if k='BRANCH' then
    if exists(select 1 from public.inventario_sucursales z left join public.sucursales br on br.id=z.sucursal_id where z.producto_id=pid and br.negocio_id is distinct from n) then raise exception 'NATIVE_STOCK_SOURCE_UNVERIFIABLE';end if;
    select sum(stock_actual) into own_projection from public.inventario_sucursales where producto_id=pid;
    if own_projection is distinct from (select stock_actual::numeric from public.productos where id=pid and negocio_id=n) then raise exception 'AUTHORITY_PROJECTION_DIVERGED';end if;
    update public.inventario_sucursales set stock_actual=after where sucursal_id=b and producto_id=pid;
    update public.productos set stock_actual=(own_projection+delta)::integer where id=pid and negocio_id=n;
   else update public.productos set stock_actual=after where id=pid and negocio_id=n;end if;
   update public.native_sales_stock_v1 set revision=seq where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid;
   eid:=public.native_sales_effect_id_v1(op,'stock/'||pid::text);effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',eid,'kind','STOCK','payload',pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text)));
   stock:=stock||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'after',after::text,'version',seq::text));
  end loop;
  method:=pay->>'method';if method is null then raise exception 'NATIVE_PAYMENT_INVALID';end if;cash:=public.native_sales_int_v1(pay->'cashNetCents');credit:=public.native_sales_int_v1(pay->'creditChargeCents');transfer:=public.native_sales_int_v1(pay->'transferCents');card:=public.native_sales_int_v1(pay->'cardCents');tender:=public.native_sales_int_v1(pay->'tenderCents');change:=public.native_sales_int_v1(pay->'changeCents');turn:=(pay->>'turnId')::uuid;
  if pay->'bankSettlementVerified' is distinct from 'false'::jsonb or v->>'originalTurnId' is distinct from pay->>'turnId' then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  if method<>'FIADO' and pay->>'customerId' is not null or method not in('EFECTIVO','MIXTO') and turn is not null then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  if method in('EFECTIVO','MIXTO') and not exists(select 1 from public.native_sales_turns_v1 where negocio_id=n and turn_id=turn and status='OPEN' and scope_kind=k and sucursal_id is not distinct from b) then raise exception 'NATIVE_TURN_REQUIRED';end if;
  if method='EFECTIVO' and (cash<>total or transfer<>0 or card<>0 or credit<>0 or tender<cash or change<>tender-cash) or method='TARJETA' and (card<>total or cash<>0 or transfer<>0 or credit<>0 or tender<>0 or change<>0) or method='TRANSFERENCIA' and (transfer<>total or cash<>0 or card<>0 or credit<>0 or tender<>0 or change<>0) or method='MIXTO' and (cash+transfer<>total or card<>0 or credit<>0 or tender<cash or change<>tender-cash) or method='FIADO' and (credit<>total or cash<>0 or card<>0 or transfer<>0 or tender<>0 or change<>0) or method not in('EFECTIVO','TARJETA','TRANSFERENCIA','MIXTO','FIADO') or public.native_sales_int_v1(pay->'paidCents')<>cash+card+transfer then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  if method='FIADO' then cid:=(pay->>'customerId')::uuid;select x.balance_cents,c.limite_credito*100 into debt,limit_credit from public.native_sales_credit_v1 x join public.clientes c on c.id=x.cliente_id and c.negocio_id=x.negocio_id where x.negocio_id=n and x.cliente_id=cid and c.estado='activo' for update of x;
   if not found or limit_credit is null or limit_credit>0 and debt+credit>limit_credit then raise exception 'NATIVE_CREDIT_LIMIT';end if;update public.native_sales_credit_v1 set balance_cents=balance_cents+credit,revision=revision+1 where negocio_id=n and cliente_id=cid;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'credit'),'kind','CREDIT','payload',pg_catalog.jsonb_build_object('customerId',cid,'amountCents',credit::text)));
  end if;
  if method in('EFECTIVO','MIXTO') then effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'cash'),'kind','CASH','payload',pg_catalog.jsonb_build_object('turnId',turn,'amountCents',cash::text)));end if;
  effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'payment'),'kind','PAYMENT','payload',pay));
  if pg_catalog.jsonb_array_length(doc->'serials')<>(select count(*) from pg_catalog.jsonb_array_elements(doc->'lines') x where x->>'serial' is not null) then raise exception 'NATIVE_SERIAL_COVERAGE_INVALID';end if;
  for serial in select value from pg_catalog.jsonb_array_elements(doc->'serials') loop sn:=serial->>'text';pid:=(serial->>'productId')::uuid;
   if sn is null or not exists(select 1 from pg_catalog.jsonb_array_elements(doc->'lines') x where x->>'serial'=sn and x->>'productId'=pid::text) or serial->>'expectedRevision' is distinct from '1' then raise exception 'NATIVE_SERIAL_INVALID';end if;
   update public.seriales set estado='vendido',venta_id=op,fecha_venta=(v->>'originAtUtcMs')::bigint,fecha_actualizacion=clock_ms::bigint where negocio_id=n and producto_id=pid and numero_serial=sn and estado='disponible';get diagnostics rows_n=row_count;if rows_n<>1 then raise exception 'NATIVE_SERIAL_CONFLICT';end if;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'serial/'||sn),'kind','SERIAL','payload',serial));end loop;
  if doc->'fiscal'<>'null'::jsonb then
   sn:=doc->'fiscal'->>'ncf';ncftype:=pg_catalog.substr(sn,1,3);if sn!~'^B0[12][0-9]{8}$' then raise exception 'NATIVE_FISCAL_INVALID';end if;ncfnum:=pg_catalog.substr(sn,4)::bigint;
   if doc->'fiscal'->>'reservationId' is distinct from op::text or doc->'fiscal'->>'type' is distinct from ncftype or doc->'fiscal'->>'number' is distinct from ncfnum::text or not exists(select 1 from public.native_fiscal_requests_v2 f where f.negocio_id=n and f.installation_id=i and f.request_id=(doc->'fiscal'->>'blockId')::uuid and f.receipt->>'deviceId'=d::text and f.receipt->>'writerEpoch'=epoch::text and f.receipt->>'status'='ALLOCATED' and f.receipt->>'kind'=ncftype and (f.receipt->>'first')::bigint<=ncfnum and (f.receipt->>'last')::bigint>=ncfnum) or s->>'ncf' is distinct from sn then raise exception 'NATIVE_FISCAL_INVALID';end if;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'fiscal'),'kind','FISCAL','payload',doc->'fiscal'));
  elsif s->>'ncf' is not null then raise exception 'NATIVE_FISCAL_INVALID';end if;
 else raise exception 'NATIVE_KIND_UNSUPPORTED';end if;
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',p_snapshot_hash,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',s->>'ticket','ncf',s->>'ncf','totalCents',case when s is not null then total::text else null end,'effects',effects,'stock',stock);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,v->>'kind',p_intent,p_hash,p_snapshot,p_snapshot_hash,s->>'ticket',s->>'ncf',seq,receipt);
 for eff in select value from pg_catalog.jsonb_array_elements(effects) loop insert into public.native_sales_effects_v1 values(n,op,(eff->>'id')::uuid,eff->>'kind',coalesce(eff->'payload',eff));end loop;
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;
 return receipt;
end $f$;
create or replace function public.native_sales_feed_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_after bigint) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare events jsonb;scanned bigint;watermark bigint;
begin perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 select last_sequence into watermark from public.native_sales_counter_v1 where negocio_id=p_negocio_id;if watermark is null or p_after<0 or p_after>watermark then raise exception 'NATIVE_FEED_CURSOR_INVALID';end if;
 with scanned as materialized(select * from public.native_sales_ledger_v1 where negocio_id=p_negocio_id and remote_sequence>p_after order by remote_sequence limit 200)
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('receipt',receipt,'intent',intent_text,'snapshot',snapshot_text) order by remote_sequence) filter(where scope_kind=p_scope_kind and sucursal_id is not distinct from p_sucursal_id),'[]'::jsonb),coalesce(max(remote_sequence),watermark) into events,scanned from scanned;
 return pg_catalog.jsonb_build_object('namespace','NATIVE1','tenantId',p_negocio_id,'scope',pg_catalog.jsonb_build_object('type',p_scope_kind,'branchId',p_sucursal_id),'coverage','COMPLETE','scannedThrough',scanned::text,'watermark',watermark::text,'events',events);end $f$;
-- Immutable operational captures, NOT an upgrade of catalogue preview.
-- Only synthetic adopted facts; clients cannot activate modes or mint receipts.
create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare m public.native_sales_mode_v1%rowtype;old public.native_sales_snapshots_v1%rowtype;rows jsonb;batch jsonb;pages jsonb:='[]';header jsonb;payload text;idx integer:=0;cnt integer;at_ms bigint;watermark bigint;last_ticket bigint;turn_event jsonb;
begin
 perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if p_snapshot_id is null then raise exception 'NATIVE_SNAPSHOT_ID_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||p_negocio_id::text,0));
 select * into old from public.native_sales_snapshots_v1 x where x.negocio_id=p_negocio_id and x.snapshot_id=p_snapshot_id;
 if found then
  if old.actor_id is distinct from auth.uid() or old.installation_id is distinct from p_installation_id or old.device_id is distinct from p_device_id or old.writer_epoch is distinct from p_writer_epoch or old.scope_kind is distinct from p_scope_kind or old.sucursal_id is distinct from p_sucursal_id then raise exception using errcode='42501',message='NATIVE_SNAPSHOT_CONTEXT_DENIED';end if;
  return old.manifest;
 end if;
 select * into m from public.native_sales_mode_v1 x where x.negocio_id=p_negocio_id and x.scope_kind=p_scope_kind and x.sucursal_id is not distinct from p_sucursal_id;
 if not found then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 -- Legacy direct changes are fenced, and native writers share the tenant lock.
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_venta is null or p.precio_venta<0 or p.precio_venta*100<>pg_catalog.trunc(p.precio_venta*100) or p.precio_venta*100>9007199254740991 or p.costo<0 or p.costo*100<>pg_catalog.trunc(p.costo*100) or p.tasa_itbis is null or p.tasa_itbis not between 0 and 1 or p.tasa_itbis*100<>pg_catalog.trunc(p.tasa_itbis*100))) then raise exception 'NATIVE_PRODUCT_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.composiciones c where c.negocio_id=p_negocio_id and (c.cantidad is null or c.cantidad<=0 or c.cantidad*1000<>pg_catalog.trunc(c.cantidad*1000))) then raise exception 'NATIVE_RECIPE_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_2<0 or p.precio_3<0 or p.precio_2*100<>pg_catalog.trunc(p.precio_2*100) or p.precio_3*100<>pg_catalog.trunc(p.precio_3*100) or p.precio_2*100>9007199254740991 or p.precio_3*100>9007199254740991)) then raise exception 'NATIVE_PRICE_TIER_UNVERIFIABLE';end if;
 if exists(select 1 from public.seriales s where s.negocio_id=p_negocio_id and (s.estado is null or s.estado not in('disponible','vendido','reservado'))) then raise exception 'NATIVE_SERIAL_SOURCE_UNVERIFIABLE';end if;
 select x.last_sequence into watermark from public.native_sales_counter_v1 x where x.negocio_id=p_negocio_id;
 select coalesce(max(pg_catalog.split_part(x.ticket,'-',2)::bigint),0) into last_ticket from public.native_sales_ledger_v1 x where x.negocio_id=p_negocio_id and x.installation_id=p_installation_id and x.writer_epoch=p_writer_epoch and x.ticket is not null;
 select pg_catalog.jsonb_build_object('receipt',l.receipt,'intent',l.intent_text,'snapshot',l.snapshot_text) into turn_event from public.native_sales_turns_v1 t join public.native_sales_ledger_v1 l on l.negocio_id=t.negocio_id and l.operation_id=t.turn_id where t.negocio_id=p_negocio_id and t.scope_kind=p_scope_kind and t.sucursal_id is not distinct from p_sucursal_id and t.status='OPEN';
 select coalesce(pg_catalog.jsonb_agg(v order by kind,id),'[]'::jsonb) into rows from (
  select 'PRODUCT' kind,p.id::text id,pg_catalog.jsonb_build_object('kind','PRODUCT','id',p.id,'name',p.nombre,'code',p.codigo_barras,'revision','1','deleted',coalesce(p.eliminado,false),'priceTiers',pg_catalog.jsonb_build_object('retailCents',(p.precio_venta*100)::bigint::text,'tier2Cents',(p.precio_2*100)::bigint::text,'tier3Cents',(p.precio_3*100)::bigint::text),'metadata',pg_catalog.jsonb_build_object('costCents',(p.costo*100)::bigint::text,'taxRate',pg_catalog.jsonb_build_object('numerator',(p.tasa_itbis*100)::bigint::text,'denominator','100'),'serialRequired',coalesce(p.serializable,false),'recipe',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productId',c.insumo_id,'perUnit',pg_catalog.jsonb_build_object('numerator',(c.cantidad*1000)::bigint::text,'denominator','1000'),'revision','1') order by c.insumo_id) from public.composiciones c where c.negocio_id=p_negocio_id and c.producto_padre_id=p.id),'[]'::jsonb)),'stock',pg_catalog.jsonb_build_object('quantity',case when p_scope_kind='GLOBAL' then p.stock_actual::text else inv.stock_actual::text end,'version',st.revision::text,'authority',case when st.revision is null or (p_scope_kind='BRANCH' and inv.stock_actual is null) then 'UNKNOWN' when p_scope_kind='BRANCH' and p.stock_actual is distinct from (select sum(z.stock_actual) from public.inventario_sucursales z where z.producto_id=p.id) then 'DIVERGED' else 'VERIFIED' end)) v from public.productos p left join public.inventario_sucursales inv on inv.producto_id=p.id and inv.sucursal_id=p_sucursal_id left join public.native_sales_stock_v1 st on st.negocio_id=p_negocio_id and st.producto_id=p.id and st.scope_kind=p_scope_kind and st.sucursal_id is not distinct from p_sucursal_id where p.negocio_id=p_negocio_id
  union all select 'CUSTOMER',c.id::text,pg_catalog.jsonb_build_object('kind','CUSTOMER','id',c.id,'name',c.nombre,'balanceCents',x.balance_cents::text,'limitCents',(c.limite_credito*100)::bigint::text,'active',c.estado='activo','revision',x.revision::text,'priceTier',coalesce(c.tipo_precio,1)::text) from public.clientes c join public.native_sales_credit_v1 x on x.negocio_id=c.negocio_id and x.cliente_id=c.id where c.negocio_id=p_negocio_id
  union all select 'SERIAL',s.id::text,pg_catalog.jsonb_build_object('kind','SERIAL','productId',s.producto_id,'text',s.numero_serial,'revision','1','state',case s.estado when 'disponible' then 'AVAILABLE' when 'reservado' then 'RESERVED' else 'SOLD' end) from public.seriales s where s.negocio_id=p_negocio_id
 ) q;
 cnt:=pg_catalog.jsonb_array_length(rows);if cnt>60000 then raise exception 'NATIVE_BOOTSTRAP_SIZE';end if;
 at_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint;
 header:=pg_catalog.jsonb_build_object('version','ventard.native.operational.1','namespace','NATIVE1','snapshotId',p_snapshot_id,'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'deviceId',p_device_id,'installationId',p_installation_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),'capturedAtMs',at_ms::text,'expiresAtMs',(at_ms+86400000)::text,'coverage','CLOUD_ADOPTED_V1','watermark',watermark::text,'totalCount',cnt,'ticketPrefix','N'||pg_catalog.replace(p_installation_id::text,'-',''),'lastTicket',last_ticket::text,'freeTax',pg_catalog.jsonb_build_object('numerator',(m.free_tax*100)::bigint::text,'denominator','100'),'turn',turn_event,'pages','[]'::jsonb);
 insert into public.native_sales_snapshots_v1 values(p_negocio_id,p_snapshot_id,auth.uid(),p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,header,at_ms+86400000);
 for batch in select pg_catalog.jsonb_agg(value order by ordinality) from pg_catalog.jsonb_array_elements(rows) with ordinality group by ((ordinality-1)/200) order by ((ordinality-1)/200) loop
  payload:=public.native_sales_canonical_v1(batch);if pg_catalog.octet_length(payload)>1048576 then raise exception 'NATIVE_BOOTSTRAP_PAGE_SIZE';end if;
  pages:=pages||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',idx,'count',pg_catalog.jsonb_array_length(batch),'byteLength',pg_catalog.octet_length(payload),'sha256',public.native_sales_hash_v1(payload)));
  insert into public.native_sales_pages_v1 values(p_negocio_id,p_snapshot_id,idx,payload);idx:=idx+1;
 end loop;
 header:=pg_catalog.jsonb_set(header,'{pages}',pages);update public.native_sales_snapshots_v1 set manifest=header where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;return header;
end $f$;
create or replace function public.native_sales_bootstrap_page_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid,p_page_index integer) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare s public.native_sales_snapshots_v1%rowtype;body text;
begin
 perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 select * into s from public.native_sales_snapshots_v1 x where x.negocio_id=p_negocio_id and x.snapshot_id=p_snapshot_id;
 if not found or s.actor_id is distinct from auth.uid() or s.installation_id is distinct from p_installation_id or s.device_id is distinct from p_device_id or s.writer_epoch is distinct from p_writer_epoch or s.scope_kind is distinct from p_scope_kind or s.sucursal_id is distinct from p_sucursal_id or s.expires_at_ms<=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000) then raise exception using errcode='42501',message='NATIVE_SNAPSHOT_CONTEXT_DENIED';end if;
 select p.payload into body from public.native_sales_pages_v1 p where p.negocio_id=p_negocio_id and p.snapshot_id=p_snapshot_id and p.page_index=p_page_index;if body is null then raise exception 'NATIVE_PAGE_INVALID';end if;
 return pg_catalog.jsonb_build_object('snapshotId',p_snapshot_id,'index',p_page_index,'payload',body);
end $f$;
-- Reuse ONLY the secure v2 fiscal allocator, under the active writer fence.
-- No business v1 RPC or fake receipt; the allocated range contract is unchanged.
create or replace function public.native_sales_fiscal_allocate_v1(p_request jsonb,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare n uuid;receipt jsonb;
begin
 n:=(p_request->>'tenantId')::uuid;
 perform public.native_sales_context_v1(n,(p_request->>'installationId')::uuid,(p_request->>'deviceId')::uuid,(p_request->>'writerEpoch')::bigint,p_request->>'scopeType',(p_request->>'branchId')::uuid);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 receipt:=public.native_fiscal_allocate_v2(p_request,p_hash);
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;
 return receipt;
end $f$;
-- Function ACL defaults are not trusted. Only fixed authenticated entrypoints.
do $acl$ declare x record;begin for x in select p.oid::regprocedure as signature from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'native_sales_%' loop execute 'revoke all on function '||x.signature||' from public,anon,authenticated';end loop;end $acl$;
grant execute on function public.native_sales_activate_v1(uuid,uuid,uuid,bigint,text,uuid,text,text),public.native_sales_submit_v1(text,text,text,text),public.native_sales_lookup_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,text),public.native_sales_feed_v1(uuid,uuid,uuid,bigint,text,uuid,bigint) to authenticated;
grant execute on function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid),public.native_sales_bootstrap_page_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,integer) to authenticated;
grant execute on function public.native_sales_fiscal_allocate_v1(jsonb,text) to authenticated;

-- Source: 20261011135055_native_sales_real_schema_compat_v1.sql SHA256 5586dfd593a917c95ef546546461798433a36cb28aa9b70eb39bbfee6c50736a
-- No source data/schema rewrite, permissions expansion, snapshot rewrite or repair.

do $guard$ begin

end $guard$;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;s jsonb;doc jsonb;pay jsonb;n uuid;op uuid;i uuid;d uuid;b uuid;k text;epoch bigint;role text;old public.native_sales_ledger_v1%rowtype;
 mode public.native_sales_mode_v1%rowtype;ln jsonb;eff jsonb;proof jsonb;pend jsonb;product public.productos%rowtype;pid uuid;qty numeric;price numeric;rate numeric;sub numeric:=0;tax numeric:=0;disc numeric;total numeric;cash numeric;credit numeric;transfer numeric;card numeric;tender numeric;change numeric;debt numeric;limit_credit numeric;cid uuid;turn uuid;seq bigint;cur integer;after integer;version bigint;expected_version bigint;delta integer;stock jsonb:='[]';effects jsonb:='[]';eid uuid;clock_ms text;receipt jsonb;expected jsonb:='{}';part jsonb;ingredient uuid;part_qty numeric;num numeric;den numeric;method text;serial jsonb;rows_n integer;sn text;ncftype text;ncfnum bigint;own_projection numeric;price_base numeric;tier integer;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 or (p_snapshot is not null and pg_catalog.octet_length(p_snapshot)>1048576) then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;if public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent)<>p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 perform public.native_sales_int_v1(v->'originAtUtcMs');
 if p_hash is null or p_hash!~'^[0-9a-f]{64}$' or pg_catalog.jsonb_typeof(v->'dependencies') is distinct from 'array' or pg_catalog.jsonb_array_length(v->'dependencies')>100 then raise exception 'NATIVE_INTENT_INVALID';end if;
 n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;
 role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or (v->>'actorId')::uuid is distinct from auth.uid() or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role) then raise exception using errcode='42501',message='NATIVE_INTENT_CONTEXT_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is distinct from p_snapshot_hash or old.snapshot_text is distinct from p_snapshot then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 select * into mode from public.native_sales_mode_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b;
 if not found then raise exception using errcode='42501',message='NATIVE_ACTIVATION_REQUIRED';end if;
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;
 clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 if v->>'kind'='TURN_OPEN' then
  if p_snapshot is not null or p_snapshot_hash is not null or exists(select 1 from public.native_sales_turns_v1 where negocio_id=n and status='OPEN' and scope_kind=k and sucursal_id is not distinct from b) then raise exception 'NATIVE_TURN_CONFLICT';end if;
  cash:=public.native_sales_int_v1(v->'payload'->'openingCents');
  insert into public.native_sales_turns_v1 values(n,op,k,b,i,d,auth.uid(),cash::bigint,v->>'originAtUtcMs','OPEN',seq);
  effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',op,'kind','TURN_OPEN','amountCents',cash::text));
 elsif v->>'kind'='SALE_CONFIRM' then
  if p_snapshot is null or p_snapshot_hash is null then raise exception 'NATIVE_SNAPSHOT_REQUIRED';end if;
  s:=p_snapshot::jsonb;if public.native_sales_canonical_v1(s)<>p_snapshot or public.native_sales_hash_v1(p_snapshot)<>p_snapshot_hash then raise exception 'NATIVE_SNAPSHOT_HASH_INVALID';end if;
  doc:=v->'payload'->'sale';pay:=doc->'payment';
  perform public.native_sales_object_v1(s,array['version','operationId','tenantId','actorId','originAtUtcMs','scope','ticket','ncf','customerName','sale']);
  perform public.native_sales_object_v1(doc,array['currency','calculationVersion','lines','discount','totals','payment','inventory','serials','stockEvidence','fiscal']);
  if v->'payload'->>'quoteHash' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_set(doc,'{fiscal}','null'::jsonb))) then raise exception 'NATIVE_QUOTE_HASH_INVALID';end if;
  perform public.native_sales_object_v1(pay,array['method','customerId','paidCents','creditChargeCents','cashNetCents','cardCents','transferCents','tenderCents','changeCents','turnId','bankSettlementVerified']);
  if pg_catalog.jsonb_typeof(doc->'lines') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'inventory') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'serials') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'stockEvidence') is distinct from 'array' then raise exception 'NATIVE_SALE_ARRAY_INVALID';end if;
  if s->'sale' is distinct from doc or s->>'version' is distinct from 'ventard.ticket.snapshot.1' or s->>'operationId' is distinct from op::text or s->>'tenantId' is distinct from n::text or s->>'actorId' is distinct from auth.uid()::text or s->>'originAtUtcMs' is distinct from v->>'originAtUtcMs' or s->'scope' is distinct from pg_catalog.jsonb_build_object('type',k,'branchId',b) or s->>'ticket' is null or s->>'ticket'!~('^N'||pg_catalog.replace(i::text,'-','')||'-[0-9]{6,}$') or doc->>'currency' is distinct from 'DOP' or doc->>'calculationVersion' is distinct from 'ventard.sale.calculation.1' or pg_catalog.jsonb_array_length(doc->'lines') not between 1 and 100 then raise exception 'NATIVE_SALE_INVALID';end if;
  if doc ? 'customer' then
   perform public.native_sales_object_v1(doc->'customer',array['id','name','revision']);
   if s->>'customerName' is distinct from doc->'customer'->>'name' or pg_catalog.length(s->>'customerName') not between 1 and 256 or s->>'customerName' ~ '[[:cntrl:]]' then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   cid:=(doc->'customer'->>'id')::uuid;
   if cid is not null and not exists(select 1 from public.clientes c where c.id=cid and c.negocio_id=n and not coalesce(c.eliminado,false) and c.nombre=doc->'customer'->>'name' and doc->'customer'->>'revision'='1') then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   if pay->>'method'='FIADO' and (cid is null or cid::text is distinct from pay->>'customerId') then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  elsif s->>'customerName' is not null and pay->>'method'<>'FIADO' then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  for ln in select value from pg_catalog.jsonb_array_elements(doc->'lines') loop
   perform public.native_sales_object_v1(ln,array['productId','productRevision','name','unitPriceCents','quantity','taxRate','costCents','serial','recipe']);
   qty:=public.native_sales_int_v1(ln->'quantity'->'numerator',2147483647);if qty=0 or ln->'quantity'->>'denominator' is distinct from '1' or pg_catalog.jsonb_typeof(ln->'recipe') is distinct from 'array' then raise exception 'NATIVE_QUANTITY_INVALID';end if;
   price:=public.native_sales_int_v1(ln->'unitPriceCents');pid:=(ln->>'productId')::uuid;
   if pid is null then rate:=mode.free_tax;if ln->>'name' is null or pg_catalog.length(ln->>'name') not between 1 and 256 or ln->>'name' ~ '[[:cntrl:]]' or ln->>'productRevision' is not null or ln->>'costCents' is not null or pg_catalog.jsonb_array_length(ln->'recipe')<>0 or ln->>'serial' is not null then raise exception 'NATIVE_FREE_LINE_INVALID';end if;
   else
    select * into product from public.productos where id=pid and negocio_id=n and eliminado=false;
    if not found then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;
    price_base:=product.precio_venta;
    if ln ? 'pricePolicy' then
     if ln->'pricePolicy'->>'source' is distinct from 'CUSTOMER' then raise exception 'NATIVE_CUSTOMER_PRICING_INVALID';end if;cid:=(ln->'pricePolicy'->>'customerId')::uuid;tier:=public.native_sales_int_v1(ln->'pricePolicy'->'tier',3)::integer;
     if tier<1 or cid::text is distinct from coalesce(doc->'customer'->>'id',pay->>'customerId') or not exists(select 1 from public.clientes c where c.negocio_id=n and c.id=cid and not coalesce(c.eliminado,false) and coalesce(c.tipo_precio,1)=tier) then raise exception 'NATIVE_CUSTOMER_PRICING_INVALID';end if;
     price_base:=case tier when 2 then coalesce(nullif(product.precio_2,0),product.precio_venta) when 3 then coalesce(nullif(product.precio_3,0),product.precio_venta) else product.precio_venta end;
    end if;
    if ln->>'name' is distinct from product.nombre or ln->>'productRevision' is distinct from '1' or price<>price_base*100 or (ln->>'costCents')::numeric is distinct from product.costo*100 then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;rate:=product.tasa_itbis;
    if product.tipo='combo' then
     if pg_catalog.jsonb_array_length(ln->'recipe')<>(select count(*) from public.composiciones where negocio_id=n and producto_padre_id=pid) or pg_catalog.jsonb_array_length(ln->'recipe')<>(select count(distinct x->>'productId') from pg_catalog.jsonb_array_elements(ln->'recipe') x) then raise exception 'NATIVE_RECIPE_INVALID';end if;
     for part in select value from pg_catalog.jsonb_array_elements(ln->'recipe') loop ingredient:=(part->>'productId')::uuid;num:=public.native_sales_int_v1(part->'perUnit'->'numerator');den:=public.native_sales_int_v1(part->'perUnit'->'denominator');if den=0 then raise exception 'NATIVE_RECIPE_INVALID';end if;part_qty:=qty*num/den;
      if part->>'revision' is distinct from '1' or part_qty<>pg_catalog.trunc(part_qty) or not exists(select 1 from public.composiciones c join public.productos p on p.id=c.insumo_id where c.negocio_id=n and c.producto_padre_id=pid and c.insumo_id=ingredient and c.cantidad_necesaria=num/den and p.negocio_id=n and p.tipo<>'combo' and not coalesce(p.serializable,false) and not coalesce(p.eliminado,false)) then raise exception 'NATIVE_RECIPE_INVALID';end if;
      expected:=pg_catalog.jsonb_set(expected,array[ingredient::text],pg_catalog.to_jsonb(coalesce((expected->>ingredient::text)::numeric,0)-part_qty));end loop;
    else if pg_catalog.jsonb_array_length(ln->'recipe')<>0 then raise exception 'NATIVE_RECIPE_INVALID';end if;expected:=pg_catalog.jsonb_set(expected,array[pid::text],pg_catalog.to_jsonb(coalesce((expected->>pid::text)::numeric,0)-qty));end if;
    if product.serializable and (qty<>1 or ln->>'serial' is null or not exists(select 1 from pg_catalog.jsonb_array_elements(doc->'serials') x where x->>'productId'=pid::text and x->>'text'=ln->>'serial')) then raise exception 'NATIVE_SERIAL_REQUIRED';end if;
    if not product.serializable and ln->>'serial' is not null then raise exception 'NATIVE_SERIAL_INVALID';end if;
   end if;
   num:=public.native_sales_int_v1(ln->'taxRate'->'numerator');den:=public.native_sales_int_v1(ln->'taxRate'->'denominator');if den=0 or num<>rate*den then raise exception 'NATIVE_TAX_INVALID';end if;sub:=sub+price*qty;tax:=tax+price*qty*rate;
   eid:=public.native_sales_effect_id_v1(op,'line/'||(pg_catalog.jsonb_array_length(effects))::text);effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',eid,'kind','LINE','payload',ln));
  end loop;
  tax:=pg_catalog.floor(tax+0.5);
  if doc->'discount'->>'type'='AMOUNT' then disc:=least(public.native_sales_int_v1(doc->'discount'->'amountCents'),sub+tax);
  elsif doc->'discount'->>'type'='PERCENT' then num:=public.native_sales_int_v1(doc->'discount'->'ratio'->'numerator');den:=public.native_sales_int_v1(doc->'discount'->'ratio'->'denominator');if den=0 or num>100*den then raise exception 'NATIVE_DISCOUNT_INVALID';end if;disc:=pg_catalog.floor((sub+tax)*num/(den*100)+0.5);
  else raise exception 'NATIVE_DISCOUNT_INVALID';end if;total:=sub+tax-disc;
  if public.native_sales_int_v1(doc->'totals'->'subtotalCents')<>sub or public.native_sales_int_v1(doc->'totals'->'itbisCents')<>tax or public.native_sales_int_v1(doc->'totals'->'discountCents')<>disc or public.native_sales_int_v1(doc->'totals'->'totalCents')<>total then raise exception 'NATIVE_TOTALS_INVALID';end if;
  if pg_catalog.jsonb_array_length(doc->'inventory')<>(select count(*) from pg_catalog.jsonb_each(expected)) or pg_catalog.jsonb_array_length(doc->'stockEvidence')<>pg_catalog.jsonb_array_length(doc->'inventory') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
  for eff in select value from pg_catalog.jsonb_array_elements(doc->'inventory') loop
   pid:=(eff->>'productId')::uuid;delta:=(eff->>'delta')::integer;if delta>=0 or eff->>'delta' is distinct from delta::text or delta::numeric is distinct from (expected->>pid::text)::numeric then raise exception 'NATIVE_STOCK_EFFECT_INVALID';end if;expected:=expected-pid::text;
   select value into proof from pg_catalog.jsonb_array_elements(doc->'stockEvidence') where value->>'productId'=pid::text;
   if (select count(*) from pg_catalog.jsonb_array_elements(doc->'stockEvidence') x where x->>'productId'=pid::text)<>1 or pg_catalog.jsonb_typeof(proof->'pending') is distinct from 'array' or pg_catalog.jsonb_array_length(proof->'pending')>1000 or (select count(distinct x->>'effectId') from pg_catalog.jsonb_array_elements(proof->'pending') x)<>pg_catalog.jsonb_array_length(proof->'pending') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
   expected_version:=public.native_sales_int_v1(proof->'remoteSequence')::bigint;
   select revision into version from public.native_sales_stock_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid for update;
   if not found then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
   if k='BRANCH' then select stock_actual into cur from public.inventario_sucursales where sucursal_id=b and producto_id=pid for update;else select stock_actual into cur from public.productos where id=pid and negocio_id=n for update;end if;
   if cur is null then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
   num:=public.native_sales_int_v1(proof->'remoteBaseQty',2147483647);
   for pend in select value from pg_catalog.jsonb_array_elements(proof->'pending') loop
    select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=(pend->>'operationId')::uuid and installation_id=i and scope_kind=k and sucursal_id is not distinct from b;
    if not found or not exists(select 1 from public.native_sales_effects_v1 x where x.negocio_id=n and x.operation_id=old.operation_id and x.effect_id=(pend->>'effectId')::uuid and x.kind='STOCK' and x.payload->>'productId'=pid::text and x.payload->>'delta'=pend->>'delta') then raise exception 'NATIVE_PENDING_COVERAGE_INVALID';end if;
    num:=num+(pend->>'delta')::integer;expected_version:=greatest(expected_version,old.remote_sequence);
   end loop;
   if version<>expected_version or num<>cur or public.native_sales_int_v1(proof->'effectiveQty',2147483647)<>cur or eff->>'expectedRevision' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object('quantity',proof->>'effectiveQty','remoteSequence',proof->>'remoteSequence','pending',proof->'pending'))) then raise exception 'NATIVE_STOCK_VERSION_CONFLICT';end if;
   after:=cur+delta;if after<0 then raise exception 'NATIVE_STOCK_UNAVAILABLE';end if;
   if k='BRANCH' then
    if exists(select 1 from public.inventario_sucursales z left join public.sucursales br on br.id=z.sucursal_id where z.producto_id=pid and br.negocio_id is distinct from n) then raise exception 'NATIVE_STOCK_SOURCE_UNVERIFIABLE';end if;
    select sum(stock_actual) into own_projection from public.inventario_sucursales where producto_id=pid;
    if own_projection is distinct from (select stock_actual::numeric from public.productos where id=pid and negocio_id=n) then raise exception 'AUTHORITY_PROJECTION_DIVERGED';end if;
    update public.inventario_sucursales set stock_actual=after where sucursal_id=b and producto_id=pid;
    update public.productos set stock_actual=(own_projection+delta)::integer where id=pid and negocio_id=n;
   else update public.productos set stock_actual=after where id=pid and negocio_id=n;end if;
   update public.native_sales_stock_v1 set revision=seq where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid;
   eid:=public.native_sales_effect_id_v1(op,'stock/'||pid::text);effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',eid,'kind','STOCK','payload',pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text)));
   stock:=stock||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'after',after::text,'version',seq::text));
  end loop;
  method:=pay->>'method';if method is null then raise exception 'NATIVE_PAYMENT_INVALID';end if;cash:=public.native_sales_int_v1(pay->'cashNetCents');credit:=public.native_sales_int_v1(pay->'creditChargeCents');transfer:=public.native_sales_int_v1(pay->'transferCents');card:=public.native_sales_int_v1(pay->'cardCents');tender:=public.native_sales_int_v1(pay->'tenderCents');change:=public.native_sales_int_v1(pay->'changeCents');turn:=(pay->>'turnId')::uuid;
  if pay->'bankSettlementVerified' is distinct from 'false'::jsonb or v->>'originalTurnId' is distinct from pay->>'turnId' then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  if method<>'FIADO' and pay->>'customerId' is not null or method not in('EFECTIVO','MIXTO') and turn is not null then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  if method in('EFECTIVO','MIXTO') and not exists(select 1 from public.native_sales_turns_v1 where negocio_id=n and turn_id=turn and status='OPEN' and scope_kind=k and sucursal_id is not distinct from b) then raise exception 'NATIVE_TURN_REQUIRED';end if;
  if method='EFECTIVO' and (cash<>total or transfer<>0 or card<>0 or credit<>0 or tender<cash or change<>tender-cash) or method='TARJETA' and (card<>total or cash<>0 or transfer<>0 or credit<>0 or tender<>0 or change<>0) or method='TRANSFERENCIA' and (transfer<>total or cash<>0 or card<>0 or credit<>0 or tender<>0 or change<>0) or method='MIXTO' and (cash+transfer<>total or card<>0 or credit<>0 or tender<cash or change<>tender-cash) or method='FIADO' and (credit<>total or cash<>0 or card<>0 or transfer<>0 or tender<>0 or change<>0) or method not in('EFECTIVO','TARJETA','TRANSFERENCIA','MIXTO','FIADO') or public.native_sales_int_v1(pay->'paidCents')<>cash+card+transfer then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  if method='FIADO' then cid:=(pay->>'customerId')::uuid;select x.balance_cents,c.limite_credito*100 into debt,limit_credit from public.native_sales_credit_v1 x join public.clientes c on c.id=x.cliente_id and c.negocio_id=x.negocio_id where x.negocio_id=n and x.cliente_id=cid and not coalesce(c.eliminado,false) for update of x;
   if not found or limit_credit is null or limit_credit>0 and debt+credit>limit_credit then raise exception 'NATIVE_CREDIT_LIMIT';end if;update public.native_sales_credit_v1 set balance_cents=balance_cents+credit,revision=revision+1 where negocio_id=n and cliente_id=cid;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'credit'),'kind','CREDIT','payload',pg_catalog.jsonb_build_object('customerId',cid,'amountCents',credit::text)));
  end if;
  if method in('EFECTIVO','MIXTO') then effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'cash'),'kind','CASH','payload',pg_catalog.jsonb_build_object('turnId',turn,'amountCents',cash::text)));end if;
  effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'payment'),'kind','PAYMENT','payload',pay));
  if pg_catalog.jsonb_array_length(doc->'serials')<>(select count(*) from pg_catalog.jsonb_array_elements(doc->'lines') x where x->>'serial' is not null) then raise exception 'NATIVE_SERIAL_COVERAGE_INVALID';end if;
  for serial in select value from pg_catalog.jsonb_array_elements(doc->'serials') loop sn:=serial->>'text';pid:=(serial->>'productId')::uuid;
   if sn is null or not exists(select 1 from pg_catalog.jsonb_array_elements(doc->'lines') x where x->>'serial'=sn and x->>'productId'=pid::text) or serial->>'expectedRevision' is distinct from '1' then raise exception 'NATIVE_SERIAL_INVALID';end if;
   update public.seriales set estado='vendido',venta_id=op,fecha_venta=(v->>'originAtUtcMs')::bigint,fecha_actualizacion=clock_ms::bigint where negocio_id=n and producto_id=pid and numero_serial=sn and estado='disponible';get diagnostics rows_n=row_count;if rows_n<>1 then raise exception 'NATIVE_SERIAL_CONFLICT';end if;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'serial/'||sn),'kind','SERIAL','payload',serial));end loop;
  if doc->'fiscal'<>'null'::jsonb then
   sn:=doc->'fiscal'->>'ncf';ncftype:=pg_catalog.substr(sn,1,3);if sn!~'^B0[12][0-9]{8}$' then raise exception 'NATIVE_FISCAL_INVALID';end if;ncfnum:=pg_catalog.substr(sn,4)::bigint;
   if doc->'fiscal'->>'reservationId' is distinct from op::text or doc->'fiscal'->>'type' is distinct from ncftype or doc->'fiscal'->>'number' is distinct from ncfnum::text or not exists(select 1 from public.native_fiscal_requests_v2 f where f.negocio_id=n and f.installation_id=i and f.request_id=(doc->'fiscal'->>'blockId')::uuid and f.receipt->>'deviceId'=d::text and f.receipt->>'writerEpoch'=epoch::text and f.receipt->>'status'='ALLOCATED' and f.receipt->>'kind'=ncftype and (f.receipt->>'first')::bigint<=ncfnum and (f.receipt->>'last')::bigint>=ncfnum) or s->>'ncf' is distinct from sn then raise exception 'NATIVE_FISCAL_INVALID';end if;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'fiscal'),'kind','FISCAL','payload',doc->'fiscal'));
  elsif s->>'ncf' is not null then raise exception 'NATIVE_FISCAL_INVALID';end if;
 else raise exception 'NATIVE_KIND_UNSUPPORTED';end if;
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',p_snapshot_hash,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',s->>'ticket','ncf',s->>'ncf','totalCents',case when s is not null then total::text else null end,'effects',effects,'stock',stock);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,v->>'kind',p_intent,p_hash,p_snapshot,p_snapshot_hash,s->>'ticket',s->>'ncf',seq,receipt);
 for eff in select value from pg_catalog.jsonb_array_elements(effects) loop insert into public.native_sales_effects_v1 values(n,op,(eff->>'id')::uuid,eff->>'kind',coalesce(eff->'payload',eff));end loop;
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;
 return receipt;
end $f$;

create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare m public.native_sales_mode_v1%rowtype;old public.native_sales_snapshots_v1%rowtype;rows jsonb;batch jsonb;pages jsonb:='[]';header jsonb;payload text;idx integer:=0;cnt integer;at_ms bigint;watermark bigint;last_ticket bigint;turn_event jsonb;
begin
 perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if p_snapshot_id is null then raise exception 'NATIVE_SNAPSHOT_ID_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||p_negocio_id::text,0));
 select * into old from public.native_sales_snapshots_v1 x where x.negocio_id=p_negocio_id and x.snapshot_id=p_snapshot_id;
 if found then
  if old.actor_id is distinct from auth.uid() or old.installation_id is distinct from p_installation_id or old.device_id is distinct from p_device_id or old.writer_epoch is distinct from p_writer_epoch or old.scope_kind is distinct from p_scope_kind or old.sucursal_id is distinct from p_sucursal_id then raise exception using errcode='42501',message='NATIVE_SNAPSHOT_CONTEXT_DENIED';end if;
  return old.manifest;
 end if;
 select * into m from public.native_sales_mode_v1 x where x.negocio_id=p_negocio_id and x.scope_kind=p_scope_kind and x.sucursal_id is not distinct from p_sucursal_id;
 if not found then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 -- Legacy direct changes are fenced, and native writers share the tenant lock.
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_venta is null or p.precio_venta<0 or p.precio_venta*100<>pg_catalog.trunc(p.precio_venta*100) or p.precio_venta*100>9007199254740991 or p.costo<0 or p.costo*100<>pg_catalog.trunc(p.costo*100) or p.tasa_itbis is null or p.tasa_itbis not between 0 and 1 or p.tasa_itbis*100<>pg_catalog.trunc(p.tasa_itbis*100))) then raise exception 'NATIVE_PRODUCT_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.composiciones c where c.negocio_id=p_negocio_id and (c.cantidad_necesaria is null or c.cantidad_necesaria<=0 or c.cantidad_necesaria*1000<>pg_catalog.trunc(c.cantidad_necesaria*1000))) then raise exception 'NATIVE_RECIPE_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_2<0 or p.precio_3<0 or p.precio_2*100<>pg_catalog.trunc(p.precio_2*100) or p.precio_3*100<>pg_catalog.trunc(p.precio_3*100) or p.precio_2*100>9007199254740991 or p.precio_3*100>9007199254740991)) then raise exception 'NATIVE_PRICE_TIER_UNVERIFIABLE';end if;
 if exists(select 1 from public.seriales s where s.negocio_id=p_negocio_id and (s.estado is null or s.estado not in('disponible','vendido','reservado'))) then raise exception 'NATIVE_SERIAL_SOURCE_UNVERIFIABLE';end if;
 select x.last_sequence into watermark from public.native_sales_counter_v1 x where x.negocio_id=p_negocio_id;
 select coalesce(max(pg_catalog.split_part(x.ticket,'-',2)::bigint),0) into last_ticket from public.native_sales_ledger_v1 x where x.negocio_id=p_negocio_id and x.installation_id=p_installation_id and x.writer_epoch=p_writer_epoch and x.ticket is not null;
 select pg_catalog.jsonb_build_object('receipt',l.receipt,'intent',l.intent_text,'snapshot',l.snapshot_text) into turn_event from public.native_sales_turns_v1 t join public.native_sales_ledger_v1 l on l.negocio_id=t.negocio_id and l.operation_id=t.turn_id where t.negocio_id=p_negocio_id and t.scope_kind=p_scope_kind and t.sucursal_id is not distinct from p_sucursal_id and t.status='OPEN';
 select coalesce(pg_catalog.jsonb_agg(v order by kind,id),'[]'::jsonb) into rows from (
  select 'PRODUCT' kind,p.id::text id,pg_catalog.jsonb_build_object('kind','PRODUCT','id',p.id,'name',p.nombre,'code',p.codigo_barras,'revision','1','deleted',coalesce(p.eliminado,false),'priceTiers',pg_catalog.jsonb_build_object('retailCents',(p.precio_venta*100)::bigint::text,'tier2Cents',(p.precio_2*100)::bigint::text,'tier3Cents',(p.precio_3*100)::bigint::text),'metadata',pg_catalog.jsonb_build_object('costCents',(p.costo*100)::bigint::text,'taxRate',pg_catalog.jsonb_build_object('numerator',(p.tasa_itbis*100)::bigint::text,'denominator','100'),'serialRequired',coalesce(p.serializable,false),'recipe',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productId',c.insumo_id,'perUnit',pg_catalog.jsonb_build_object('numerator',(c.cantidad_necesaria*1000)::bigint::text,'denominator','1000'),'revision','1') order by c.insumo_id) from public.composiciones c where c.negocio_id=p_negocio_id and c.producto_padre_id=p.id),'[]'::jsonb)),'stock',pg_catalog.jsonb_build_object('quantity',case when p_scope_kind='GLOBAL' then p.stock_actual::text else inv.stock_actual::text end,'version',st.revision::text,'authority',case when st.revision is null or (p_scope_kind='BRANCH' and inv.stock_actual is null) then 'UNKNOWN' when p_scope_kind='BRANCH' and p.stock_actual is distinct from (select sum(z.stock_actual) from public.inventario_sucursales z where z.producto_id=p.id) then 'DIVERGED' else 'VERIFIED' end)) v from public.productos p left join public.inventario_sucursales inv on inv.producto_id=p.id and inv.sucursal_id=p_sucursal_id left join public.native_sales_stock_v1 st on st.negocio_id=p_negocio_id and st.producto_id=p.id and st.scope_kind=p_scope_kind and st.sucursal_id is not distinct from p_sucursal_id where p.negocio_id=p_negocio_id
  union all select 'CUSTOMER',c.id::text,pg_catalog.jsonb_build_object('kind','CUSTOMER','id',c.id,'name',c.nombre,'balanceCents',x.balance_cents::text,'limitCents',(c.limite_credito*100)::bigint::text,'active',not coalesce(c.eliminado,false),'revision',x.revision::text,'priceTier',coalesce(c.tipo_precio,1)::text) from public.clientes c join public.native_sales_credit_v1 x on x.negocio_id=c.negocio_id and x.cliente_id=c.id where c.negocio_id=p_negocio_id
  union all select 'SERIAL',s.id::text,pg_catalog.jsonb_build_object('kind','SERIAL','productId',s.producto_id,'text',s.numero_serial,'revision','1','state',case s.estado when 'disponible' then 'AVAILABLE' when 'reservado' then 'RESERVED' else 'SOLD' end) from public.seriales s where s.negocio_id=p_negocio_id
 ) q;
 cnt:=pg_catalog.jsonb_array_length(rows);if cnt>60000 then raise exception 'NATIVE_BOOTSTRAP_SIZE';end if;
 at_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint;
 header:=pg_catalog.jsonb_build_object('version','ventard.native.operational.1','namespace','NATIVE1','snapshotId',p_snapshot_id,'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'deviceId',p_device_id,'installationId',p_installation_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),'capturedAtMs',at_ms::text,'expiresAtMs',(at_ms+86400000)::text,'coverage','CLOUD_ADOPTED_V1','watermark',watermark::text,'totalCount',cnt,'ticketPrefix','N'||pg_catalog.replace(p_installation_id::text,'-',''),'lastTicket',last_ticket::text,'freeTax',pg_catalog.jsonb_build_object('numerator',(m.free_tax*100)::bigint::text,'denominator','100'),'turn',turn_event,'pages','[]'::jsonb);
 insert into public.native_sales_snapshots_v1 values(p_negocio_id,p_snapshot_id,auth.uid(),p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,header,at_ms+86400000);
 for batch in select pg_catalog.jsonb_agg(value order by ordinality) from pg_catalog.jsonb_array_elements(rows) with ordinality group by ((ordinality-1)/200) order by ((ordinality-1)/200) loop
  payload:=public.native_sales_canonical_v1(batch);if pg_catalog.octet_length(payload)>1048576 then raise exception 'NATIVE_BOOTSTRAP_PAGE_SIZE';end if;
  pages:=pages||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',idx,'count',pg_catalog.jsonb_array_length(batch),'byteLength',pg_catalog.octet_length(payload),'sha256',public.native_sales_hash_v1(payload)));
  insert into public.native_sales_pages_v1 values(p_negocio_id,p_snapshot_id,idx,payload);idx:=idx+1;
 end loop;
 header:=pg_catalog.jsonb_set(header,'{pages}',pages);update public.native_sales_snapshots_v1 set manifest=header where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;return header;
end $f$;
revoke all on function public.native_sales_submit_v1(text,text,text,text),public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) from public,anon;
grant execute on function public.native_sales_submit_v1(text,text,text,text),public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) to authenticated;

-- Source: 20261011192935_native_sales_turn_context_v1.sql SHA256 02965d611cbcc35b4b3aaf285b9b1c097af02f5bc1151f8c7e95b04908fb5501
-- No rewrite of an operation/hash, no table/data repair, no extra cash effect.

do $guard$ begin

end $guard$;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;s jsonb;doc jsonb;pay jsonb;n uuid;op uuid;i uuid;d uuid;b uuid;k text;epoch bigint;role text;old public.native_sales_ledger_v1%rowtype;
 mode public.native_sales_mode_v1%rowtype;ln jsonb;eff jsonb;proof jsonb;pend jsonb;product public.productos%rowtype;pid uuid;qty numeric;price numeric;rate numeric;sub numeric:=0;tax numeric:=0;disc numeric;total numeric;cash numeric;credit numeric;transfer numeric;card numeric;tender numeric;change numeric;debt numeric;limit_credit numeric;cid uuid;turn uuid;seq bigint;cur integer;after integer;version bigint;expected_version bigint;delta integer;stock jsonb:='[]';effects jsonb:='[]';eid uuid;clock_ms text;receipt jsonb;expected jsonb:='{}';part jsonb;ingredient uuid;part_qty numeric;num numeric;den numeric;method text;serial jsonb;rows_n integer;sn text;ncftype text;ncfnum bigint;own_projection numeric;price_base numeric;tier integer;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 or (p_snapshot is not null and pg_catalog.octet_length(p_snapshot)>1048576) then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;if public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent)<>p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 perform public.native_sales_int_v1(v->'originAtUtcMs');
 if p_hash is null or p_hash!~'^[0-9a-f]{64}$' or pg_catalog.jsonb_typeof(v->'dependencies') is distinct from 'array' or pg_catalog.jsonb_array_length(v->'dependencies')>100 then raise exception 'NATIVE_INTENT_INVALID';end if;
 n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;
 role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or (v->>'actorId')::uuid is distinct from auth.uid() or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role) then raise exception using errcode='42501',message='NATIVE_INTENT_CONTEXT_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is distinct from p_snapshot_hash or old.snapshot_text is distinct from p_snapshot then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 select * into mode from public.native_sales_mode_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b;
 if not found then raise exception using errcode='42501',message='NATIVE_ACTIVATION_REQUIRED';end if;
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;
 clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 if v->>'kind'='TURN_OPEN' then
  if p_snapshot is not null or p_snapshot_hash is not null or exists(select 1 from public.native_sales_turns_v1 where negocio_id=n and status='OPEN' and scope_kind=k and sucursal_id is not distinct from b) then raise exception 'NATIVE_TURN_CONFLICT';end if;
  cash:=public.native_sales_int_v1(v->'payload'->'openingCents');
  insert into public.native_sales_turns_v1 values(n,op,k,b,i,d,auth.uid(),cash::bigint,v->>'originAtUtcMs','OPEN',seq);
  effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',op,'kind','TURN_OPEN','amountCents',cash::text));
 elsif v->>'kind'='SALE_CONFIRM' then
  if p_snapshot is null or p_snapshot_hash is null then raise exception 'NATIVE_SNAPSHOT_REQUIRED';end if;
  s:=p_snapshot::jsonb;if public.native_sales_canonical_v1(s)<>p_snapshot or public.native_sales_hash_v1(p_snapshot)<>p_snapshot_hash then raise exception 'NATIVE_SNAPSHOT_HASH_INVALID';end if;
  doc:=v->'payload'->'sale';pay:=doc->'payment';
  perform public.native_sales_object_v1(s,array['version','operationId','tenantId','actorId','originAtUtcMs','scope','ticket','ncf','customerName','sale']);
  perform public.native_sales_object_v1(doc,array['currency','calculationVersion','lines','discount','totals','payment','inventory','serials','stockEvidence','fiscal']);
  if v->'payload'->>'quoteHash' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_set(doc,'{fiscal}','null'::jsonb))) then raise exception 'NATIVE_QUOTE_HASH_INVALID';end if;
  perform public.native_sales_object_v1(pay,array['method','customerId','paidCents','creditChargeCents','cashNetCents','cardCents','transferCents','tenderCents','changeCents','turnId','bankSettlementVerified']);
  if pg_catalog.jsonb_typeof(doc->'lines') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'inventory') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'serials') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'stockEvidence') is distinct from 'array' then raise exception 'NATIVE_SALE_ARRAY_INVALID';end if;
  if s->'sale' is distinct from doc or s->>'version' is distinct from 'ventard.ticket.snapshot.1' or s->>'operationId' is distinct from op::text or s->>'tenantId' is distinct from n::text or s->>'actorId' is distinct from auth.uid()::text or s->>'originAtUtcMs' is distinct from v->>'originAtUtcMs' or s->'scope' is distinct from pg_catalog.jsonb_build_object('type',k,'branchId',b) or s->>'ticket' is null or s->>'ticket'!~('^N'||pg_catalog.replace(i::text,'-','')||'-[0-9]{6,}$') or doc->>'currency' is distinct from 'DOP' or doc->>'calculationVersion' is distinct from 'ventard.sale.calculation.1' or pg_catalog.jsonb_array_length(doc->'lines') not between 1 and 100 then raise exception 'NATIVE_SALE_INVALID';end if;
  if doc ? 'customer' then
   perform public.native_sales_object_v1(doc->'customer',array['id','name','revision']);
   if s->>'customerName' is distinct from doc->'customer'->>'name' or pg_catalog.length(s->>'customerName') not between 1 and 256 or s->>'customerName' ~ '[[:cntrl:]]' then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   cid:=(doc->'customer'->>'id')::uuid;
   if cid is not null and not exists(select 1 from public.clientes c where c.id=cid and c.negocio_id=n and not coalesce(c.eliminado,false) and c.nombre=doc->'customer'->>'name' and doc->'customer'->>'revision'='1') then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   if pay->>'method'='FIADO' and (cid is null or cid::text is distinct from pay->>'customerId') then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  elsif s->>'customerName' is not null and pay->>'method'<>'FIADO' then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  for ln in select value from pg_catalog.jsonb_array_elements(doc->'lines') loop
   perform public.native_sales_object_v1(ln,array['productId','productRevision','name','unitPriceCents','quantity','taxRate','costCents','serial','recipe']);
   qty:=public.native_sales_int_v1(ln->'quantity'->'numerator',2147483647);if qty=0 or ln->'quantity'->>'denominator' is distinct from '1' or pg_catalog.jsonb_typeof(ln->'recipe') is distinct from 'array' then raise exception 'NATIVE_QUANTITY_INVALID';end if;
   price:=public.native_sales_int_v1(ln->'unitPriceCents');pid:=(ln->>'productId')::uuid;
   if pid is null then rate:=mode.free_tax;if ln->>'name' is null or pg_catalog.length(ln->>'name') not between 1 and 256 or ln->>'name' ~ '[[:cntrl:]]' or ln->>'productRevision' is not null or ln->>'costCents' is not null or pg_catalog.jsonb_array_length(ln->'recipe')<>0 or ln->>'serial' is not null then raise exception 'NATIVE_FREE_LINE_INVALID';end if;
   else
    select * into product from public.productos where id=pid and negocio_id=n and eliminado=false;
    if not found then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;
    price_base:=product.precio_venta;
    if ln ? 'pricePolicy' then
     if ln->'pricePolicy'->>'source' is distinct from 'CUSTOMER' then raise exception 'NATIVE_CUSTOMER_PRICING_INVALID';end if;cid:=(ln->'pricePolicy'->>'customerId')::uuid;tier:=public.native_sales_int_v1(ln->'pricePolicy'->'tier',3)::integer;
     if tier<1 or cid::text is distinct from coalesce(doc->'customer'->>'id',pay->>'customerId') or not exists(select 1 from public.clientes c where c.negocio_id=n and c.id=cid and not coalesce(c.eliminado,false) and coalesce(c.tipo_precio,1)=tier) then raise exception 'NATIVE_CUSTOMER_PRICING_INVALID';end if;
     price_base:=case tier when 2 then coalesce(nullif(product.precio_2,0),product.precio_venta) when 3 then coalesce(nullif(product.precio_3,0),product.precio_venta) else product.precio_venta end;
    end if;
    if ln->>'name' is distinct from product.nombre or ln->>'productRevision' is distinct from '1' or price<>price_base*100 or (ln->>'costCents')::numeric is distinct from product.costo*100 then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;rate:=product.tasa_itbis;
    if product.tipo='combo' then
     if pg_catalog.jsonb_array_length(ln->'recipe')<>(select count(*) from public.composiciones where negocio_id=n and producto_padre_id=pid) or pg_catalog.jsonb_array_length(ln->'recipe')<>(select count(distinct x->>'productId') from pg_catalog.jsonb_array_elements(ln->'recipe') x) then raise exception 'NATIVE_RECIPE_INVALID';end if;
     for part in select value from pg_catalog.jsonb_array_elements(ln->'recipe') loop ingredient:=(part->>'productId')::uuid;num:=public.native_sales_int_v1(part->'perUnit'->'numerator');den:=public.native_sales_int_v1(part->'perUnit'->'denominator');if den=0 then raise exception 'NATIVE_RECIPE_INVALID';end if;part_qty:=qty*num/den;
      if part->>'revision' is distinct from '1' or part_qty<>pg_catalog.trunc(part_qty) or not exists(select 1 from public.composiciones c join public.productos p on p.id=c.insumo_id where c.negocio_id=n and c.producto_padre_id=pid and c.insumo_id=ingredient and c.cantidad_necesaria=num/den and p.negocio_id=n and p.tipo<>'combo' and not coalesce(p.serializable,false) and not coalesce(p.eliminado,false)) then raise exception 'NATIVE_RECIPE_INVALID';end if;
      expected:=pg_catalog.jsonb_set(expected,array[ingredient::text],pg_catalog.to_jsonb(coalesce((expected->>ingredient::text)::numeric,0)-part_qty));end loop;
    else if pg_catalog.jsonb_array_length(ln->'recipe')<>0 then raise exception 'NATIVE_RECIPE_INVALID';end if;expected:=pg_catalog.jsonb_set(expected,array[pid::text],pg_catalog.to_jsonb(coalesce((expected->>pid::text)::numeric,0)-qty));end if;
    if product.serializable and (qty<>1 or ln->>'serial' is null or not exists(select 1 from pg_catalog.jsonb_array_elements(doc->'serials') x where x->>'productId'=pid::text and x->>'text'=ln->>'serial')) then raise exception 'NATIVE_SERIAL_REQUIRED';end if;
    if not product.serializable and ln->>'serial' is not null then raise exception 'NATIVE_SERIAL_INVALID';end if;
   end if;
   num:=public.native_sales_int_v1(ln->'taxRate'->'numerator');den:=public.native_sales_int_v1(ln->'taxRate'->'denominator');if den=0 or num<>rate*den then raise exception 'NATIVE_TAX_INVALID';end if;sub:=sub+price*qty;tax:=tax+price*qty*rate;
   eid:=public.native_sales_effect_id_v1(op,'line/'||(pg_catalog.jsonb_array_length(effects))::text);effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',eid,'kind','LINE','payload',ln));
  end loop;
  tax:=pg_catalog.floor(tax+0.5);
  if doc->'discount'->>'type'='AMOUNT' then disc:=least(public.native_sales_int_v1(doc->'discount'->'amountCents'),sub+tax);
  elsif doc->'discount'->>'type'='PERCENT' then num:=public.native_sales_int_v1(doc->'discount'->'ratio'->'numerator');den:=public.native_sales_int_v1(doc->'discount'->'ratio'->'denominator');if den=0 or num>100*den then raise exception 'NATIVE_DISCOUNT_INVALID';end if;disc:=pg_catalog.floor((sub+tax)*num/(den*100)+0.5);
  else raise exception 'NATIVE_DISCOUNT_INVALID';end if;total:=sub+tax-disc;
  if public.native_sales_int_v1(doc->'totals'->'subtotalCents')<>sub or public.native_sales_int_v1(doc->'totals'->'itbisCents')<>tax or public.native_sales_int_v1(doc->'totals'->'discountCents')<>disc or public.native_sales_int_v1(doc->'totals'->'totalCents')<>total then raise exception 'NATIVE_TOTALS_INVALID';end if;
  if pg_catalog.jsonb_array_length(doc->'inventory')<>(select count(*) from pg_catalog.jsonb_each(expected)) or pg_catalog.jsonb_array_length(doc->'stockEvidence')<>pg_catalog.jsonb_array_length(doc->'inventory') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
  for eff in select value from pg_catalog.jsonb_array_elements(doc->'inventory') loop
   pid:=(eff->>'productId')::uuid;delta:=(eff->>'delta')::integer;if delta>=0 or eff->>'delta' is distinct from delta::text or delta::numeric is distinct from (expected->>pid::text)::numeric then raise exception 'NATIVE_STOCK_EFFECT_INVALID';end if;expected:=expected-pid::text;
   select value into proof from pg_catalog.jsonb_array_elements(doc->'stockEvidence') where value->>'productId'=pid::text;
   if (select count(*) from pg_catalog.jsonb_array_elements(doc->'stockEvidence') x where x->>'productId'=pid::text)<>1 or pg_catalog.jsonb_typeof(proof->'pending') is distinct from 'array' or pg_catalog.jsonb_array_length(proof->'pending')>1000 or (select count(distinct x->>'effectId') from pg_catalog.jsonb_array_elements(proof->'pending') x)<>pg_catalog.jsonb_array_length(proof->'pending') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
   expected_version:=public.native_sales_int_v1(proof->'remoteSequence')::bigint;
   select revision into version from public.native_sales_stock_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid for update;
   if not found then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
   if k='BRANCH' then select stock_actual into cur from public.inventario_sucursales where sucursal_id=b and producto_id=pid for update;else select stock_actual into cur from public.productos where id=pid and negocio_id=n for update;end if;
   if cur is null then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
   num:=public.native_sales_int_v1(proof->'remoteBaseQty',2147483647);
   for pend in select value from pg_catalog.jsonb_array_elements(proof->'pending') loop
    select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=(pend->>'operationId')::uuid and installation_id=i and scope_kind=k and sucursal_id is not distinct from b;
    if not found or not exists(select 1 from public.native_sales_effects_v1 x where x.negocio_id=n and x.operation_id=old.operation_id and x.effect_id=(pend->>'effectId')::uuid and x.kind='STOCK' and x.payload->>'productId'=pid::text and x.payload->>'delta'=pend->>'delta') then raise exception 'NATIVE_PENDING_COVERAGE_INVALID';end if;
    num:=num+(pend->>'delta')::integer;expected_version:=greatest(expected_version,old.remote_sequence);
   end loop;
   if version<>expected_version or num<>cur or public.native_sales_int_v1(proof->'effectiveQty',2147483647)<>cur or eff->>'expectedRevision' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object('quantity',proof->>'effectiveQty','remoteSequence',proof->>'remoteSequence','pending',proof->'pending'))) then raise exception 'NATIVE_STOCK_VERSION_CONFLICT';end if;
   after:=cur+delta;if after<0 then raise exception 'NATIVE_STOCK_UNAVAILABLE';end if;
   if k='BRANCH' then
    if exists(select 1 from public.inventario_sucursales z left join public.sucursales br on br.id=z.sucursal_id where z.producto_id=pid and br.negocio_id is distinct from n) then raise exception 'NATIVE_STOCK_SOURCE_UNVERIFIABLE';end if;
    select sum(stock_actual) into own_projection from public.inventario_sucursales where producto_id=pid;
    if own_projection is distinct from (select stock_actual::numeric from public.productos where id=pid and negocio_id=n) then raise exception 'AUTHORITY_PROJECTION_DIVERGED';end if;
    update public.inventario_sucursales set stock_actual=after where sucursal_id=b and producto_id=pid;
    update public.productos set stock_actual=(own_projection+delta)::integer where id=pid and negocio_id=n;
   else update public.productos set stock_actual=after where id=pid and negocio_id=n;end if;
   update public.native_sales_stock_v1 set revision=seq where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid;
   eid:=public.native_sales_effect_id_v1(op,'stock/'||pid::text);effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',eid,'kind','STOCK','payload',pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text)));
   stock:=stock||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'after',after::text,'version',seq::text));
  end loop;
  method:=pay->>'method';if method is null then raise exception 'NATIVE_PAYMENT_INVALID';end if;cash:=public.native_sales_int_v1(pay->'cashNetCents');credit:=public.native_sales_int_v1(pay->'creditChargeCents');transfer:=public.native_sales_int_v1(pay->'transferCents');card:=public.native_sales_int_v1(pay->'cardCents');tender:=public.native_sales_int_v1(pay->'tenderCents');change:=public.native_sales_int_v1(pay->'changeCents');turn:=(pay->>'turnId')::uuid;
  if pay->'bankSettlementVerified' is distinct from 'false'::jsonb or v->>'originalTurnId' is distinct from pay->>'turnId' then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  if method<>'FIADO' and pay->>'customerId' is not null then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  -- Non-cash retains the known turn as context, never as a cash effect.
  if turn is not null and not exists(select 1 from public.native_sales_turns_v1 t where t.negocio_id=n and t.turn_id=turn and t.status='OPEN' and t.scope_kind=k and t.sucursal_id is not distinct from b) then raise exception 'NATIVE_TURN_CONTEXT_INVALID';end if;
  if method in('EFECTIVO','MIXTO') and not exists(select 1 from public.native_sales_turns_v1 where negocio_id=n and turn_id=turn and status='OPEN' and scope_kind=k and sucursal_id is not distinct from b) then raise exception 'NATIVE_TURN_REQUIRED';end if;
  if method='EFECTIVO' and (cash<>total or transfer<>0 or card<>0 or credit<>0 or tender<cash or change<>tender-cash) or method='TARJETA' and (card<>total or cash<>0 or transfer<>0 or credit<>0 or tender<>0 or change<>0) or method='TRANSFERENCIA' and (transfer<>total or cash<>0 or card<>0 or credit<>0 or tender<>0 or change<>0) or method='MIXTO' and (cash+transfer<>total or card<>0 or credit<>0 or tender<cash or change<>tender-cash) or method='FIADO' and (credit<>total or cash<>0 or card<>0 or transfer<>0 or tender<>0 or change<>0) or method not in('EFECTIVO','TARJETA','TRANSFERENCIA','MIXTO','FIADO') or public.native_sales_int_v1(pay->'paidCents')<>cash+card+transfer then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  if method='FIADO' then cid:=(pay->>'customerId')::uuid;select x.balance_cents,c.limite_credito*100 into debt,limit_credit from public.native_sales_credit_v1 x join public.clientes c on c.id=x.cliente_id and c.negocio_id=x.negocio_id where x.negocio_id=n and x.cliente_id=cid and not coalesce(c.eliminado,false) for update of x;
   if not found or limit_credit is null or limit_credit>0 and debt+credit>limit_credit then raise exception 'NATIVE_CREDIT_LIMIT';end if;update public.native_sales_credit_v1 set balance_cents=balance_cents+credit,revision=revision+1 where negocio_id=n and cliente_id=cid;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'credit'),'kind','CREDIT','payload',pg_catalog.jsonb_build_object('customerId',cid,'amountCents',credit::text)));
  end if;
  if method in('EFECTIVO','MIXTO') then effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'cash'),'kind','CASH','payload',pg_catalog.jsonb_build_object('turnId',turn,'amountCents',cash::text)));end if;
  effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'payment'),'kind','PAYMENT','payload',pay));
  if pg_catalog.jsonb_array_length(doc->'serials')<>(select count(*) from pg_catalog.jsonb_array_elements(doc->'lines') x where x->>'serial' is not null) then raise exception 'NATIVE_SERIAL_COVERAGE_INVALID';end if;
  for serial in select value from pg_catalog.jsonb_array_elements(doc->'serials') loop sn:=serial->>'text';pid:=(serial->>'productId')::uuid;
   if sn is null or not exists(select 1 from pg_catalog.jsonb_array_elements(doc->'lines') x where x->>'serial'=sn and x->>'productId'=pid::text) or serial->>'expectedRevision' is distinct from '1' then raise exception 'NATIVE_SERIAL_INVALID';end if;
   update public.seriales set estado='vendido',venta_id=op,fecha_venta=(v->>'originAtUtcMs')::bigint,fecha_actualizacion=clock_ms::bigint where negocio_id=n and producto_id=pid and numero_serial=sn and estado='disponible';get diagnostics rows_n=row_count;if rows_n<>1 then raise exception 'NATIVE_SERIAL_CONFLICT';end if;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'serial/'||sn),'kind','SERIAL','payload',serial));end loop;
  if doc->'fiscal'<>'null'::jsonb then
   sn:=doc->'fiscal'->>'ncf';ncftype:=pg_catalog.substr(sn,1,3);if sn!~'^B0[12][0-9]{8}$' then raise exception 'NATIVE_FISCAL_INVALID';end if;ncfnum:=pg_catalog.substr(sn,4)::bigint;
   if doc->'fiscal'->>'reservationId' is distinct from op::text or doc->'fiscal'->>'type' is distinct from ncftype or doc->'fiscal'->>'number' is distinct from ncfnum::text or not exists(select 1 from public.native_fiscal_requests_v2 f where f.negocio_id=n and f.installation_id=i and f.request_id=(doc->'fiscal'->>'blockId')::uuid and f.receipt->>'deviceId'=d::text and f.receipt->>'writerEpoch'=epoch::text and f.receipt->>'status'='ALLOCATED' and f.receipt->>'kind'=ncftype and (f.receipt->>'first')::bigint<=ncfnum and (f.receipt->>'last')::bigint>=ncfnum) or s->>'ncf' is distinct from sn then raise exception 'NATIVE_FISCAL_INVALID';end if;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'fiscal'),'kind','FISCAL','payload',doc->'fiscal'));
  elsif s->>'ncf' is not null then raise exception 'NATIVE_FISCAL_INVALID';end if;
 else raise exception 'NATIVE_KIND_UNSUPPORTED';end if;
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',p_snapshot_hash,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',s->>'ticket','ncf',s->>'ncf','totalCents',case when s is not null then total::text else null end,'effects',effects,'stock',stock);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,v->>'kind',p_intent,p_hash,p_snapshot,p_snapshot_hash,s->>'ticket',s->>'ncf',seq,receipt);
 for eff in select value from pg_catalog.jsonb_array_elements(effects) loop insert into public.native_sales_effects_v1 values(n,op,(eff->>'id')::uuid,eff->>'kind',coalesce(eff->'payload',eff));end loop;
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;
 return receipt;
end $f$;
revoke all on function public.native_sales_submit_v1(text,text,text,text) from public,anon;
grant execute on function public.native_sales_submit_v1(text,text,text,text) to authenticated;

-- Source: 20261012004947_native_management_staging_v1.sql SHA256 04120a8ca1955eeffd57b2890469a789d541453bbd47f5794ec699a22a99b0d3
-- Run this versioned migration only after explicit environment authorization.

do $guard$ begin

end $guard$;
create table if not exists public.native_customer_metadata_v1(negocio_id uuid not null,cliente_id uuid not null,phone text,wholesale boolean not null,revision bigint not null check(revision>0),primary key(negocio_id,cliente_id));
create table if not exists public.native_management_records_v1(negocio_id uuid not null,operation_id uuid not null,scope_kind text not null,sucursal_id uuid,kind text not null,turn_id uuid,cliente_id uuid,method text,amount_cents bigint not null,concept text not null,origin_at_ms text not null,document jsonb not null,primary key(negocio_id,operation_id),foreign key(negocio_id,operation_id) references public.native_sales_ledger_v1(negocio_id,operation_id) deferrable initially deferred);
alter table public.native_customer_metadata_v1 enable row level security;
alter table public.native_management_records_v1 enable row level security;
revoke all on public.native_customer_metadata_v1,public.native_management_records_v1 from public,anon,authenticated;
create or replace function public.native_sales_submit_base_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;s jsonb;doc jsonb;pay jsonb;n uuid;op uuid;i uuid;d uuid;b uuid;k text;epoch bigint;role text;old public.native_sales_ledger_v1%rowtype;
 mode public.native_sales_mode_v1%rowtype;ln jsonb;eff jsonb;proof jsonb;pend jsonb;product public.productos%rowtype;pid uuid;qty numeric;price numeric;rate numeric;sub numeric:=0;tax numeric:=0;disc numeric;total numeric;cash numeric;credit numeric;transfer numeric;card numeric;tender numeric;change numeric;debt numeric;limit_credit numeric;cid uuid;turn uuid;seq bigint;cur integer;after integer;version bigint;expected_version bigint;delta integer;stock jsonb:='[]';effects jsonb:='[]';eid uuid;clock_ms text;receipt jsonb;expected jsonb:='{}';part jsonb;ingredient uuid;part_qty numeric;num numeric;den numeric;method text;serial jsonb;rows_n integer;sn text;ncftype text;ncfnum bigint;own_projection numeric;price_base numeric;tier integer;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 or (p_snapshot is not null and pg_catalog.octet_length(p_snapshot)>1048576) then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;if public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent)<>p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 perform public.native_sales_int_v1(v->'originAtUtcMs');
 if p_hash is null or p_hash!~'^[0-9a-f]{64}$' or pg_catalog.jsonb_typeof(v->'dependencies') is distinct from 'array' or pg_catalog.jsonb_array_length(v->'dependencies')>100 then raise exception 'NATIVE_INTENT_INVALID';end if;
 n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;
 role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or (v->>'actorId')::uuid is distinct from auth.uid() or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role) then raise exception using errcode='42501',message='NATIVE_INTENT_CONTEXT_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is distinct from p_snapshot_hash or old.snapshot_text is distinct from p_snapshot then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 select * into mode from public.native_sales_mode_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b;
 if not found then raise exception using errcode='42501',message='NATIVE_ACTIVATION_REQUIRED';end if;
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;
 clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 if v->>'kind'='TURN_OPEN' then
  if p_snapshot is not null or p_snapshot_hash is not null or exists(select 1 from public.native_sales_turns_v1 where negocio_id=n and status='OPEN' and scope_kind=k and sucursal_id is not distinct from b) then raise exception 'NATIVE_TURN_CONFLICT';end if;
  cash:=public.native_sales_int_v1(v->'payload'->'openingCents');
  if v->'payload' ? 'denominations' then
   if pg_catalog.jsonb_typeof(v->'payload'->'denominations') is distinct from 'array' or pg_catalog.jsonb_array_length(v->'payload'->'denominations')>20 then raise exception 'NATIVE_COUNT_INVALID';end if;
   if (select count(distinct value->>'valueCents') from pg_catalog.jsonb_array_elements(v->'payload'->'denominations'))<>pg_catalog.jsonb_array_length(v->'payload'->'denominations') then raise exception 'NATIVE_COUNT_INVALID';end if;
   num:=0;for eff in select value from pg_catalog.jsonb_array_elements(v->'payload'->'denominations') loop den:=public.native_sales_int_v1(eff->'valueCents');if den not in(1,5,10,25,50,100,500,1000,2500,5000,10000,20000,50000,100000,200000) then raise exception 'NATIVE_COUNT_INVALID';end if;num:=num+den*public.native_sales_int_v1(eff->'count');end loop;
   if num<>cash then raise exception 'NATIVE_COUNT_INVALID';end if;
  end if;
  insert into public.native_sales_turns_v1 values(n,op,k,b,i,d,auth.uid(),cash::bigint,v->>'originAtUtcMs','OPEN',seq);
  effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',op,'kind','TURN_OPEN','amountCents',cash::text));
 elsif v->>'kind'='SALE_CONFIRM' then
  if p_snapshot is null or p_snapshot_hash is null then raise exception 'NATIVE_SNAPSHOT_REQUIRED';end if;
  s:=p_snapshot::jsonb;if public.native_sales_canonical_v1(s)<>p_snapshot or public.native_sales_hash_v1(p_snapshot)<>p_snapshot_hash then raise exception 'NATIVE_SNAPSHOT_HASH_INVALID';end if;
  doc:=v->'payload'->'sale';pay:=doc->'payment';
  perform public.native_sales_object_v1(s,array['version','operationId','tenantId','actorId','originAtUtcMs','scope','ticket','ncf','customerName','sale']);
  perform public.native_sales_object_v1(doc,array['currency','calculationVersion','lines','discount','totals','payment','inventory','serials','stockEvidence','fiscal']);
  if v->'payload'->>'quoteHash' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_set(doc,'{fiscal}','null'::jsonb))) then raise exception 'NATIVE_QUOTE_HASH_INVALID';end if;
  perform public.native_sales_object_v1(pay,array['method','customerId','paidCents','creditChargeCents','cashNetCents','cardCents','transferCents','tenderCents','changeCents','turnId','bankSettlementVerified']);
  if pg_catalog.jsonb_typeof(doc->'lines') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'inventory') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'serials') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'stockEvidence') is distinct from 'array' then raise exception 'NATIVE_SALE_ARRAY_INVALID';end if;
  if s->'sale' is distinct from doc or s->>'version' is distinct from 'ventard.ticket.snapshot.1' or s->>'operationId' is distinct from op::text or s->>'tenantId' is distinct from n::text or s->>'actorId' is distinct from auth.uid()::text or s->>'originAtUtcMs' is distinct from v->>'originAtUtcMs' or s->'scope' is distinct from pg_catalog.jsonb_build_object('type',k,'branchId',b) or s->>'ticket' is null or s->>'ticket'!~('^N'||pg_catalog.replace(i::text,'-','')||'-[0-9]{6,}$') or doc->>'currency' is distinct from 'DOP' or doc->>'calculationVersion' is distinct from 'ventard.sale.calculation.1' or pg_catalog.jsonb_array_length(doc->'lines') not between 1 and 100 then raise exception 'NATIVE_SALE_INVALID';end if;
  if doc ? 'customer' then
   perform public.native_sales_object_v1(doc->'customer',array['id','name','revision']);
   if s->>'customerName' is distinct from doc->'customer'->>'name' or pg_catalog.length(s->>'customerName') not between 1 and 256 or s->>'customerName' ~ '[[:cntrl:]]' then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   cid:=(doc->'customer'->>'id')::uuid;
   if cid is not null and not exists(select 1 from public.clientes c where c.id=cid and c.negocio_id=n and not coalesce(c.eliminado,false) and c.nombre=doc->'customer'->>'name' and doc->'customer'->>'revision'=coalesce((select cm.revision::text from public.native_customer_metadata_v1 cm where cm.negocio_id=n and cm.cliente_id=cid),'1')) then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   if pay->>'method'='FIADO' and (cid is null or cid::text is distinct from pay->>'customerId') then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  elsif s->>'customerName' is not null and pay->>'method'<>'FIADO' then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  for ln in select value from pg_catalog.jsonb_array_elements(doc->'lines') loop
   perform public.native_sales_object_v1(ln,array['productId','productRevision','name','unitPriceCents','quantity','taxRate','costCents','serial','recipe']);
   qty:=public.native_sales_int_v1(ln->'quantity'->'numerator',2147483647);if qty=0 or ln->'quantity'->>'denominator' is distinct from '1' or pg_catalog.jsonb_typeof(ln->'recipe') is distinct from 'array' then raise exception 'NATIVE_QUANTITY_INVALID';end if;
   price:=public.native_sales_int_v1(ln->'unitPriceCents');pid:=(ln->>'productId')::uuid;
   if pid is null then rate:=mode.free_tax;if ln->>'name' is null or pg_catalog.length(ln->>'name') not between 1 and 256 or ln->>'name' ~ '[[:cntrl:]]' or ln->>'productRevision' is not null or ln->>'costCents' is not null or pg_catalog.jsonb_array_length(ln->'recipe')<>0 or ln->>'serial' is not null then raise exception 'NATIVE_FREE_LINE_INVALID';end if;
   else
    select * into product from public.productos where id=pid and negocio_id=n and eliminado=false;
    if not found then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;
    price_base:=product.precio_venta;
    if ln ? 'pricePolicy' then
     if ln->'pricePolicy'->>'source' is distinct from 'CUSTOMER' then raise exception 'NATIVE_CUSTOMER_PRICING_INVALID';end if;cid:=(ln->'pricePolicy'->>'customerId')::uuid;tier:=public.native_sales_int_v1(ln->'pricePolicy'->'tier',3)::integer;
     if tier<1 or cid::text is distinct from coalesce(doc->'customer'->>'id',pay->>'customerId') or not exists(select 1 from public.clientes c where c.negocio_id=n and c.id=cid and not coalesce(c.eliminado,false) and coalesce(c.tipo_precio,1)=tier) then raise exception 'NATIVE_CUSTOMER_PRICING_INVALID';end if;
     price_base:=case tier when 2 then coalesce(nullif(product.precio_2,0),product.precio_venta) when 3 then coalesce(nullif(product.precio_3,0),product.precio_venta) else product.precio_venta end;
    end if;
    if ln->>'name' is distinct from product.nombre or ln->>'productRevision' is distinct from '1' or price<>price_base*100 or (ln->>'costCents')::numeric is distinct from product.costo*100 then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;rate:=product.tasa_itbis;
    if product.tipo='combo' then
     if pg_catalog.jsonb_array_length(ln->'recipe')<>(select count(*) from public.composiciones where negocio_id=n and producto_padre_id=pid) or pg_catalog.jsonb_array_length(ln->'recipe')<>(select count(distinct x->>'productId') from pg_catalog.jsonb_array_elements(ln->'recipe') x) then raise exception 'NATIVE_RECIPE_INVALID';end if;
     for part in select value from pg_catalog.jsonb_array_elements(ln->'recipe') loop ingredient:=(part->>'productId')::uuid;num:=public.native_sales_int_v1(part->'perUnit'->'numerator');den:=public.native_sales_int_v1(part->'perUnit'->'denominator');if den=0 then raise exception 'NATIVE_RECIPE_INVALID';end if;part_qty:=qty*num/den;
      if part->>'revision' is distinct from '1' or part_qty<>pg_catalog.trunc(part_qty) or not exists(select 1 from public.composiciones c join public.productos p on p.id=c.insumo_id where c.negocio_id=n and c.producto_padre_id=pid and c.insumo_id=ingredient and c.cantidad_necesaria=num/den and p.negocio_id=n and p.tipo<>'combo' and not coalesce(p.serializable,false) and not coalesce(p.eliminado,false)) then raise exception 'NATIVE_RECIPE_INVALID';end if;
      expected:=pg_catalog.jsonb_set(expected,array[ingredient::text],pg_catalog.to_jsonb(coalesce((expected->>ingredient::text)::numeric,0)-part_qty));end loop;
    else if pg_catalog.jsonb_array_length(ln->'recipe')<>0 then raise exception 'NATIVE_RECIPE_INVALID';end if;expected:=pg_catalog.jsonb_set(expected,array[pid::text],pg_catalog.to_jsonb(coalesce((expected->>pid::text)::numeric,0)-qty));end if;
    if product.serializable and (qty<>1 or ln->>'serial' is null or not exists(select 1 from pg_catalog.jsonb_array_elements(doc->'serials') x where x->>'productId'=pid::text and x->>'text'=ln->>'serial')) then raise exception 'NATIVE_SERIAL_REQUIRED';end if;
    if not product.serializable and ln->>'serial' is not null then raise exception 'NATIVE_SERIAL_INVALID';end if;
   end if;
   num:=public.native_sales_int_v1(ln->'taxRate'->'numerator');den:=public.native_sales_int_v1(ln->'taxRate'->'denominator');if den=0 or num<>rate*den then raise exception 'NATIVE_TAX_INVALID';end if;sub:=sub+price*qty;tax:=tax+price*qty*rate;
   eid:=public.native_sales_effect_id_v1(op,'line/'||(pg_catalog.jsonb_array_length(effects))::text);effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',eid,'kind','LINE','payload',ln));
  end loop;
  tax:=pg_catalog.floor(tax+0.5);
  if doc->'discount'->>'type'='AMOUNT' then disc:=least(public.native_sales_int_v1(doc->'discount'->'amountCents'),sub+tax);
  elsif doc->'discount'->>'type'='PERCENT' then num:=public.native_sales_int_v1(doc->'discount'->'ratio'->'numerator');den:=public.native_sales_int_v1(doc->'discount'->'ratio'->'denominator');if den=0 or num>100*den then raise exception 'NATIVE_DISCOUNT_INVALID';end if;disc:=pg_catalog.floor((sub+tax)*num/(den*100)+0.5);
  else raise exception 'NATIVE_DISCOUNT_INVALID';end if;total:=sub+tax-disc;
  if public.native_sales_int_v1(doc->'totals'->'subtotalCents')<>sub or public.native_sales_int_v1(doc->'totals'->'itbisCents')<>tax or public.native_sales_int_v1(doc->'totals'->'discountCents')<>disc or public.native_sales_int_v1(doc->'totals'->'totalCents')<>total then raise exception 'NATIVE_TOTALS_INVALID';end if;
  if pg_catalog.jsonb_array_length(doc->'inventory')<>(select count(*) from pg_catalog.jsonb_each(expected)) or pg_catalog.jsonb_array_length(doc->'stockEvidence')<>pg_catalog.jsonb_array_length(doc->'inventory') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
  for eff in select value from pg_catalog.jsonb_array_elements(doc->'inventory') loop
   pid:=(eff->>'productId')::uuid;delta:=(eff->>'delta')::integer;if delta>=0 or eff->>'delta' is distinct from delta::text or delta::numeric is distinct from (expected->>pid::text)::numeric then raise exception 'NATIVE_STOCK_EFFECT_INVALID';end if;expected:=expected-pid::text;
   select value into proof from pg_catalog.jsonb_array_elements(doc->'stockEvidence') where value->>'productId'=pid::text;
   if (select count(*) from pg_catalog.jsonb_array_elements(doc->'stockEvidence') x where x->>'productId'=pid::text)<>1 or pg_catalog.jsonb_typeof(proof->'pending') is distinct from 'array' or pg_catalog.jsonb_array_length(proof->'pending')>1000 or (select count(distinct x->>'effectId') from pg_catalog.jsonb_array_elements(proof->'pending') x)<>pg_catalog.jsonb_array_length(proof->'pending') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
   expected_version:=public.native_sales_int_v1(proof->'remoteSequence')::bigint;
   select revision into version from public.native_sales_stock_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid for update;
   if not found then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
   if k='BRANCH' then select stock_actual into cur from public.inventario_sucursales where sucursal_id=b and producto_id=pid for update;else select stock_actual into cur from public.productos where id=pid and negocio_id=n for update;end if;
   if cur is null then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
   num:=public.native_sales_int_v1(proof->'remoteBaseQty',2147483647);
   for pend in select value from pg_catalog.jsonb_array_elements(proof->'pending') loop
    select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=(pend->>'operationId')::uuid and installation_id=i and scope_kind=k and sucursal_id is not distinct from b;
    if not found or not exists(select 1 from public.native_sales_effects_v1 x where x.negocio_id=n and x.operation_id=old.operation_id and x.effect_id=(pend->>'effectId')::uuid and x.kind='STOCK' and x.payload->>'productId'=pid::text and x.payload->>'delta'=pend->>'delta') then raise exception 'NATIVE_PENDING_COVERAGE_INVALID';end if;
    num:=num+(pend->>'delta')::integer;expected_version:=greatest(expected_version,old.remote_sequence);
   end loop;
   if version<>expected_version or num<>cur or public.native_sales_int_v1(proof->'effectiveQty',2147483647)<>cur or eff->>'expectedRevision' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object('quantity',proof->>'effectiveQty','remoteSequence',proof->>'remoteSequence','pending',proof->'pending'))) then raise exception 'NATIVE_STOCK_VERSION_CONFLICT';end if;
   after:=cur+delta;if after<0 then raise exception 'NATIVE_STOCK_UNAVAILABLE';end if;
   if k='BRANCH' then
    if exists(select 1 from public.inventario_sucursales z left join public.sucursales br on br.id=z.sucursal_id where z.producto_id=pid and br.negocio_id is distinct from n) then raise exception 'NATIVE_STOCK_SOURCE_UNVERIFIABLE';end if;
    select sum(stock_actual) into own_projection from public.inventario_sucursales where producto_id=pid;
    if own_projection is distinct from (select stock_actual::numeric from public.productos where id=pid and negocio_id=n) then raise exception 'AUTHORITY_PROJECTION_DIVERGED';end if;
    update public.inventario_sucursales set stock_actual=after where sucursal_id=b and producto_id=pid;
    update public.productos set stock_actual=(own_projection+delta)::integer where id=pid and negocio_id=n;
   else update public.productos set stock_actual=after where id=pid and negocio_id=n;end if;
   update public.native_sales_stock_v1 set revision=seq where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid;
   eid:=public.native_sales_effect_id_v1(op,'stock/'||pid::text);effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',eid,'kind','STOCK','payload',pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text)));
   stock:=stock||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'after',after::text,'version',seq::text));
  end loop;
  method:=pay->>'method';if method is null then raise exception 'NATIVE_PAYMENT_INVALID';end if;cash:=public.native_sales_int_v1(pay->'cashNetCents');credit:=public.native_sales_int_v1(pay->'creditChargeCents');transfer:=public.native_sales_int_v1(pay->'transferCents');card:=public.native_sales_int_v1(pay->'cardCents');tender:=public.native_sales_int_v1(pay->'tenderCents');change:=public.native_sales_int_v1(pay->'changeCents');turn:=(pay->>'turnId')::uuid;
  if pay->'bankSettlementVerified' is distinct from 'false'::jsonb or v->>'originalTurnId' is distinct from pay->>'turnId' then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  if method<>'FIADO' and pay->>'customerId' is not null then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  -- Non-cash retains the known turn as context, never as a cash effect.
  if turn is not null and not exists(select 1 from public.native_sales_turns_v1 t where t.negocio_id=n and t.turn_id=turn and t.status='OPEN' and t.scope_kind=k and t.sucursal_id is not distinct from b) then raise exception 'NATIVE_TURN_CONTEXT_INVALID';end if;
  if method in('EFECTIVO','MIXTO') and not exists(select 1 from public.native_sales_turns_v1 where negocio_id=n and turn_id=turn and status='OPEN' and scope_kind=k and sucursal_id is not distinct from b) then raise exception 'NATIVE_TURN_REQUIRED';end if;
  if method='EFECTIVO' and (cash<>total or transfer<>0 or card<>0 or credit<>0 or tender<cash or change<>tender-cash) or method='TARJETA' and (card<>total or cash<>0 or transfer<>0 or credit<>0 or tender<>0 or change<>0) or method='TRANSFERENCIA' and (transfer<>total or cash<>0 or card<>0 or credit<>0 or tender<>0 or change<>0) or method='MIXTO' and (cash+transfer<>total or card<>0 or credit<>0 or tender<cash or change<>tender-cash) or method='FIADO' and (credit<>total or cash<>0 or card<>0 or transfer<>0 or tender<>0 or change<>0) or method not in('EFECTIVO','TARJETA','TRANSFERENCIA','MIXTO','FIADO') or public.native_sales_int_v1(pay->'paidCents')<>cash+card+transfer then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  if method='FIADO' then cid:=(pay->>'customerId')::uuid;select x.balance_cents,c.limite_credito*100 into debt,limit_credit from public.native_sales_credit_v1 x join public.clientes c on c.id=x.cliente_id and c.negocio_id=x.negocio_id where x.negocio_id=n and x.cliente_id=cid and not coalesce(c.eliminado,false) for update of x;
   if not found or limit_credit is null or limit_credit>0 and debt+credit>limit_credit then raise exception 'NATIVE_CREDIT_LIMIT';end if;update public.native_sales_credit_v1 set balance_cents=balance_cents+credit,revision=revision+1 where negocio_id=n and cliente_id=cid;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'credit'),'kind','CREDIT','payload',pg_catalog.jsonb_build_object('customerId',cid,'amountCents',credit::text)));
  end if;
  if method in('EFECTIVO','MIXTO') then effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'cash'),'kind','CASH','payload',pg_catalog.jsonb_build_object('turnId',turn,'amountCents',cash::text)));end if;
  effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'payment'),'kind','PAYMENT','payload',pay));
  if pg_catalog.jsonb_array_length(doc->'serials')<>(select count(*) from pg_catalog.jsonb_array_elements(doc->'lines') x where x->>'serial' is not null) then raise exception 'NATIVE_SERIAL_COVERAGE_INVALID';end if;
  for serial in select value from pg_catalog.jsonb_array_elements(doc->'serials') loop sn:=serial->>'text';pid:=(serial->>'productId')::uuid;
   if sn is null or not exists(select 1 from pg_catalog.jsonb_array_elements(doc->'lines') x where x->>'serial'=sn and x->>'productId'=pid::text) or serial->>'expectedRevision' is distinct from '1' then raise exception 'NATIVE_SERIAL_INVALID';end if;
   update public.seriales set estado='vendido',venta_id=op,fecha_venta=(v->>'originAtUtcMs')::bigint,fecha_actualizacion=clock_ms::bigint where negocio_id=n and producto_id=pid and numero_serial=sn and estado='disponible';get diagnostics rows_n=row_count;if rows_n<>1 then raise exception 'NATIVE_SERIAL_CONFLICT';end if;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'serial/'||sn),'kind','SERIAL','payload',serial));end loop;
  if doc->'fiscal'<>'null'::jsonb then
   sn:=doc->'fiscal'->>'ncf';ncftype:=pg_catalog.substr(sn,1,3);if sn!~'^B0[12][0-9]{8}$' then raise exception 'NATIVE_FISCAL_INVALID';end if;ncfnum:=pg_catalog.substr(sn,4)::bigint;
   if doc->'fiscal'->>'reservationId' is distinct from op::text or doc->'fiscal'->>'type' is distinct from ncftype or doc->'fiscal'->>'number' is distinct from ncfnum::text or not exists(select 1 from public.native_fiscal_requests_v2 f where f.negocio_id=n and f.installation_id=i and f.request_id=(doc->'fiscal'->>'blockId')::uuid and f.receipt->>'deviceId'=d::text and f.receipt->>'writerEpoch'=epoch::text and f.receipt->>'status'='ALLOCATED' and f.receipt->>'kind'=ncftype and (f.receipt->>'first')::bigint<=ncfnum and (f.receipt->>'last')::bigint>=ncfnum) or s->>'ncf' is distinct from sn then raise exception 'NATIVE_FISCAL_INVALID';end if;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'fiscal'),'kind','FISCAL','payload',doc->'fiscal'));
  elsif s->>'ncf' is not null then raise exception 'NATIVE_FISCAL_INVALID';end if;
 else raise exception 'NATIVE_KIND_UNSUPPORTED';end if;
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',p_snapshot_hash,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',s->>'ticket','ncf',s->>'ncf','totalCents',case when s is not null then total::text else null end,'effects',effects,'stock',stock);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,v->>'kind',p_intent,p_hash,p_snapshot,p_snapshot_hash,s->>'ticket',s->>'ncf',seq,receipt);
 for eff in select value from pg_catalog.jsonb_array_elements(effects) loop insert into public.native_sales_effects_v1 values(n,op,(eff->>'id')::uuid,eff->>'kind',coalesce(eff->'payload',eff));end loop;
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;
 return receipt;
end $f$;

create or replace function public.native_cash_base_v1(n uuid,k text,b uuid,through bigint) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare turn uuid;net numeric;
begin
 select t.turn_id into turn from public.native_sales_turns_v1 t where t.negocio_id=n and t.scope_kind=k and t.sucursal_id is not distinct from b and t.status='OPEN' and t.revision<=through;
 if turn is null then return null;end if;
 select coalesce(sum(x.amount),0) into net from (
  select (e.payload->>'amountCents')::numeric amount from public.native_sales_effects_v1 e join public.native_sales_ledger_v1 l on l.negocio_id=e.negocio_id and l.operation_id=e.operation_id where e.negocio_id=n and e.kind='CASH' and e.payload->>'turnId'=turn::text and l.scope_kind=k and l.sucursal_id is not distinct from b and l.remote_sequence<=through
  union all select (r.document->>'cashDeltaCents')::numeric from public.native_management_records_v1 r join public.native_sales_ledger_v1 l on l.negocio_id=r.negocio_id and l.operation_id=r.operation_id where r.negocio_id=n and r.turn_id=turn and r.scope_kind=k and r.sucursal_id is not distinct from b and r.document ? 'cashDeltaCents' and l.remote_sequence<=through
 ) x;
 if pg_catalog.abs(net)>9007199254740991 then raise exception 'NATIVE_CASH_OVERFLOW';end if;
 return pg_catalog.jsonb_build_object('tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'turnId',turn,'sequence',through::text,'netCents',net::bigint::text);
end $f$;
revoke all on function public.native_cash_base_v1(uuid,text,uuid,bigint) from public,anon,authenticated;

revoke all on function public.native_sales_submit_base_v1(text,text,text,text) from public,anon,authenticated;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;req jsonb;doc jsonb;expected jsonb;cu jsonb;n uuid;op uuid;i uuid;d uuid;b uuid;k text;epoch bigint;role text;kind text;old public.native_sales_ledger_v1%rowtype;client public.clientes%rowtype;metadata public.native_customer_metadata_v1%rowtype;t public.native_sales_turns_v1%rowtype;cid uuid;turn uuid;rev bigint;bal_rev bigint;before bigint;amount bigint;delta bigint:=0;after bigint;seq bigint;clock_ms text;cash numeric;expected_cash numeric;receipt jsonb;effects jsonb;den jsonb;counted numeric;count_total numeric:=0;method text;concept text;phone text;wholesale boolean;limit_amount bigint;tier integer;note text;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;kind:=v->>'kind';
 if kind in('SALE_CONFIRM','TURN_OPEN') then return public.native_sales_submit_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end if;
 if kind is null or kind not in('CUSTOMER_CREATE','CUSTOMER_PATCH','CUSTOMER_DELETE','CREDIT_PAYMENT','EXPENSE_RECORD','CASH_ENTRY','CUT_X','TURN_CLOSE') or p_snapshot is not null or p_snapshot_hash is not null then raise exception 'NATIVE_KIND_INVALID';end if;
 if public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent) is distinct from p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 if v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or v->'expectedVersions' is distinct from '{}'::jsonb or v->'dependencies' is distinct from '[]'::jsonb then raise exception 'NATIVE_INTENT_INVALID';end if;
 perform public.native_sales_int_v1(v->'originAtUtcMs');n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;
 role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or (v->>'actorId')::uuid is distinct from auth.uid() or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role) or (kind<>'CREDIT_PAYMENT' and role not in('owner','admin')) then raise exception using errcode='42501',message='NATIVE_INTENT_CONTEXT_INVALID';end if;
 if not exists(select 1 from public.native_sales_mode_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b) then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is not null or old.snapshot_text is not null then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 req:=v->'payload'->'request';doc:=v->'payload'->'document';
 if req->>'operationId' is distinct from op::text or pg_catalog.jsonb_typeof(doc) is distinct from 'object' then raise exception 'NATIVE_REQUEST_INVALID';end if;
 turn:=(v->>'originalTurnId')::uuid;
 if kind not in('CUSTOMER_CREATE','CUSTOMER_PATCH','CUSTOMER_DELETE') then
  if req->>'turnId' is distinct from turn::text then raise exception 'NATIVE_TURN_CONTEXT_INVALID';end if;
  select * into t from public.native_sales_turns_v1 where negocio_id=n and turn_id=turn and scope_kind=k and sucursal_id is not distinct from b and status='OPEN' for update;if not found then raise exception 'NATIVE_TURN_REQUIRED';end if;
 elsif turn is not null then raise exception 'NATIVE_TURN_CONTEXT_INVALID';end if;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 if kind in('CUSTOMER_CREATE','CUSTOMER_PATCH','CUSTOMER_DELETE') then
  cid:=(req->>'customerId')::uuid;rev:=public.native_sales_int_v1(req->'expectedRevision')::bigint;
  select * into client from public.clientes where negocio_id=n and id=cid for update;
  select * into metadata from public.native_customer_metadata_v1 where negocio_id=n and cliente_id=cid for update;
  if kind='CUSTOMER_CREATE' then if rev<>0 or client.id is not null or req->>'kind' is distinct from 'CUSTOMER_SAVE' then raise exception 'NATIVE_CUSTOMER_VERSION';end if;
  else if client.id is null or coalesce(client.eliminado,false) or coalesce(metadata.revision,1)<>rev then raise exception 'NATIVE_CUSTOMER_VERSION';end if;end if;
  if kind='CUSTOMER_DELETE' then
   if exists(select 1 from public.native_sales_credit_v1 x where x.negocio_id=n and x.cliente_id=cid and x.balance_cents>0) then raise exception 'NATIVE_CREDIT_BALANCE_PENDING';end if;
   if req->>'kind' is distinct from 'CUSTOMER_DELETE' then raise exception 'NATIVE_REQUEST_INVALID';end if;
   cu:=pg_catalog.jsonb_build_object('id',cid,'name',client.nombre,'phone',case when metadata.cliente_id is null then pg_catalog.to_jsonb(client)->>'telefono' else metadata.phone end,'limitCents',(client.limite_credito*100)::bigint::text,'priceTier',coalesce(client.tipo_precio,1),'wholesale',coalesce(metadata.wholesale,(pg_catalog.to_jsonb(client)->>'al_por_mayor')::boolean,false),'active',false,'revision',(rev+1)::text);
  else
   if req->>'kind' is distinct from 'CUSTOMER_SAVE' or pg_catalog.jsonb_typeof(req->'wholesale') is distinct from 'boolean' or pg_catalog.jsonb_typeof(req->'priceTier') is distinct from 'number' then raise exception 'NATIVE_REQUEST_INVALID';end if;
   limit_amount:=public.native_sales_int_v1(req->'limitCents')::bigint;tier:=(req->>'priceTier')::integer;phone:=req->>'phone';wholesale:=(req->>'wholesale')::boolean;
   if tier not between 1 and 3 or pg_catalog.jsonb_typeof(req->'name') is distinct from 'string' or pg_catalog.length(req->>'name') not between 1 and 256 or pg_catalog.btrim(req->>'name')='' or req->>'name' ~ '[[:cntrl:]]' or pg_catalog.jsonb_typeof(req->'phone') not in('string','null') or (phone is not null and (pg_catalog.length(phone)>64 or phone ~ '[[:cntrl:]]')) then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   cu:=pg_catalog.jsonb_build_object('id',cid,'name',req->>'name','phone',phone,'limitCents',req->>'limitCents','priceTier',tier,'wholesale',wholesale,'active',true,'revision',(rev+1)::text);
  end if;
  expected:=pg_catalog.jsonb_build_object('customer',cu);if doc is distinct from expected then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
  if kind='CUSTOMER_CREATE' then
   if exists(select 1 from public.clientes where id=cid) then raise exception 'NATIVE_CUSTOMER_VERSION';end if;
   insert into public.clientes(id,negocio_id,nombre,limite_credito,tipo_precio,eliminado,fecha_actualizacion) values(cid,n,cu->>'name',(cu->>'limitCents')::numeric/100,(cu->>'priceTier')::integer,false,(v->>'originAtUtcMs')::bigint);
   insert into public.native_sales_credit_v1 values(n,cid,0,1);
  else update public.clientes set nombre=cu->>'name',limite_credito=(cu->>'limitCents')::numeric/100,tipo_precio=(cu->>'priceTier')::integer,eliminado=kind='CUSTOMER_DELETE' where id=cid and negocio_id=n;end if;
  insert into public.native_customer_metadata_v1 values(n,cid,cu->>'phone',(cu->>'wholesale')::boolean,rev+1) on conflict(negocio_id,cliente_id) do update set phone=excluded.phone,wholesale=excluded.wholesale,revision=excluded.revision;
 elsif kind in('CREDIT_PAYMENT','EXPENSE_RECORD','CASH_ENTRY') then
  if req->>'kind' is distinct from kind then raise exception 'NATIVE_REQUEST_INVALID';end if;
  amount:=public.native_sales_int_v1(req->'amountCents')::bigint;concept:=req->>'concept';method:=req->>'method';
  if amount<=0 or pg_catalog.jsonb_typeof(req->'concept') is distinct from 'string' or pg_catalog.length(concept) not between 1 and 256 or pg_catalog.btrim(concept)='' or concept ~ '[[:cntrl:]]' then raise exception 'NATIVE_AMOUNT_INVALID';end if;
  if kind='CASH_ENTRY' then
   if req->>'direction' is null or req->>'direction' not in('IN','OUT') then raise exception 'NATIVE_REQUEST_INVALID';end if;method:='EFECTIVO';delta:=case when req->>'direction'='IN' then amount else -amount end;
   expected:=pg_catalog.jsonb_build_object('amountCents',amount::text,'method',method,'concept',concept,'direction',req->>'direction','cashDeltaCents',delta::text);
  else
   if method is null or method not in('EFECTIVO','TARJETA','TRANSFERENCIA') then raise exception 'NATIVE_PAYMENT_INVALID';end if;
   delta:=case when method='EFECTIVO' then case when kind='CREDIT_PAYMENT' then amount else -amount end else 0 end;
   if kind='CREDIT_PAYMENT' then
    cid:=(req->>'customerId')::uuid;rev:=public.native_sales_int_v1(req->'expectedRevision')::bigint;
    select x.balance_cents,x.revision into before,bal_rev from public.native_sales_credit_v1 x join public.clientes c on c.id=x.cliente_id and c.negocio_id=x.negocio_id where x.negocio_id=n and x.cliente_id=cid and not coalesce(c.eliminado,false) for update of x;
    if before is null or bal_rev<>rev or before<amount then raise exception 'NATIVE_CREDIT_OVERPAY_OR_VERSION';end if;after:=before-amount;
    expected:=pg_catalog.jsonb_build_object('customerId',cid,'balanceBeforeCents',before::text,'balanceAfterCents',after::text,'balanceRevision',(rev+1)::text,'amountCents',amount::text,'method',method,'concept',concept,'cashDeltaCents',delta::text);
    update public.native_sales_credit_v1 set balance_cents=after,revision=revision+1 where negocio_id=n and cliente_id=cid;
   else if req ? 'category' and (req->>'category' is null or req->>'category' not in('mercancia','servicios','alquiler','sueldos','transporte','otro')) then raise exception 'NATIVE_REQUEST_INVALID';end if;expected:=pg_catalog.jsonb_build_object('amountCents',amount::text,'method',method,'concept',concept,'category',coalesce(req->'category','null'::jsonb),'cashDeltaCents',delta::text);end if;
  end if;
  if doc is distinct from expected then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
  select c.last_sequence into seq from public.native_sales_counter_v1 c where c.negocio_id=n;
  cash:=(public.native_cash_base_v1(n,k,b,seq)->>'netCents')::numeric;
  if cash is null or pg_catalog.abs(t.opening_cents+cash+delta)>9007199254740991 then raise exception 'NATIVE_CASH_OVERFLOW';end if;
 elsif kind in('CUT_X','TURN_CLOSE') then
  if req->>'kind' is distinct from kind then raise exception 'NATIVE_REQUEST_INVALID';end if;
  counted:=public.native_sales_int_v1(req->'countedCents');
  if pg_catalog.jsonb_typeof(req->'denominations') is distinct from 'array' or pg_catalog.jsonb_array_length(req->'denominations')>20 then raise exception 'NATIVE_COUNT_INVALID';end if;
  if (select count(distinct value->>'valueCents') from pg_catalog.jsonb_array_elements(req->'denominations'))<>pg_catalog.jsonb_array_length(req->'denominations') then raise exception 'NATIVE_COUNT_INVALID';end if;
  for den in select value from pg_catalog.jsonb_array_elements(req->'denominations') loop
   cash:=public.native_sales_int_v1(den->'valueCents');if cash not in(1,5,10,25,50,100,500,1000,2500,5000,10000,20000,50000,100000,200000) then raise exception 'NATIVE_COUNT_INVALID';end if;count_total:=count_total+cash*public.native_sales_int_v1(den->'count');
  end loop;
  if pg_catalog.jsonb_array_length(req->'denominations')>0 and count_total<>counted then raise exception 'NATIVE_COUNT_INVALID';end if;
  select coalesce(sum((e.payload->>'amountCents')::numeric),0) into cash from public.native_sales_effects_v1 e where e.negocio_id=n and e.kind='CASH' and e.payload->>'turnId'=turn::text;
  select cash+coalesce(sum((r.document->>'cashDeltaCents')::numeric),0) into cash from public.native_management_records_v1 r where r.negocio_id=n and r.turn_id=turn and r.document ? 'cashDeltaCents';expected_cash:=t.opening_cents+cash;
  if pg_catalog.abs(expected_cash)>9007199254740991 or doc->'drawer'->>'turnId' is distinct from turn::text or doc->'drawer'->>'status' is distinct from 'OPEN' or doc->'drawer'->>'openingCents' is distinct from t.opening_cents::text or doc->'drawer'->>'openedAtMs' is distinct from t.opened_at_ms or doc->'drawer'->>'netCashCents' is distinct from cash::bigint::text or doc->'drawer'->>'expectedCents' is distinct from expected_cash::bigint::text or doc->>'countedCents' is distinct from counted::bigint::text or doc->>'differenceCents' is distinct from (counted-expected_cash)::bigint::text or doc->'denominations' is distinct from req->'denominations' or doc->'notes' is distinct from coalesce(req->'notes','null'::jsonb) then raise exception 'NATIVE_CASH_VERSION';end if;
  note:=req->>'notes';if note is not null and pg_catalog.length(note)>1000 then raise exception 'NATIVE_REQUEST_INVALID';end if;
  if kind='TURN_CLOSE' then update public.native_sales_turns_v1 set status='CLOSED',revision=revision+1 where negocio_id=n and turn_id=turn;end if;
 end if;
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;
 if seq is null then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text;
 effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'management'),'kind',kind,'payload',doc));
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',null,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',null,'ncf',null,'totalCents',null,'effects',effects,'stock','[]'::jsonb);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,kind,p_intent,p_hash,null,null,null,null,seq,receipt);
 insert into public.native_sales_effects_v1 values(n,op,public.native_sales_effect_id_v1(op,'management'),kind,doc);
 insert into public.native_management_records_v1 values(n,op,k,b,kind,turn,cid,method,coalesce(amount,0),coalesce(concept,kind),v->>'originAtUtcMs',doc);
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;
 return receipt;
end $f$;
revoke all on function public.native_sales_submit_v1(text,text,text,text) from public,anon;
grant execute on function public.native_sales_submit_v1(text,text,text,text) to authenticated;
create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare m public.native_sales_mode_v1%rowtype;old public.native_sales_snapshots_v1%rowtype;rows jsonb;batch jsonb;pages jsonb:='[]';header jsonb;payload text;idx integer:=0;cnt integer;at_ms bigint;watermark bigint;last_ticket bigint;turn_event jsonb;
begin
 perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if p_snapshot_id is null then raise exception 'NATIVE_SNAPSHOT_ID_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||p_negocio_id::text,0));
 select * into old from public.native_sales_snapshots_v1 x where x.negocio_id=p_negocio_id and x.snapshot_id=p_snapshot_id;
 if found then
  if old.actor_id is distinct from auth.uid() or old.installation_id is distinct from p_installation_id or old.device_id is distinct from p_device_id or old.writer_epoch is distinct from p_writer_epoch or old.scope_kind is distinct from p_scope_kind or old.sucursal_id is distinct from p_sucursal_id then raise exception using errcode='42501',message='NATIVE_SNAPSHOT_CONTEXT_DENIED';end if;
  return old.manifest;
 end if;
 select * into m from public.native_sales_mode_v1 x where x.negocio_id=p_negocio_id and x.scope_kind=p_scope_kind and x.sucursal_id is not distinct from p_sucursal_id;
 if not found then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 -- Legacy direct changes are fenced, and native writers share the tenant lock.
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_venta is null or p.precio_venta<0 or p.precio_venta*100<>pg_catalog.trunc(p.precio_venta*100) or p.precio_venta*100>9007199254740991 or p.costo<0 or p.costo*100<>pg_catalog.trunc(p.costo*100) or p.tasa_itbis is null or p.tasa_itbis not between 0 and 1 or p.tasa_itbis*100<>pg_catalog.trunc(p.tasa_itbis*100))) then raise exception 'NATIVE_PRODUCT_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.composiciones c where c.negocio_id=p_negocio_id and (c.cantidad_necesaria is null or c.cantidad_necesaria<=0 or c.cantidad_necesaria*1000<>pg_catalog.trunc(c.cantidad_necesaria*1000))) then raise exception 'NATIVE_RECIPE_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_2<0 or p.precio_3<0 or p.precio_2*100<>pg_catalog.trunc(p.precio_2*100) or p.precio_3*100<>pg_catalog.trunc(p.precio_3*100) or p.precio_2*100>9007199254740991 or p.precio_3*100>9007199254740991)) then raise exception 'NATIVE_PRICE_TIER_UNVERIFIABLE';end if;
 if exists(select 1 from public.seriales s where s.negocio_id=p_negocio_id and (s.estado is null or s.estado not in('disponible','vendido','reservado'))) then raise exception 'NATIVE_SERIAL_SOURCE_UNVERIFIABLE';end if;
 select x.last_sequence into watermark from public.native_sales_counter_v1 x where x.negocio_id=p_negocio_id;
 select coalesce(max(pg_catalog.split_part(x.ticket,'-',2)::bigint),0) into last_ticket from public.native_sales_ledger_v1 x where x.negocio_id=p_negocio_id and x.installation_id=p_installation_id and x.writer_epoch=p_writer_epoch and x.ticket is not null;
 select pg_catalog.jsonb_build_object('receipt',l.receipt,'intent',l.intent_text,'snapshot',l.snapshot_text) into turn_event from public.native_sales_turns_v1 t join public.native_sales_ledger_v1 l on l.negocio_id=t.negocio_id and l.operation_id=t.turn_id where t.negocio_id=p_negocio_id and t.scope_kind=p_scope_kind and t.sucursal_id is not distinct from p_sucursal_id and t.status='OPEN';
 select coalesce(pg_catalog.jsonb_agg(v order by kind,id),'[]'::jsonb) into rows from (
  select 'PRODUCT' kind,p.id::text id,pg_catalog.jsonb_build_object('kind','PRODUCT','id',p.id,'name',p.nombre,'code',p.codigo_barras,'revision','1','deleted',coalesce(p.eliminado,false),'priceTiers',pg_catalog.jsonb_build_object('retailCents',(p.precio_venta*100)::bigint::text,'tier2Cents',(p.precio_2*100)::bigint::text,'tier3Cents',(p.precio_3*100)::bigint::text),'metadata',pg_catalog.jsonb_build_object('costCents',(p.costo*100)::bigint::text,'taxRate',pg_catalog.jsonb_build_object('numerator',(p.tasa_itbis*100)::bigint::text,'denominator','100'),'serialRequired',coalesce(p.serializable,false),'recipe',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productId',c.insumo_id,'perUnit',pg_catalog.jsonb_build_object('numerator',(c.cantidad_necesaria*1000)::bigint::text,'denominator','1000'),'revision','1') order by c.insumo_id) from public.composiciones c where c.negocio_id=p_negocio_id and c.producto_padre_id=p.id),'[]'::jsonb)),'stock',pg_catalog.jsonb_build_object('quantity',case when p_scope_kind='GLOBAL' then p.stock_actual::text else inv.stock_actual::text end,'version',st.revision::text,'authority',case when st.revision is null or (p_scope_kind='BRANCH' and inv.stock_actual is null) then 'UNKNOWN' when p_scope_kind='BRANCH' and p.stock_actual is distinct from (select sum(z.stock_actual) from public.inventario_sucursales z where z.producto_id=p.id) then 'DIVERGED' else 'VERIFIED' end)) v from public.productos p left join public.inventario_sucursales inv on inv.producto_id=p.id and inv.sucursal_id=p_sucursal_id left join public.native_sales_stock_v1 st on st.negocio_id=p_negocio_id and st.producto_id=p.id and st.scope_kind=p_scope_kind and st.sucursal_id is not distinct from p_sucursal_id where p.negocio_id=p_negocio_id
  union all select 'CUSTOMER',c.id::text,pg_catalog.jsonb_build_object('kind','CUSTOMER','id',c.id,'name',c.nombre,'balanceCents',x.balance_cents::text,'limitCents',(c.limite_credito*100)::bigint::text,'active',not coalesce(c.eliminado,false),'revision',x.revision::text,'priceTier',coalesce(c.tipo_precio,1)::text,'metadataRevision',coalesce((select cm.revision::text from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id),'1'),'phone',case when exists(select 1 from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id) then (select cm.phone from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id) else pg_catalog.to_jsonb(c)->>'telefono' end,'wholesale',coalesce((select cm.wholesale from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id),(pg_catalog.to_jsonb(c)->>'al_por_mayor')::boolean,false)) from public.clientes c join public.native_sales_credit_v1 x on x.negocio_id=c.negocio_id and x.cliente_id=c.id where c.negocio_id=p_negocio_id
  union all select 'SERIAL',s.id::text,pg_catalog.jsonb_build_object('kind','SERIAL','productId',s.producto_id,'text',s.numero_serial,'revision','1','state',case s.estado when 'disponible' then 'AVAILABLE' when 'reservado' then 'RESERVED' else 'SOLD' end) from public.seriales s where s.negocio_id=p_negocio_id
 ) q;
 cnt:=pg_catalog.jsonb_array_length(rows);if cnt>60000 then raise exception 'NATIVE_BOOTSTRAP_SIZE';end if;
 at_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint;
 header:=pg_catalog.jsonb_build_object('version','ventard.native.operational.1','namespace','NATIVE1','snapshotId',p_snapshot_id,'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'deviceId',p_device_id,'installationId',p_installation_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),'capturedAtMs',at_ms::text,'expiresAtMs',(at_ms+86400000)::text,'coverage','CLOUD_ADOPTED_V1','watermark',watermark::text,'totalCount',cnt,'ticketPrefix','N'||pg_catalog.replace(p_installation_id::text,'-',''),'lastTicket',last_ticket::text,'freeTax',pg_catalog.jsonb_build_object('numerator',(m.free_tax*100)::bigint::text,'denominator','100'),'turn',turn_event,'business',(select pg_catalog.jsonb_build_object('name',g.nombre,'rnc',pg_catalog.to_jsonb(g)->>'rnc','address',pg_catalog.to_jsonb(g)->>'direccion','phone',pg_catalog.to_jsonb(g)->>'telefono','footer',pg_catalog.to_jsonb(g)->>'mensaje_ticket') from public.negocios g where g.id=p_negocio_id),'cashBase',public.native_cash_base_v1(p_negocio_id,p_scope_kind,p_sucursal_id,watermark),'pages','[]'::jsonb);
 insert into public.native_sales_snapshots_v1 values(p_negocio_id,p_snapshot_id,auth.uid(),p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,header,at_ms+86400000);
 for batch in select pg_catalog.jsonb_agg(value order by ordinality) from pg_catalog.jsonb_array_elements(rows) with ordinality group by ((ordinality-1)/200) order by ((ordinality-1)/200) loop
  payload:=public.native_sales_canonical_v1(batch);if pg_catalog.octet_length(payload)>1048576 then raise exception 'NATIVE_BOOTSTRAP_PAGE_SIZE';end if;
  pages:=pages||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',idx,'count',pg_catalog.jsonb_array_length(batch),'byteLength',pg_catalog.octet_length(payload),'sha256',public.native_sales_hash_v1(payload)));
  insert into public.native_sales_pages_v1 values(p_negocio_id,p_snapshot_id,idx,payload);idx:=idx+1;
 end loop;
 header:=pg_catalog.jsonb_set(header,'{pages}',pages);update public.native_sales_snapshots_v1 set manifest=header where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;return header;
end $f$;

create or replace function public.native_sales_feed_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_after bigint) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare events jsonb;scanned bigint;watermark bigint;
begin perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 select last_sequence into watermark from public.native_sales_counter_v1 where negocio_id=p_negocio_id;if watermark is null or p_after<0 or p_after>watermark then raise exception 'NATIVE_FEED_CURSOR_INVALID';end if;
 with scanned as materialized(select * from public.native_sales_ledger_v1 where negocio_id=p_negocio_id and remote_sequence>p_after order by remote_sequence limit 200)
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('receipt',receipt,'intent',intent_text,'snapshot',snapshot_text) order by remote_sequence) filter(where scope_kind=p_scope_kind and sucursal_id is not distinct from p_sucursal_id),'[]'::jsonb),coalesce(max(remote_sequence),watermark) into events,scanned from scanned;
 return pg_catalog.jsonb_build_object('namespace','NATIVE1','tenantId',p_negocio_id,'scope',pg_catalog.jsonb_build_object('type',p_scope_kind,'branchId',p_sucursal_id),'coverage','COMPLETE','scannedThrough',scanned::text,'watermark',watermark::text,'events',events,'cashBase',public.native_cash_base_v1(p_negocio_id,p_scope_kind,p_sucursal_id,scanned),'business',(select pg_catalog.jsonb_build_object('name',g.nombre,'rnc',pg_catalog.to_jsonb(g)->>'rnc','address',pg_catalog.to_jsonb(g)->>'direccion','phone',pg_catalog.to_jsonb(g)->>'telefono','footer',pg_catalog.to_jsonb(g)->>'mensaje_ticket') from public.negocios g where g.id=p_negocio_id));end $f$;
-- Immutable operational captures, NOT an upgrade of catalogue preview.
-- Only synthetic adopted facts; clients cannot activate modes or mint receipts.

-- Source: 20261012031553_native_inventory_staging_v1.sql SHA256 a7800809dd9ae59605bc8be3f65718ef0c7ea173b91148603735d0d6525c0ef8
do $guard$ begin

end $guard$;
create table if not exists public.native_product_metadata_v1(negocio_id uuid not null,producto_id uuid not null,revision bigint not null check(revision>0),location text not null,minimum integer not null check(minimum>=0),primary key(negocio_id,producto_id));
alter table public.native_product_metadata_v1 enable row level security;
revoke all on public.native_product_metadata_v1 from public,anon,authenticated;
create or replace function public.native_product_cost_v1(n uuid,pid uuid) returns numeric language sql stable security definer set search_path='' as $f$
 select case when p.tipo='combo' and exists(select 1 from public.native_product_metadata_v1 m where m.negocio_id=n and m.producto_id=pid) then
 (select case when count(*)>0 and count(z.costo)=count(*) and sum(z.costo*100*c.cantidad_necesaria)=pg_catalog.trunc(sum(z.costo*100*c.cantidad_necesaria)) and sum(z.costo*100*c.cantidad_necesaria)<=9007199254740991 then sum(z.costo*100*c.cantidad_necesaria) else null end from public.composiciones c join public.productos z on z.id=c.insumo_id and z.negocio_id=n where c.negocio_id=n and c.producto_padre_id=pid)
 else p.costo*100 end from public.productos p where p.negocio_id=n and p.id=pid
 $f$;
revoke all on function public.native_product_cost_v1(uuid,uuid) from public,anon,authenticated;

create or replace function public.native_inventory_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
#variable_conflict use_variable
declare v jsonb;req jsonb;doc jsonb;def jsonb;expected jsonb;meta jsonb;prices jsonb;recipe jsonb:='[]';part jsonb;ingredient public.productos%rowtype;product public.productos%rowtype;old public.native_sales_ledger_v1%rowtype;
 n uuid;op uuid;i uuid;d uuid;b uuid;k text;epoch bigint;role text;kind text;pid uuid;rev bigint;percent bigint;g bigint;num bigint;den bigint;price bigint;cost bigint;tier2 bigint;tier3 bigint;minimum integer;ptype text;serializable boolean;loc text;code text;name text;seq bigint;clock_ms text;effects jsonb;stock jsonb:='[]';receipt jsonb;proof jsonb;pend jsonb;cur integer;after integer;delta integer;version bigint;expected_version bigint;projection numeric;effective numeric;qty integer;mode text;reason text;serial jsonb;sn text;serial_count integer;newserials jsonb:='[]';expected_cost numeric:=0;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;kind:=v->>'kind';
 if kind is null or kind not in('PRODUCT_CREATE','PRODUCT_PATCH','PRODUCT_DELETE','INVENTORY_DELTA','INVENTORY_COUNT') or p_snapshot is not null or p_snapshot_hash is not null then raise exception 'NATIVE_KIND_INVALID';end if;
 if public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent) is distinct from p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 if v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or v->'expectedVersions' is distinct from '{}'::jsonb or v->'dependencies' is distinct from '[]'::jsonb or v->>'originalTurnId' is not null then raise exception 'NATIVE_INTENT_INVALID';end if;
 perform public.native_sales_int_v1(v->'originAtUtcMs');n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;
 role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or (v->>'actorId')::uuid is distinct from auth.uid() or role not in('owner','admin') or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role) then raise exception using errcode='42501',message='NATIVE_INTENT_CONTEXT_INVALID';end if;
 if not exists(select 1 from public.native_sales_mode_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b) then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is not null or old.snapshot_text is not null then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 perform public.native_sales_object_v1(v->'payload',array['request','document']);req:=v->'payload'->'request';doc:=v->'payload'->'document';
 if req->>'operationId' is distinct from op::text or pg_catalog.jsonb_typeof(doc) is distinct from 'object' then raise exception 'NATIVE_REQUEST_INVALID';end if;
 pid:=(req->>'productId')::uuid;if pid is null then raise exception 'NATIVE_REQUEST_INVALID';end if;
 select * into product from public.productos where negocio_id=n and id=pid for update;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 if kind in('PRODUCT_CREATE','PRODUCT_PATCH','PRODUCT_DELETE') then
  rev:=public.native_sales_int_v1(req->'expectedRevision')::bigint;
  if kind='PRODUCT_CREATE' then if rev<>0 or product.id is not null or exists(select 1 from public.productos where id=pid) then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;
  else if product.id is null or coalesce(product.eliminado,false) or rev<>coalesce((select pm.revision from public.native_product_metadata_v1 pm where pm.negocio_id=n and pm.producto_id=pid),1) then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;end if;
  if kind='PRODUCT_DELETE' then
   perform public.native_sales_object_v1(req,array['kind','operationId','productId','expectedRevision']);if req->>'kind' is distinct from 'PRODUCT_DELETE' or exists(select 1 from public.composiciones c join public.productos p on p.id=c.producto_padre_id where c.negocio_id=n and c.insumo_id=pid and not coalesce(p.eliminado,false)) then raise exception 'NATIVE_PRODUCT_RECIPE_IN_USE';end if;
   -- Compare unchanged historical fields; deletion retains stock and composition rows.
   if doc->'product'->>'id' is distinct from pid::text or doc->'product'->>'revision' is distinct from (rev+1)::text or doc->'product'->'deleted' is distinct from 'true'::jsonb or doc->'product'->>'name' is distinct from product.nombre or doc->'product'->>'code' is distinct from coalesce(product.codigo_barras,'') or (doc->'product'->'priceTiers'->>'retailCents')::numeric is distinct from product.precio_venta*100 or (doc->'product'->'metadata'->>'costCents')::numeric is distinct from product.costo*100 then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
   update public.productos set eliminado=true,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;
   insert into public.native_product_metadata_v1 values(n,pid,rev+1,coalesce(doc->'product'->'metadata'->>'location',''),coalesce((doc->'product'->'metadata'->>'minimum')::integer,0)) on conflict(negocio_id,producto_id) do update set revision=excluded.revision;
  else
   perform public.native_sales_object_v1(req,array['kind','operationId','productId','expectedRevision','definition']);if req->>'kind' is distinct from 'PRODUCT_SAVE' then raise exception 'NATIVE_REQUEST_INVALID';end if;def:=req->'definition';
   perform public.native_sales_object_v1(def,array['name','code','priceCents','tier2Cents','tier3Cents','costCents','taxPercent','productType','location','minimum','serialRequired','recipe']);
   name:=def->>'name';code:=def->>'code';loc:=def->>'location';ptype:=def->>'productType';
   if pg_catalog.jsonb_typeof(def->'name') is distinct from 'string' or pg_catalog.length(name) not between 1 and 256 or pg_catalog.btrim(name)<>name or name ~ '[[:cntrl:]]' or pg_catalog.jsonb_typeof(def->'code') is distinct from 'string' or pg_catalog.length(code)>64 or pg_catalog.btrim(code)<>code or code ~ '[[:cntrl:]]' or pg_catalog.jsonb_typeof(def->'location') is distinct from 'string' or pg_catalog.length(loc)>256 or pg_catalog.btrim(loc)<>loc or loc ~ '[[:cntrl:]]' or ptype is null or ptype not in('simple','insumo','combo') or pg_catalog.jsonb_typeof(def->'serialRequired') is distinct from 'boolean' then raise exception 'NATIVE_REQUEST_INVALID';end if;
   if code<>'' and exists(select 1 from public.productos where negocio_id=n and codigo_barras=code and id<>pid and not coalesce(eliminado,false)) then raise exception 'NATIVE_PRODUCT_CODE_EXISTS';end if;
   price:=public.native_sales_int_v1(def->'priceCents',999999999999)::bigint;cost:=public.native_sales_int_v1(def->'costCents',999999999999)::bigint;minimum:=public.native_sales_int_v1(def->'minimum',2147483647)::integer;percent:=public.native_sales_int_v1(def->'taxPercent',100)::bigint;
   if def->'tier2Cents'<>'null'::jsonb then tier2:=public.native_sales_int_v1(def->'tier2Cents')::bigint;end if;if def->'tier3Cents'<>'null'::jsonb then tier3:=public.native_sales_int_v1(def->'tier3Cents')::bigint;end if;
   serializable:=(def->>'serialRequired')::boolean;if serializable and ptype<>'simple' then raise exception 'NATIVE_PRODUCT_TYPE_IN_USE';end if;
   if kind='PRODUCT_PATCH' and (coalesce(product.serializable,false)<>serializable or (product.tipo='combo')<>(ptype='combo')) and (coalesce(product.stock_actual,0)<>0 or exists(select 1 from public.seriales where negocio_id=n and producto_id=pid) or exists(select 1 from public.composiciones where negocio_id=n and insumo_id=pid)) then raise exception 'NATIVE_PRODUCT_TYPE_IN_USE';end if;
   if pg_catalog.jsonb_typeof(def->'recipe') is distinct from 'array' or pg_catalog.jsonb_array_length(def->'recipe')>100 or (ptype='combo')<>(pg_catalog.jsonb_array_length(def->'recipe')>0) or (select count(distinct x->>'productId') from pg_catalog.jsonb_array_elements(def->'recipe') x)<>pg_catalog.jsonb_array_length(def->'recipe') then raise exception 'NATIVE_RECIPE_INVALID';end if;
   for part in select value from pg_catalog.jsonb_array_elements(def->'recipe') order by value->>'productId' loop
    perform public.native_sales_object_v1(part,array['productId','numerator','denominator']);select * into ingredient from public.productos where negocio_id=n and id=(part->>'productId')::uuid;
    num:=public.native_sales_int_v1(part->'numerator',999999999999)::bigint;den:=public.native_sales_int_v1(part->'denominator',10000)::bigint;
    if ingredient.id is null or ingredient.id=pid or coalesce(ingredient.eliminado,false) or coalesce(ingredient.serializable,false) or ingredient.tipo='combo' or num=0 or den=0 or 10000%den<>0 or pg_catalog.gcd(num,den)<>1 or num::numeric/den>99999999.9999 then raise exception 'NATIVE_RECIPE_INVALID';end if;
    expected_cost:=expected_cost+ingredient.costo*100*num/den;
    recipe:=recipe||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',ingredient.id,'perUnit',pg_catalog.jsonb_build_object('numerator',num::text,'denominator',den::text),'revision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=n and pm.producto_id=ingredient.id),'1')));
   end loop;
   if ptype='combo' and (expected_cost<>pg_catalog.trunc(expected_cost) or cost is distinct from expected_cost::bigint) then raise exception 'NATIVE_RECIPE_COST_INVALID';end if;
   g:=pg_catalog.gcd(percent,100::bigint);prices:=pg_catalog.jsonb_build_object('retailCents',price::text,'tier2Cents',tier2::text,'tier3Cents',tier3::text);
   meta:=pg_catalog.jsonb_build_object('costCents',cost::text,'taxRate',pg_catalog.jsonb_build_object('numerator',(percent/g)::text,'denominator',(100/g)::text),'serialRequired',serializable,'recipe',recipe,'productType',ptype,'recipeCostPolicy',case when ptype='combo' then 'NATIVE_EXACT' else 'DECLARED' end,'location',loc,'minimum',minimum::text);
   expected:=pg_catalog.jsonb_build_object('product',pg_catalog.jsonb_build_object('id',pid,'name',name,'code',code,'revision',(rev+1)::text,'deleted',false,'priceTiers',prices,'metadata',meta));
   if doc is distinct from expected then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
   if kind='PRODUCT_CREATE' then
    insert into public.productos(id,negocio_id,nombre,codigo_barras,precio_venta,precio_2,precio_3,costo,stock_actual,stock_minimo,tasa_itbis,tipo,serializable,ubicacion,eliminado,fecha_actualizacion) values(pid,n,name,code,price::numeric/100,tier2::numeric/100,tier3::numeric/100,cost::numeric/100,0,minimum,percent::numeric/100,ptype,serializable,loc,false,(v->>'originAtUtcMs')::bigint);
    if k='BRANCH' then insert into public.inventario_sucursales(sucursal_id,producto_id,stock_actual,stock_minimo,fecha_actualizacion) values(b,pid,0,minimum,(v->>'originAtUtcMs')::bigint);end if;
   else
    update public.productos set nombre=name,codigo_barras=code,precio_venta=price::numeric/100,precio_2=tier2::numeric/100,precio_3=tier3::numeric/100,costo=cost::numeric/100,stock_minimo=minimum,tasa_itbis=percent::numeric/100,tipo=ptype,serializable=serializable,ubicacion=loc,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;
   end if;
   delete from public.composiciones where negocio_id=n and producto_padre_id=pid;
   for part in select value from pg_catalog.jsonb_array_elements(def->'recipe') loop insert into public.composiciones(id,negocio_id,producto_padre_id,insumo_id,cantidad_necesaria) values(public.native_sales_effect_id_v1(op,'recipe/'||(part->>'productId')),n,pid,(part->>'productId')::uuid,(part->>'numerator')::numeric/(part->>'denominator')::numeric);end loop;
   insert into public.native_product_metadata_v1 values(n,pid,rev+1,loc,minimum) on conflict(negocio_id,producto_id) do update set revision=excluded.revision,location=excluded.location,minimum=excluded.minimum;
  end if;
 else
  perform public.native_sales_object_v1(req,array['kind','operationId','productId','expectedStockRevision','mode','quantity','reason','serials']);if req->>'kind' is distinct from 'INVENTORY_CHANGE' or product.id is null or coalesce(product.eliminado,false) or product.tipo='combo' then raise exception 'NATIVE_REQUEST_INVALID';end if;
  qty:=public.native_sales_int_v1(req->'quantity',2147483647)::integer;mode:=req->>'mode';reason:=req->>'reason';
  if mode is null or mode not in('IN','LOSS','COUNT') or (mode<>'COUNT' and qty=0) or pg_catalog.jsonb_typeof(req->'reason') is distinct from 'string' or pg_catalog.length(reason) not between 1 and 256 or pg_catalog.btrim(reason)<>reason or reason ~ '[[:cntrl:]]' or (kind='INVENTORY_COUNT')<>(mode='COUNT') then raise exception 'NATIVE_REQUEST_INVALID';end if;
  proof:=doc->'stockEvidence';perform public.native_sales_object_v1(proof,array['productId','remoteBaseQty','remoteSequence','pending','effectiveQty']);
  if proof->>'productId' is distinct from pid::text or pg_catalog.jsonb_typeof(proof->'pending') is distinct from 'array' or pg_catalog.jsonb_array_length(proof->'pending')>1000 or (select count(distinct x->>'effectId') from pg_catalog.jsonb_array_elements(proof->'pending') x)<>pg_catalog.jsonb_array_length(proof->'pending') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
  expected_version:=public.native_sales_int_v1(proof->'remoteSequence')::bigint;
  select revision into version from public.native_sales_stock_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid for update;if not found then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
  if k='BRANCH' then select stock_actual into cur from public.inventario_sucursales where sucursal_id=b and producto_id=pid for update;else cur:=product.stock_actual;end if;if cur is null then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
  effective:=public.native_sales_int_v1(proof->'remoteBaseQty',2147483647);
  for pend in select value from pg_catalog.jsonb_array_elements(proof->'pending') loop
   select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=(pend->>'operationId')::uuid and installation_id=i and scope_kind=k and sucursal_id is not distinct from b;
   if not found or not exists(select 1 from public.native_sales_effects_v1 x where x.negocio_id=n and x.operation_id=old.operation_id and x.effect_id=(pend->>'effectId')::uuid and x.kind='STOCK' and x.payload->>'productId'=pid::text and x.payload->>'delta'=pend->>'delta') then raise exception 'NATIVE_PENDING_COVERAGE_INVALID';end if;
   effective:=effective+(pend->>'delta')::integer;expected_version:=greatest(expected_version,old.remote_sequence);
  end loop;
  if version<>expected_version or effective<>cur or public.native_sales_int_v1(proof->'effectiveQty',2147483647)<>cur or req->>'expectedStockRevision' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object('quantity',proof->>'effectiveQty','remoteSequence',proof->>'remoteSequence','pending',proof->'pending'))) then raise exception 'NATIVE_STOCK_VERSION_CONFLICT';end if;
  delta:=case mode when 'IN' then qty when 'LOSS' then -qty else qty-cur end;after:=cur+delta;if after<0 then raise exception 'NATIVE_STOCK_UNAVAILABLE';end if;
  if pg_catalog.jsonb_typeof(req->'serials') is distinct from 'array' or pg_catalog.jsonb_array_length(req->'serials')>1000 then raise exception 'NATIVE_SERIAL_INVALID';end if;serial_count:=pg_catalog.jsonb_array_length(req->'serials');
  if coalesce(product.serializable,false) then if mode<>'IN' or serial_count<>qty then raise exception 'NATIVE_SERIAL_INVALID';end if;else if serial_count<>0 then raise exception 'NATIVE_SERIAL_INVALID';end if;end if;
  for serial in select value from pg_catalog.jsonb_array_elements(req->'serials') loop sn:=serial#>>'{}';if pg_catalog.jsonb_typeof(serial) is distinct from 'string' or pg_catalog.length(sn) not between 1 and 128 or sn<>pg_catalog.btrim(sn) or sn ~ '[[:cntrl:]]' or newserials @> pg_catalog.jsonb_build_array(sn) or exists(select 1 from public.seriales where negocio_id=n and numero_serial=sn) then raise exception 'NATIVE_SERIAL_INVALID';end if;newserials:=newserials||pg_catalog.jsonb_build_array(sn);end loop;
  expected:=pg_catalog.jsonb_build_object('productId',pid,'productRevision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=n and pm.producto_id=pid),'1'),'delta',delta::text,'before',cur::text,'after',after::text,'mode',mode,'reason',reason,'serials',req->'serials','stockEvidence',proof);
  if doc is distinct from expected then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
  if k='BRANCH' then
   if exists(select 1 from public.inventario_sucursales z left join public.sucursales br on br.id=z.sucursal_id where z.producto_id=pid and br.negocio_id is distinct from n) then raise exception 'NATIVE_STOCK_SOURCE_UNVERIFIABLE';end if;
   select sum(stock_actual) into projection from public.inventario_sucursales where producto_id=pid;if projection is distinct from product.stock_actual::numeric then raise exception 'AUTHORITY_PROJECTION_DIVERGED';end if;
   update public.inventario_sucursales set stock_actual=after,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where sucursal_id=b and producto_id=pid;
   update public.productos set stock_actual=(projection+delta)::integer,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;
  else update public.productos set stock_actual=after,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;end if;
  for serial in select value from pg_catalog.jsonb_array_elements(req->'serials') loop sn:=serial#>>'{}';insert into public.seriales(id,negocio_id,producto_id,numero_serial,estado,fecha_actualizacion) values(public.native_sales_effect_id_v1(op,'serial/'||sn),n,pid,sn,'disponible',(v->>'originAtUtcMs')::bigint);end loop;
 end if;
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;
 effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'management'),'kind',kind,'payload',doc));
 if kind='PRODUCT_CREATE' then insert into public.native_sales_stock_v1(negocio_id,scope_kind,sucursal_id,producto_id,revision) values(n,k,b,pid,seq);delta:=0;after:=0;end if;
 if kind='PRODUCT_CREATE' or kind in('INVENTORY_DELTA','INVENTORY_COUNT') then
  update public.native_sales_stock_v1 set revision=seq where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid;
  effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'stock/'||pid::text),'kind','STOCK','payload',pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text)));
  stock:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'after',after::text,'version',seq::text));
 end if;
 clock_ms:=(pg_catalog.trunc(extract(epoch from pg_catalog.clock_timestamp())*1000))::bigint::text;
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',null,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',null,'ncf',null,'totalCents',null,'effects',effects,'stock',stock);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,kind,p_intent,p_hash,null,null,null,null,seq,receipt);
 for part in select value from pg_catalog.jsonb_array_elements(effects) loop insert into public.native_sales_effects_v1 values(n,op,(part->>'id')::uuid,part->>'kind',part->'payload');end loop;
 insert into public.native_management_records_v1 values(n,op,k,b,kind,null,null,null,0,coalesce(reason,kind),v->>'originAtUtcMs',doc);
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;return receipt;
end $f$;
revoke all on function public.native_inventory_submit_v1(text,text,text,text) from public,anon,authenticated;

create or replace function public.native_sales_submit_base_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;s jsonb;doc jsonb;pay jsonb;n uuid;op uuid;i uuid;d uuid;b uuid;k text;epoch bigint;role text;old public.native_sales_ledger_v1%rowtype;
 mode public.native_sales_mode_v1%rowtype;ln jsonb;eff jsonb;proof jsonb;pend jsonb;product public.productos%rowtype;pid uuid;qty numeric;price numeric;rate numeric;sub numeric:=0;tax numeric:=0;disc numeric;total numeric;cash numeric;credit numeric;transfer numeric;card numeric;tender numeric;change numeric;debt numeric;limit_credit numeric;cid uuid;turn uuid;seq bigint;cur integer;after integer;version bigint;expected_version bigint;delta integer;stock jsonb:='[]';effects jsonb:='[]';eid uuid;clock_ms text;receipt jsonb;expected jsonb:='{}';part jsonb;ingredient uuid;part_qty numeric;num numeric;den numeric;method text;serial jsonb;rows_n integer;sn text;ncftype text;ncfnum bigint;own_projection numeric;price_base numeric;tier integer;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 or (p_snapshot is not null and pg_catalog.octet_length(p_snapshot)>1048576) then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;if public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent)<>p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 perform public.native_sales_int_v1(v->'originAtUtcMs');
 if p_hash is null or p_hash!~'^[0-9a-f]{64}$' or pg_catalog.jsonb_typeof(v->'dependencies') is distinct from 'array' or pg_catalog.jsonb_array_length(v->'dependencies')>100 then raise exception 'NATIVE_INTENT_INVALID';end if;
 n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;
 role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or (v->>'actorId')::uuid is distinct from auth.uid() or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role) then raise exception using errcode='42501',message='NATIVE_INTENT_CONTEXT_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is distinct from p_snapshot_hash or old.snapshot_text is distinct from p_snapshot then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 select * into mode from public.native_sales_mode_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b;
 if not found then raise exception using errcode='42501',message='NATIVE_ACTIVATION_REQUIRED';end if;
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;
 clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 if v->>'kind'='TURN_OPEN' then
  if p_snapshot is not null or p_snapshot_hash is not null or exists(select 1 from public.native_sales_turns_v1 where negocio_id=n and status='OPEN' and scope_kind=k and sucursal_id is not distinct from b) then raise exception 'NATIVE_TURN_CONFLICT';end if;
  cash:=public.native_sales_int_v1(v->'payload'->'openingCents');
  if v->'payload' ? 'denominations' then
   if pg_catalog.jsonb_typeof(v->'payload'->'denominations') is distinct from 'array' or pg_catalog.jsonb_array_length(v->'payload'->'denominations')>20 then raise exception 'NATIVE_COUNT_INVALID';end if;
   if (select count(distinct value->>'valueCents') from pg_catalog.jsonb_array_elements(v->'payload'->'denominations'))<>pg_catalog.jsonb_array_length(v->'payload'->'denominations') then raise exception 'NATIVE_COUNT_INVALID';end if;
   num:=0;for eff in select value from pg_catalog.jsonb_array_elements(v->'payload'->'denominations') loop den:=public.native_sales_int_v1(eff->'valueCents');if den not in(1,5,10,25,50,100,500,1000,2500,5000,10000,20000,50000,100000,200000) then raise exception 'NATIVE_COUNT_INVALID';end if;num:=num+den*public.native_sales_int_v1(eff->'count');end loop;
   if num<>cash then raise exception 'NATIVE_COUNT_INVALID';end if;
  end if;
  insert into public.native_sales_turns_v1 values(n,op,k,b,i,d,auth.uid(),cash::bigint,v->>'originAtUtcMs','OPEN',seq);
  effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',op,'kind','TURN_OPEN','amountCents',cash::text));
 elsif v->>'kind'='SALE_CONFIRM' then
  if p_snapshot is null or p_snapshot_hash is null then raise exception 'NATIVE_SNAPSHOT_REQUIRED';end if;
  s:=p_snapshot::jsonb;if public.native_sales_canonical_v1(s)<>p_snapshot or public.native_sales_hash_v1(p_snapshot)<>p_snapshot_hash then raise exception 'NATIVE_SNAPSHOT_HASH_INVALID';end if;
  doc:=v->'payload'->'sale';pay:=doc->'payment';
  perform public.native_sales_object_v1(s,array['version','operationId','tenantId','actorId','originAtUtcMs','scope','ticket','ncf','customerName','sale']);
  perform public.native_sales_object_v1(doc,array['currency','calculationVersion','lines','discount','totals','payment','inventory','serials','stockEvidence','fiscal']);
  if v->'payload'->>'quoteHash' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_set(doc,'{fiscal}','null'::jsonb))) then raise exception 'NATIVE_QUOTE_HASH_INVALID';end if;
  perform public.native_sales_object_v1(pay,array['method','customerId','paidCents','creditChargeCents','cashNetCents','cardCents','transferCents','tenderCents','changeCents','turnId','bankSettlementVerified']);
  if pg_catalog.jsonb_typeof(doc->'lines') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'inventory') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'serials') is distinct from 'array' or pg_catalog.jsonb_typeof(doc->'stockEvidence') is distinct from 'array' then raise exception 'NATIVE_SALE_ARRAY_INVALID';end if;
  if s->'sale' is distinct from doc or s->>'version' is distinct from 'ventard.ticket.snapshot.1' or s->>'operationId' is distinct from op::text or s->>'tenantId' is distinct from n::text or s->>'actorId' is distinct from auth.uid()::text or s->>'originAtUtcMs' is distinct from v->>'originAtUtcMs' or s->'scope' is distinct from pg_catalog.jsonb_build_object('type',k,'branchId',b) or s->>'ticket' is null or s->>'ticket'!~('^N'||pg_catalog.replace(i::text,'-','')||'-[0-9]{6,}$') or doc->>'currency' is distinct from 'DOP' or doc->>'calculationVersion' is distinct from 'ventard.sale.calculation.1' or pg_catalog.jsonb_array_length(doc->'lines') not between 1 and 100 then raise exception 'NATIVE_SALE_INVALID';end if;
  if doc ? 'customer' then
   perform public.native_sales_object_v1(doc->'customer',array['id','name','revision']);
   if s->>'customerName' is distinct from doc->'customer'->>'name' or pg_catalog.length(s->>'customerName') not between 1 and 256 or s->>'customerName' ~ '[[:cntrl:]]' then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   cid:=(doc->'customer'->>'id')::uuid;
   if cid is not null and not exists(select 1 from public.clientes c where c.id=cid and c.negocio_id=n and not coalesce(c.eliminado,false) and c.nombre=doc->'customer'->>'name' and doc->'customer'->>'revision'=coalesce((select cm.revision::text from public.native_customer_metadata_v1 cm where cm.negocio_id=n and cm.cliente_id=cid),'1')) then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   if pay->>'method'='FIADO' and (cid is null or cid::text is distinct from pay->>'customerId') then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  elsif s->>'customerName' is not null and pay->>'method'<>'FIADO' then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  for ln in select value from pg_catalog.jsonb_array_elements(doc->'lines') loop
   perform public.native_sales_object_v1(ln,array['productId','productRevision','name','unitPriceCents','quantity','taxRate','costCents','serial','recipe']);
   qty:=public.native_sales_int_v1(ln->'quantity'->'numerator',2147483647);if qty=0 or ln->'quantity'->>'denominator' is distinct from '1' or pg_catalog.jsonb_typeof(ln->'recipe') is distinct from 'array' then raise exception 'NATIVE_QUANTITY_INVALID';end if;
   price:=public.native_sales_int_v1(ln->'unitPriceCents');pid:=(ln->>'productId')::uuid;
   if pid is null then rate:=mode.free_tax;if ln->>'name' is null or pg_catalog.length(ln->>'name') not between 1 and 256 or ln->>'name' ~ '[[:cntrl:]]' or ln->>'productRevision' is not null or ln->>'costCents' is not null or pg_catalog.jsonb_array_length(ln->'recipe')<>0 or ln->>'serial' is not null then raise exception 'NATIVE_FREE_LINE_INVALID';end if;
   else
    select * into product from public.productos where id=pid and negocio_id=n and eliminado=false;
    if not found or product.tipo='insumo' then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;
    price_base:=product.precio_venta;
    if ln ? 'pricePolicy' then
     if ln->'pricePolicy'->>'source' is distinct from 'CUSTOMER' then raise exception 'NATIVE_CUSTOMER_PRICING_INVALID';end if;cid:=(ln->'pricePolicy'->>'customerId')::uuid;tier:=public.native_sales_int_v1(ln->'pricePolicy'->'tier',3)::integer;
     if tier<1 or cid::text is distinct from coalesce(doc->'customer'->>'id',pay->>'customerId') or not exists(select 1 from public.clientes c where c.negocio_id=n and c.id=cid and not coalesce(c.eliminado,false) and coalesce(c.tipo_precio,1)=tier) then raise exception 'NATIVE_CUSTOMER_PRICING_INVALID';end if;
     price_base:=case tier when 2 then coalesce(nullif(product.precio_2,0),product.precio_venta) when 3 then coalesce(nullif(product.precio_3,0),product.precio_venta) else product.precio_venta end;
    end if;
    if ln->>'name' is distinct from product.nombre or ln->>'productRevision' is distinct from coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=n and pm.producto_id=pid),'1') or price<>price_base*100 or (ln->>'costCents')::numeric is distinct from public.native_product_cost_v1(n,pid) then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;rate:=product.tasa_itbis;
    if product.tipo='combo' then
     if pg_catalog.jsonb_array_length(ln->'recipe')<>(select count(*) from public.composiciones where negocio_id=n and producto_padre_id=pid) or pg_catalog.jsonb_array_length(ln->'recipe')<>(select count(distinct x->>'productId') from pg_catalog.jsonb_array_elements(ln->'recipe') x) then raise exception 'NATIVE_RECIPE_INVALID';end if;
     for part in select value from pg_catalog.jsonb_array_elements(ln->'recipe') loop ingredient:=(part->>'productId')::uuid;num:=public.native_sales_int_v1(part->'perUnit'->'numerator');den:=public.native_sales_int_v1(part->'perUnit'->'denominator');if den=0 then raise exception 'NATIVE_RECIPE_INVALID';end if;part_qty:=qty*num/den;
      if part->>'revision' is distinct from coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=n and pm.producto_id=ingredient),'1') or part_qty<>pg_catalog.trunc(part_qty) or not exists(select 1 from public.composiciones c join public.productos p on p.id=c.insumo_id where c.negocio_id=n and c.producto_padre_id=pid and c.insumo_id=ingredient and c.cantidad_necesaria=num/den and p.negocio_id=n and p.tipo<>'combo' and not coalesce(p.serializable,false) and not coalesce(p.eliminado,false)) then raise exception 'NATIVE_RECIPE_INVALID';end if;
      expected:=pg_catalog.jsonb_set(expected,array[ingredient::text],pg_catalog.to_jsonb(coalesce((expected->>ingredient::text)::numeric,0)-part_qty));end loop;
    else if pg_catalog.jsonb_array_length(ln->'recipe')<>0 then raise exception 'NATIVE_RECIPE_INVALID';end if;expected:=pg_catalog.jsonb_set(expected,array[pid::text],pg_catalog.to_jsonb(coalesce((expected->>pid::text)::numeric,0)-qty));end if;
    if product.serializable and (qty<>1 or ln->>'serial' is null or not exists(select 1 from pg_catalog.jsonb_array_elements(doc->'serials') x where x->>'productId'=pid::text and x->>'text'=ln->>'serial')) then raise exception 'NATIVE_SERIAL_REQUIRED';end if;
    if not product.serializable and ln->>'serial' is not null then raise exception 'NATIVE_SERIAL_INVALID';end if;
   end if;
   num:=public.native_sales_int_v1(ln->'taxRate'->'numerator');den:=public.native_sales_int_v1(ln->'taxRate'->'denominator');if den=0 or num<>rate*den then raise exception 'NATIVE_TAX_INVALID';end if;sub:=sub+price*qty;tax:=tax+price*qty*rate;
   eid:=public.native_sales_effect_id_v1(op,'line/'||(pg_catalog.jsonb_array_length(effects))::text);effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',eid,'kind','LINE','payload',ln));
  end loop;
  tax:=pg_catalog.floor(tax+0.5);
  if doc->'discount'->>'type'='AMOUNT' then disc:=least(public.native_sales_int_v1(doc->'discount'->'amountCents'),sub+tax);
  elsif doc->'discount'->>'type'='PERCENT' then num:=public.native_sales_int_v1(doc->'discount'->'ratio'->'numerator');den:=public.native_sales_int_v1(doc->'discount'->'ratio'->'denominator');if den=0 or num>100*den then raise exception 'NATIVE_DISCOUNT_INVALID';end if;disc:=pg_catalog.floor((sub+tax)*num/(den*100)+0.5);
  else raise exception 'NATIVE_DISCOUNT_INVALID';end if;total:=sub+tax-disc;
  if public.native_sales_int_v1(doc->'totals'->'subtotalCents')<>sub or public.native_sales_int_v1(doc->'totals'->'itbisCents')<>tax or public.native_sales_int_v1(doc->'totals'->'discountCents')<>disc or public.native_sales_int_v1(doc->'totals'->'totalCents')<>total then raise exception 'NATIVE_TOTALS_INVALID';end if;
  if pg_catalog.jsonb_array_length(doc->'inventory')<>(select count(*) from pg_catalog.jsonb_each(expected)) or pg_catalog.jsonb_array_length(doc->'stockEvidence')<>pg_catalog.jsonb_array_length(doc->'inventory') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
  for eff in select value from pg_catalog.jsonb_array_elements(doc->'inventory') loop
   pid:=(eff->>'productId')::uuid;delta:=(eff->>'delta')::integer;if delta>=0 or eff->>'delta' is distinct from delta::text or delta::numeric is distinct from (expected->>pid::text)::numeric then raise exception 'NATIVE_STOCK_EFFECT_INVALID';end if;expected:=expected-pid::text;
   select value into proof from pg_catalog.jsonb_array_elements(doc->'stockEvidence') where value->>'productId'=pid::text;
   if (select count(*) from pg_catalog.jsonb_array_elements(doc->'stockEvidence') x where x->>'productId'=pid::text)<>1 or pg_catalog.jsonb_typeof(proof->'pending') is distinct from 'array' or pg_catalog.jsonb_array_length(proof->'pending')>1000 or (select count(distinct x->>'effectId') from pg_catalog.jsonb_array_elements(proof->'pending') x)<>pg_catalog.jsonb_array_length(proof->'pending') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
   expected_version:=public.native_sales_int_v1(proof->'remoteSequence')::bigint;
   select revision into version from public.native_sales_stock_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid for update;
   if not found then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
   if k='BRANCH' then select stock_actual into cur from public.inventario_sucursales where sucursal_id=b and producto_id=pid for update;else select stock_actual into cur from public.productos where id=pid and negocio_id=n for update;end if;
   if cur is null then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
   num:=public.native_sales_int_v1(proof->'remoteBaseQty',2147483647);
   for pend in select value from pg_catalog.jsonb_array_elements(proof->'pending') loop
    select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=(pend->>'operationId')::uuid and installation_id=i and scope_kind=k and sucursal_id is not distinct from b;
    if not found or not exists(select 1 from public.native_sales_effects_v1 x where x.negocio_id=n and x.operation_id=old.operation_id and x.effect_id=(pend->>'effectId')::uuid and x.kind='STOCK' and x.payload->>'productId'=pid::text and x.payload->>'delta'=pend->>'delta') then raise exception 'NATIVE_PENDING_COVERAGE_INVALID';end if;
    num:=num+(pend->>'delta')::integer;expected_version:=greatest(expected_version,old.remote_sequence);
   end loop;
   if version<>expected_version or num<>cur or public.native_sales_int_v1(proof->'effectiveQty',2147483647)<>cur or eff->>'expectedRevision' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object('quantity',proof->>'effectiveQty','remoteSequence',proof->>'remoteSequence','pending',proof->'pending'))) then raise exception 'NATIVE_STOCK_VERSION_CONFLICT';end if;
   after:=cur+delta;if after<0 then raise exception 'NATIVE_STOCK_UNAVAILABLE';end if;
   if k='BRANCH' then
    if exists(select 1 from public.inventario_sucursales z left join public.sucursales br on br.id=z.sucursal_id where z.producto_id=pid and br.negocio_id is distinct from n) then raise exception 'NATIVE_STOCK_SOURCE_UNVERIFIABLE';end if;
    select sum(stock_actual) into own_projection from public.inventario_sucursales where producto_id=pid;
    if own_projection is distinct from (select stock_actual::numeric from public.productos where id=pid and negocio_id=n) then raise exception 'AUTHORITY_PROJECTION_DIVERGED';end if;
    update public.inventario_sucursales set stock_actual=after where sucursal_id=b and producto_id=pid;
    update public.productos set stock_actual=(own_projection+delta)::integer where id=pid and negocio_id=n;
   else update public.productos set stock_actual=after where id=pid and negocio_id=n;end if;
   update public.native_sales_stock_v1 set revision=seq where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid;
   eid:=public.native_sales_effect_id_v1(op,'stock/'||pid::text);effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',eid,'kind','STOCK','payload',pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text)));
   stock:=stock||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'after',after::text,'version',seq::text));
  end loop;
  method:=pay->>'method';if method is null then raise exception 'NATIVE_PAYMENT_INVALID';end if;cash:=public.native_sales_int_v1(pay->'cashNetCents');credit:=public.native_sales_int_v1(pay->'creditChargeCents');transfer:=public.native_sales_int_v1(pay->'transferCents');card:=public.native_sales_int_v1(pay->'cardCents');tender:=public.native_sales_int_v1(pay->'tenderCents');change:=public.native_sales_int_v1(pay->'changeCents');turn:=(pay->>'turnId')::uuid;
  if pay->'bankSettlementVerified' is distinct from 'false'::jsonb or v->>'originalTurnId' is distinct from pay->>'turnId' then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  if method<>'FIADO' and pay->>'customerId' is not null then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  -- Non-cash retains the known turn as context, never as a cash effect.
  if turn is not null and not exists(select 1 from public.native_sales_turns_v1 t where t.negocio_id=n and t.turn_id=turn and t.status='OPEN' and t.scope_kind=k and t.sucursal_id is not distinct from b) then raise exception 'NATIVE_TURN_CONTEXT_INVALID';end if;
  if method in('EFECTIVO','MIXTO') and not exists(select 1 from public.native_sales_turns_v1 where negocio_id=n and turn_id=turn and status='OPEN' and scope_kind=k and sucursal_id is not distinct from b) then raise exception 'NATIVE_TURN_REQUIRED';end if;
  if method='EFECTIVO' and (cash<>total or transfer<>0 or card<>0 or credit<>0 or tender<cash or change<>tender-cash) or method='TARJETA' and (card<>total or cash<>0 or transfer<>0 or credit<>0 or tender<>0 or change<>0) or method='TRANSFERENCIA' and (transfer<>total or cash<>0 or card<>0 or credit<>0 or tender<>0 or change<>0) or method='MIXTO' and (cash+transfer<>total or card<>0 or credit<>0 or tender<cash or change<>tender-cash) or method='FIADO' and (credit<>total or cash<>0 or card<>0 or transfer<>0 or tender<>0 or change<>0) or method not in('EFECTIVO','TARJETA','TRANSFERENCIA','MIXTO','FIADO') or public.native_sales_int_v1(pay->'paidCents')<>cash+card+transfer then raise exception 'NATIVE_PAYMENT_INVALID';end if;
  if method='FIADO' then cid:=(pay->>'customerId')::uuid;select x.balance_cents,c.limite_credito*100 into debt,limit_credit from public.native_sales_credit_v1 x join public.clientes c on c.id=x.cliente_id and c.negocio_id=x.negocio_id where x.negocio_id=n and x.cliente_id=cid and not coalesce(c.eliminado,false) for update of x;
   if not found or limit_credit is null or limit_credit>0 and debt+credit>limit_credit then raise exception 'NATIVE_CREDIT_LIMIT';end if;update public.native_sales_credit_v1 set balance_cents=balance_cents+credit,revision=revision+1 where negocio_id=n and cliente_id=cid;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'credit'),'kind','CREDIT','payload',pg_catalog.jsonb_build_object('customerId',cid,'amountCents',credit::text)));
  end if;
  if method in('EFECTIVO','MIXTO') then effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'cash'),'kind','CASH','payload',pg_catalog.jsonb_build_object('turnId',turn,'amountCents',cash::text)));end if;
  effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'payment'),'kind','PAYMENT','payload',pay));
  if pg_catalog.jsonb_array_length(doc->'serials')<>(select count(*) from pg_catalog.jsonb_array_elements(doc->'lines') x where x->>'serial' is not null) then raise exception 'NATIVE_SERIAL_COVERAGE_INVALID';end if;
  for serial in select value from pg_catalog.jsonb_array_elements(doc->'serials') loop sn:=serial->>'text';pid:=(serial->>'productId')::uuid;
   if sn is null or not exists(select 1 from pg_catalog.jsonb_array_elements(doc->'lines') x where x->>'serial'=sn and x->>'productId'=pid::text) or serial->>'expectedRevision' is distinct from '1' then raise exception 'NATIVE_SERIAL_INVALID';end if;
   update public.seriales set estado='vendido',venta_id=op,fecha_venta=(v->>'originAtUtcMs')::bigint,fecha_actualizacion=clock_ms::bigint where negocio_id=n and producto_id=pid and numero_serial=sn and estado='disponible';get diagnostics rows_n=row_count;if rows_n<>1 then raise exception 'NATIVE_SERIAL_CONFLICT';end if;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'serial/'||sn),'kind','SERIAL','payload',serial));end loop;
  if doc->'fiscal'<>'null'::jsonb then
   sn:=doc->'fiscal'->>'ncf';ncftype:=pg_catalog.substr(sn,1,3);if sn!~'^B0[12][0-9]{8}$' then raise exception 'NATIVE_FISCAL_INVALID';end if;ncfnum:=pg_catalog.substr(sn,4)::bigint;
   if doc->'fiscal'->>'reservationId' is distinct from op::text or doc->'fiscal'->>'type' is distinct from ncftype or doc->'fiscal'->>'number' is distinct from ncfnum::text or not exists(select 1 from public.native_fiscal_requests_v2 f where f.negocio_id=n and f.installation_id=i and f.request_id=(doc->'fiscal'->>'blockId')::uuid and f.receipt->>'deviceId'=d::text and f.receipt->>'writerEpoch'=epoch::text and f.receipt->>'status'='ALLOCATED' and f.receipt->>'kind'=ncftype and (f.receipt->>'first')::bigint<=ncfnum and (f.receipt->>'last')::bigint>=ncfnum) or s->>'ncf' is distinct from sn then raise exception 'NATIVE_FISCAL_INVALID';end if;
   effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'fiscal'),'kind','FISCAL','payload',doc->'fiscal'));
  elsif s->>'ncf' is not null then raise exception 'NATIVE_FISCAL_INVALID';end if;
 else raise exception 'NATIVE_KIND_UNSUPPORTED';end if;
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',p_snapshot_hash,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',s->>'ticket','ncf',s->>'ncf','totalCents',case when s is not null then total::text else null end,'effects',effects,'stock',stock);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,v->>'kind',p_intent,p_hash,p_snapshot,p_snapshot_hash,s->>'ticket',s->>'ncf',seq,receipt);
 for eff in select value from pg_catalog.jsonb_array_elements(effects) loop insert into public.native_sales_effects_v1 values(n,op,(eff->>'id')::uuid,eff->>'kind',coalesce(eff->'payload',eff));end loop;
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;
 return receipt;
end $f$;
revoke all on function public.native_sales_submit_base_v1(text,text,text,text) from public,anon,authenticated;
create or replace function public.native_management_submit_base_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;req jsonb;doc jsonb;expected jsonb;cu jsonb;n uuid;op uuid;i uuid;d uuid;b uuid;k text;epoch bigint;role text;kind text;old public.native_sales_ledger_v1%rowtype;client public.clientes%rowtype;metadata public.native_customer_metadata_v1%rowtype;t public.native_sales_turns_v1%rowtype;cid uuid;turn uuid;rev bigint;bal_rev bigint;before bigint;amount bigint;delta bigint:=0;after bigint;seq bigint;clock_ms text;cash numeric;expected_cash numeric;receipt jsonb;effects jsonb;den jsonb;counted numeric;count_total numeric:=0;method text;concept text;phone text;wholesale boolean;limit_amount bigint;tier integer;note text;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;kind:=v->>'kind';
 if kind in('SALE_CONFIRM','TURN_OPEN') then return public.native_sales_submit_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end if;
 if kind is null or kind not in('CUSTOMER_CREATE','CUSTOMER_PATCH','CUSTOMER_DELETE','CREDIT_PAYMENT','EXPENSE_RECORD','CASH_ENTRY','CUT_X','TURN_CLOSE') or p_snapshot is not null or p_snapshot_hash is not null then raise exception 'NATIVE_KIND_INVALID';end if;
 if public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent) is distinct from p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 if v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or v->'expectedVersions' is distinct from '{}'::jsonb or v->'dependencies' is distinct from '[]'::jsonb then raise exception 'NATIVE_INTENT_INVALID';end if;
 perform public.native_sales_int_v1(v->'originAtUtcMs');n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;
 role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or (v->>'actorId')::uuid is distinct from auth.uid() or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role) or (kind<>'CREDIT_PAYMENT' and role not in('owner','admin')) then raise exception using errcode='42501',message='NATIVE_INTENT_CONTEXT_INVALID';end if;
 if not exists(select 1 from public.native_sales_mode_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b) then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is not null or old.snapshot_text is not null then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 req:=v->'payload'->'request';doc:=v->'payload'->'document';
 if req->>'operationId' is distinct from op::text or pg_catalog.jsonb_typeof(doc) is distinct from 'object' then raise exception 'NATIVE_REQUEST_INVALID';end if;
 turn:=(v->>'originalTurnId')::uuid;
 if kind not in('CUSTOMER_CREATE','CUSTOMER_PATCH','CUSTOMER_DELETE') then
  if req->>'turnId' is distinct from turn::text then raise exception 'NATIVE_TURN_CONTEXT_INVALID';end if;
  select * into t from public.native_sales_turns_v1 where negocio_id=n and turn_id=turn and scope_kind=k and sucursal_id is not distinct from b and status='OPEN' for update;if not found then raise exception 'NATIVE_TURN_REQUIRED';end if;
 elsif turn is not null then raise exception 'NATIVE_TURN_CONTEXT_INVALID';end if;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 if kind in('CUSTOMER_CREATE','CUSTOMER_PATCH','CUSTOMER_DELETE') then
  cid:=(req->>'customerId')::uuid;rev:=public.native_sales_int_v1(req->'expectedRevision')::bigint;
  select * into client from public.clientes where negocio_id=n and id=cid for update;
  select * into metadata from public.native_customer_metadata_v1 where negocio_id=n and cliente_id=cid for update;
  if kind='CUSTOMER_CREATE' then if rev<>0 or client.id is not null or req->>'kind' is distinct from 'CUSTOMER_SAVE' then raise exception 'NATIVE_CUSTOMER_VERSION';end if;
  else if client.id is null or coalesce(client.eliminado,false) or coalesce(metadata.revision,1)<>rev then raise exception 'NATIVE_CUSTOMER_VERSION';end if;end if;
  if kind='CUSTOMER_DELETE' then
   if exists(select 1 from public.native_sales_credit_v1 x where x.negocio_id=n and x.cliente_id=cid and x.balance_cents>0) then raise exception 'NATIVE_CREDIT_BALANCE_PENDING';end if;
   if req->>'kind' is distinct from 'CUSTOMER_DELETE' then raise exception 'NATIVE_REQUEST_INVALID';end if;
   cu:=pg_catalog.jsonb_build_object('id',cid,'name',client.nombre,'phone',case when metadata.cliente_id is null then pg_catalog.to_jsonb(client)->>'telefono' else metadata.phone end,'limitCents',(client.limite_credito*100)::bigint::text,'priceTier',coalesce(client.tipo_precio,1),'wholesale',coalesce(metadata.wholesale,(pg_catalog.to_jsonb(client)->>'al_por_mayor')::boolean,false),'active',false,'revision',(rev+1)::text);
  else
   if req->>'kind' is distinct from 'CUSTOMER_SAVE' or pg_catalog.jsonb_typeof(req->'wholesale') is distinct from 'boolean' or pg_catalog.jsonb_typeof(req->'priceTier') is distinct from 'number' then raise exception 'NATIVE_REQUEST_INVALID';end if;
   limit_amount:=public.native_sales_int_v1(req->'limitCents')::bigint;tier:=(req->>'priceTier')::integer;phone:=req->>'phone';wholesale:=(req->>'wholesale')::boolean;
   if tier not between 1 and 3 or pg_catalog.jsonb_typeof(req->'name') is distinct from 'string' or pg_catalog.length(req->>'name') not between 1 and 256 or pg_catalog.btrim(req->>'name')='' or req->>'name' ~ '[[:cntrl:]]' or pg_catalog.jsonb_typeof(req->'phone') not in('string','null') or (phone is not null and (pg_catalog.length(phone)>64 or phone ~ '[[:cntrl:]]')) then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   cu:=pg_catalog.jsonb_build_object('id',cid,'name',req->>'name','phone',phone,'limitCents',req->>'limitCents','priceTier',tier,'wholesale',wholesale,'active',true,'revision',(rev+1)::text);
  end if;
  expected:=pg_catalog.jsonb_build_object('customer',cu);if doc is distinct from expected then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
  if kind='CUSTOMER_CREATE' then
   if exists(select 1 from public.clientes where id=cid) then raise exception 'NATIVE_CUSTOMER_VERSION';end if;
   insert into public.clientes(id,negocio_id,nombre,limite_credito,tipo_precio,eliminado,fecha_actualizacion) values(cid,n,cu->>'name',(cu->>'limitCents')::numeric/100,(cu->>'priceTier')::integer,false,(v->>'originAtUtcMs')::bigint);
   insert into public.native_sales_credit_v1 values(n,cid,0,1);
  else update public.clientes set nombre=cu->>'name',limite_credito=(cu->>'limitCents')::numeric/100,tipo_precio=(cu->>'priceTier')::integer,eliminado=kind='CUSTOMER_DELETE' where id=cid and negocio_id=n;end if;
  insert into public.native_customer_metadata_v1 values(n,cid,cu->>'phone',(cu->>'wholesale')::boolean,rev+1) on conflict(negocio_id,cliente_id) do update set phone=excluded.phone,wholesale=excluded.wholesale,revision=excluded.revision;
 elsif kind in('CREDIT_PAYMENT','EXPENSE_RECORD','CASH_ENTRY') then
  if req->>'kind' is distinct from kind then raise exception 'NATIVE_REQUEST_INVALID';end if;
  amount:=public.native_sales_int_v1(req->'amountCents')::bigint;concept:=req->>'concept';method:=req->>'method';
  if amount<=0 or pg_catalog.jsonb_typeof(req->'concept') is distinct from 'string' or pg_catalog.length(concept) not between 1 and 256 or pg_catalog.btrim(concept)='' or concept ~ '[[:cntrl:]]' then raise exception 'NATIVE_AMOUNT_INVALID';end if;
  if kind='CASH_ENTRY' then
   if req->>'direction' is null or req->>'direction' not in('IN','OUT') then raise exception 'NATIVE_REQUEST_INVALID';end if;method:='EFECTIVO';delta:=case when req->>'direction'='IN' then amount else -amount end;
   expected:=pg_catalog.jsonb_build_object('amountCents',amount::text,'method',method,'concept',concept,'direction',req->>'direction','cashDeltaCents',delta::text);
  else
   if method is null or method not in('EFECTIVO','TARJETA','TRANSFERENCIA') then raise exception 'NATIVE_PAYMENT_INVALID';end if;
   delta:=case when method='EFECTIVO' then case when kind='CREDIT_PAYMENT' then amount else -amount end else 0 end;
   if kind='CREDIT_PAYMENT' then
    cid:=(req->>'customerId')::uuid;rev:=public.native_sales_int_v1(req->'expectedRevision')::bigint;
    select x.balance_cents,x.revision into before,bal_rev from public.native_sales_credit_v1 x join public.clientes c on c.id=x.cliente_id and c.negocio_id=x.negocio_id where x.negocio_id=n and x.cliente_id=cid and not coalesce(c.eliminado,false) for update of x;
    if before is null or bal_rev<>rev or before<amount then raise exception 'NATIVE_CREDIT_OVERPAY_OR_VERSION';end if;after:=before-amount;
    expected:=pg_catalog.jsonb_build_object('customerId',cid,'balanceBeforeCents',before::text,'balanceAfterCents',after::text,'balanceRevision',(rev+1)::text,'amountCents',amount::text,'method',method,'concept',concept,'cashDeltaCents',delta::text);
    update public.native_sales_credit_v1 set balance_cents=after,revision=revision+1 where negocio_id=n and cliente_id=cid;
   else if req ? 'category' and (req->>'category' is null or req->>'category' not in('mercancia','servicios','alquiler','sueldos','transporte','otro')) then raise exception 'NATIVE_REQUEST_INVALID';end if;expected:=pg_catalog.jsonb_build_object('amountCents',amount::text,'method',method,'concept',concept,'category',coalesce(req->'category','null'::jsonb),'cashDeltaCents',delta::text);end if;
  end if;
  if doc is distinct from expected then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
  select c.last_sequence into seq from public.native_sales_counter_v1 c where c.negocio_id=n;
  cash:=(public.native_cash_base_v1(n,k,b,seq)->>'netCents')::numeric;
  if cash is null or pg_catalog.abs(t.opening_cents+cash+delta)>9007199254740991 then raise exception 'NATIVE_CASH_OVERFLOW';end if;
 elsif kind in('CUT_X','TURN_CLOSE') then
  if req->>'kind' is distinct from kind then raise exception 'NATIVE_REQUEST_INVALID';end if;
  counted:=public.native_sales_int_v1(req->'countedCents');
  if pg_catalog.jsonb_typeof(req->'denominations') is distinct from 'array' or pg_catalog.jsonb_array_length(req->'denominations')>20 then raise exception 'NATIVE_COUNT_INVALID';end if;
  if (select count(distinct value->>'valueCents') from pg_catalog.jsonb_array_elements(req->'denominations'))<>pg_catalog.jsonb_array_length(req->'denominations') then raise exception 'NATIVE_COUNT_INVALID';end if;
  for den in select value from pg_catalog.jsonb_array_elements(req->'denominations') loop
   cash:=public.native_sales_int_v1(den->'valueCents');if cash not in(1,5,10,25,50,100,500,1000,2500,5000,10000,20000,50000,100000,200000) then raise exception 'NATIVE_COUNT_INVALID';end if;count_total:=count_total+cash*public.native_sales_int_v1(den->'count');
  end loop;
  if pg_catalog.jsonb_array_length(req->'denominations')>0 and count_total<>counted then raise exception 'NATIVE_COUNT_INVALID';end if;
  select coalesce(sum((e.payload->>'amountCents')::numeric),0) into cash from public.native_sales_effects_v1 e where e.negocio_id=n and e.kind='CASH' and e.payload->>'turnId'=turn::text;
  select cash+coalesce(sum((r.document->>'cashDeltaCents')::numeric),0) into cash from public.native_management_records_v1 r where r.negocio_id=n and r.turn_id=turn and r.document ? 'cashDeltaCents';expected_cash:=t.opening_cents+cash;
  if pg_catalog.abs(expected_cash)>9007199254740991 or doc->'drawer'->>'turnId' is distinct from turn::text or doc->'drawer'->>'status' is distinct from 'OPEN' or doc->'drawer'->>'openingCents' is distinct from t.opening_cents::text or doc->'drawer'->>'openedAtMs' is distinct from t.opened_at_ms or doc->'drawer'->>'netCashCents' is distinct from cash::bigint::text or doc->'drawer'->>'expectedCents' is distinct from expected_cash::bigint::text or doc->>'countedCents' is distinct from counted::bigint::text or doc->>'differenceCents' is distinct from (counted-expected_cash)::bigint::text or doc->'denominations' is distinct from req->'denominations' or doc->'notes' is distinct from coalesce(req->'notes','null'::jsonb) then raise exception 'NATIVE_CASH_VERSION';end if;
  note:=req->>'notes';if note is not null and pg_catalog.length(note)>1000 then raise exception 'NATIVE_REQUEST_INVALID';end if;
  if kind='TURN_CLOSE' then update public.native_sales_turns_v1 set status='CLOSED',revision=revision+1 where negocio_id=n and turn_id=turn;end if;
 end if;
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;
 if seq is null then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint::text;
 effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'management'),'kind',kind,'payload',doc));
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',null,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',null,'ncf',null,'totalCents',null,'effects',effects,'stock','[]'::jsonb);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,kind,p_intent,p_hash,null,null,null,null,seq,receipt);
 insert into public.native_sales_effects_v1 values(n,op,public.native_sales_effect_id_v1(op,'management'),kind,doc);
 insert into public.native_management_records_v1 values(n,op,k,b,kind,turn,cid,method,coalesce(amount,0),coalesce(concept,kind),v->>'originAtUtcMs',doc);
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;
 return receipt;
end $f$;
revoke all on function public.native_management_submit_base_v1(text,text,text,text) from public,anon,authenticated;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 then raise exception 'NATIVE_COMMAND_SIZE';end if;
 if (p_intent::jsonb)->>'kind' in('PRODUCT_CREATE','PRODUCT_PATCH','PRODUCT_DELETE','INVENTORY_DELTA','INVENTORY_COUNT') then return public.native_inventory_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end if;
 return public.native_management_submit_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
end $f$;
revoke all on function public.native_sales_submit_v1(text,text,text,text) from public,anon;
grant execute on function public.native_sales_submit_v1(text,text,text,text) to authenticated;
create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare m public.native_sales_mode_v1%rowtype;old public.native_sales_snapshots_v1%rowtype;rows jsonb;batch jsonb;pages jsonb:='[]';header jsonb;payload text;idx integer:=0;cnt integer;at_ms bigint;watermark bigint;last_ticket bigint;turn_event jsonb;
begin
 perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if p_snapshot_id is null then raise exception 'NATIVE_SNAPSHOT_ID_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||p_negocio_id::text,0));
 select * into old from public.native_sales_snapshots_v1 x where x.negocio_id=p_negocio_id and x.snapshot_id=p_snapshot_id;
 if found then
  if old.actor_id is distinct from auth.uid() or old.installation_id is distinct from p_installation_id or old.device_id is distinct from p_device_id or old.writer_epoch is distinct from p_writer_epoch or old.scope_kind is distinct from p_scope_kind or old.sucursal_id is distinct from p_sucursal_id then raise exception using errcode='42501',message='NATIVE_SNAPSHOT_CONTEXT_DENIED';end if;
  return old.manifest;
 end if;
 select * into m from public.native_sales_mode_v1 x where x.negocio_id=p_negocio_id and x.scope_kind=p_scope_kind and x.sucursal_id is not distinct from p_sucursal_id;
 if not found then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 -- Legacy direct changes are fenced, and native writers share the tenant lock.
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_venta is null or p.precio_venta<0 or p.precio_venta*100<>pg_catalog.trunc(p.precio_venta*100) or p.precio_venta*100>9007199254740991 or p.costo<0 or p.costo*100<>pg_catalog.trunc(p.costo*100) or p.tasa_itbis is null or p.tasa_itbis not between 0 and 1 or p.tasa_itbis*100<>pg_catalog.trunc(p.tasa_itbis*100))) then raise exception 'NATIVE_PRODUCT_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.composiciones c where c.negocio_id=p_negocio_id and (c.cantidad_necesaria is null or c.cantidad_necesaria<=0 or c.cantidad_necesaria*10000<>pg_catalog.trunc(c.cantidad_necesaria*10000))) then raise exception 'NATIVE_RECIPE_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_2<0 or p.precio_3<0 or p.precio_2*100<>pg_catalog.trunc(p.precio_2*100) or p.precio_3*100<>pg_catalog.trunc(p.precio_3*100) or p.precio_2*100>9007199254740991 or p.precio_3*100>9007199254740991)) then raise exception 'NATIVE_PRICE_TIER_UNVERIFIABLE';end if;
 if exists(select 1 from public.seriales s where s.negocio_id=p_negocio_id and (s.estado is null or s.estado not in('disponible','vendido','reservado'))) then raise exception 'NATIVE_SERIAL_SOURCE_UNVERIFIABLE';end if;
 select x.last_sequence into watermark from public.native_sales_counter_v1 x where x.negocio_id=p_negocio_id;
 select coalesce(max(pg_catalog.split_part(x.ticket,'-',2)::bigint),0) into last_ticket from public.native_sales_ledger_v1 x where x.negocio_id=p_negocio_id and x.installation_id=p_installation_id and x.writer_epoch=p_writer_epoch and x.ticket is not null;
 select pg_catalog.jsonb_build_object('receipt',l.receipt,'intent',l.intent_text,'snapshot',l.snapshot_text) into turn_event from public.native_sales_turns_v1 t join public.native_sales_ledger_v1 l on l.negocio_id=t.negocio_id and l.operation_id=t.turn_id where t.negocio_id=p_negocio_id and t.scope_kind=p_scope_kind and t.sucursal_id is not distinct from p_sucursal_id and t.status='OPEN';
 select coalesce(pg_catalog.jsonb_agg(v order by kind,id),'[]'::jsonb) into rows from (
  select 'PRODUCT' kind,p.id::text id,pg_catalog.jsonb_build_object('kind','PRODUCT','id',p.id,'name',p.nombre,'code',p.codigo_barras,'revision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),'1'),'deleted',coalesce(p.eliminado,false),'priceTiers',pg_catalog.jsonb_build_object('retailCents',(p.precio_venta*100)::bigint::text,'tier2Cents',(p.precio_2*100)::bigint::text,'tier3Cents',(p.precio_3*100)::bigint::text),'metadata',pg_catalog.jsonb_build_object('costCents',public.native_product_cost_v1(p_negocio_id,p.id)::bigint::text,'taxRate',pg_catalog.jsonb_build_object('numerator',(p.tasa_itbis*100)::bigint::text,'denominator','100'),'productType',p.tipo,'recipeCostPolicy',case when p.tipo='combo' and exists(select 1 from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id) then 'NATIVE_EXACT' else 'DECLARED' end,'location',coalesce((select pm.location from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),pg_catalog.to_jsonb(p)->>'ubicacion',''),'minimum',coalesce((select pm.minimum::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),pg_catalog.to_jsonb(p)->>'stock_minimo'),'serialRequired',coalesce(p.serializable,false),'recipe',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productId',c.insumo_id,'perUnit',pg_catalog.jsonb_build_object('numerator',(c.cantidad_necesaria*10000)::bigint::text,'denominator','10000'),'revision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=c.insumo_id),'1')) order by c.insumo_id) from public.composiciones c where c.negocio_id=p_negocio_id and c.producto_padre_id=p.id),'[]'::jsonb)),'stock',pg_catalog.jsonb_build_object('quantity',case when p_scope_kind='GLOBAL' then p.stock_actual::text else inv.stock_actual::text end,'version',st.revision::text,'authority',case when st.revision is null or (p_scope_kind='BRANCH' and inv.stock_actual is null) then 'UNKNOWN' when p_scope_kind='BRANCH' and p.stock_actual is distinct from (select sum(z.stock_actual) from public.inventario_sucursales z where z.producto_id=p.id) then 'DIVERGED' else 'VERIFIED' end)) v from public.productos p left join public.inventario_sucursales inv on inv.producto_id=p.id and inv.sucursal_id=p_sucursal_id left join public.native_sales_stock_v1 st on st.negocio_id=p_negocio_id and st.producto_id=p.id and st.scope_kind=p_scope_kind and st.sucursal_id is not distinct from p_sucursal_id where p.negocio_id=p_negocio_id
  union all select 'CUSTOMER',c.id::text,pg_catalog.jsonb_build_object('kind','CUSTOMER','id',c.id,'name',c.nombre,'balanceCents',x.balance_cents::text,'limitCents',(c.limite_credito*100)::bigint::text,'active',not coalesce(c.eliminado,false),'revision',x.revision::text,'priceTier',coalesce(c.tipo_precio,1)::text,'metadataRevision',coalesce((select cm.revision::text from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id),'1'),'phone',case when exists(select 1 from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id) then (select cm.phone from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id) else pg_catalog.to_jsonb(c)->>'telefono' end,'wholesale',coalesce((select cm.wholesale from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id),(pg_catalog.to_jsonb(c)->>'al_por_mayor')::boolean,false)) from public.clientes c join public.native_sales_credit_v1 x on x.negocio_id=c.negocio_id and x.cliente_id=c.id where c.negocio_id=p_negocio_id
  union all select 'SERIAL',s.id::text,pg_catalog.jsonb_build_object('kind','SERIAL','productId',s.producto_id,'text',s.numero_serial,'revision','1','state',case s.estado when 'disponible' then 'AVAILABLE' when 'reservado' then 'RESERVED' else 'SOLD' end) from public.seriales s where s.negocio_id=p_negocio_id
 ) q;
 cnt:=pg_catalog.jsonb_array_length(rows);if cnt>60000 then raise exception 'NATIVE_BOOTSTRAP_SIZE';end if;
 at_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint;
 header:=pg_catalog.jsonb_build_object('version','ventard.native.operational.1','namespace','NATIVE1','snapshotId',p_snapshot_id,'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'deviceId',p_device_id,'installationId',p_installation_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),'capturedAtMs',at_ms::text,'expiresAtMs',(at_ms+86400000)::text,'coverage','CLOUD_ADOPTED_V1','watermark',watermark::text,'totalCount',cnt,'ticketPrefix','N'||pg_catalog.replace(p_installation_id::text,'-',''),'lastTicket',last_ticket::text,'freeTax',pg_catalog.jsonb_build_object('numerator',(m.free_tax*100)::bigint::text,'denominator','100'),'turn',turn_event,'business',(select pg_catalog.jsonb_build_object('name',g.nombre,'rnc',pg_catalog.to_jsonb(g)->>'rnc','address',pg_catalog.to_jsonb(g)->>'direccion','phone',pg_catalog.to_jsonb(g)->>'telefono','footer',pg_catalog.to_jsonb(g)->>'mensaje_ticket') from public.negocios g where g.id=p_negocio_id),'cashBase',public.native_cash_base_v1(p_negocio_id,p_scope_kind,p_sucursal_id,watermark),'pages','[]'::jsonb);
 insert into public.native_sales_snapshots_v1 values(p_negocio_id,p_snapshot_id,auth.uid(),p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,header,at_ms+86400000);
 for batch in select pg_catalog.jsonb_agg(value order by ordinality) from pg_catalog.jsonb_array_elements(rows) with ordinality group by ((ordinality-1)/200) order by ((ordinality-1)/200) loop
  payload:=public.native_sales_canonical_v1(batch);if pg_catalog.octet_length(payload)>1048576 then raise exception 'NATIVE_BOOTSTRAP_PAGE_SIZE';end if;
  pages:=pages||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',idx,'count',pg_catalog.jsonb_array_length(batch),'byteLength',pg_catalog.octet_length(payload),'sha256',public.native_sales_hash_v1(payload)));
  insert into public.native_sales_pages_v1 values(p_negocio_id,p_snapshot_id,idx,payload);idx:=idx+1;
 end loop;
 header:=pg_catalog.jsonb_set(header,'{pages}',pages);update public.native_sales_snapshots_v1 set manifest=header where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;return header;
end $f$;

-- Source: 20261012123311_native_returns_staging_v1.sql SHA256 c5123da6f2bee2d12a01d785f4003c4a0f9e96b26b84b2850ea6a174a473ec0d
do $guard$ begin

end $guard$;
create or replace function public.native_return_plan_v1(sale jsonb,prior jsonb,items jsonb,selected jsonb) returns jsonb language plpgsql immutable set search_path='' as $f$
declare ln jsonb;it jsonb;previous jsonb;serial jsonb;part jsonb;key text;pid text;sn text;groups jsonb:='{}';g jsonb;requested jsonb:='{}';returned jsonb:='{}';old_serials jsonb:='[]';out_items jsonb:='[]';stock_map jsonb:='{}';stock jsonb:='[]';ss jsonb:='[]';recipes jsonb;recipe jsonb;q numeric;sold numeric;left_qty numeric;gross numeric:=0;weight_n numeric:=0;weight_d numeric:=1;total numeric;already numeric:=0;cash_already numeric:=0;amount numeric;cash numeric;original_cash numeric;remaining numeric;all_remaining boolean:=true;idx integer:=0;factor_n numeric;factor_d numeric;old_n numeric;old_d numeric;delta_n numeric;delta_d numeric;count_serial integer;method text;
begin
 if pg_catalog.jsonb_typeof(items) is distinct from 'array' or pg_catalog.jsonb_array_length(items) not between 1 and 100 or pg_catalog.jsonb_typeof(selected) is distinct from 'array' or pg_catalog.jsonb_array_length(selected)>1000 or (select count(distinct x#>>'{}') from pg_catalog.jsonb_array_elements(selected) x)<>pg_catalog.jsonb_array_length(selected) then raise exception 'NATIVE_RETURN_REQUEST_INVALID';end if;
 for ln in select value from pg_catalog.jsonb_array_elements(sale->'lines') loop
  q:=public.native_sales_int_v1(ln->'quantity'->'numerator',2147483647);if q<=0 or ln->'quantity'->>'denominator' is distinct from '1' then raise exception 'NATIVE_RETURN_BASIS_INVALID';end if;
  key:=coalesce(ln->>'productId','free/'||idx::text);idx:=idx+1;g:=coalesce(groups->key,'{}'::jsonb);
  groups:=pg_catalog.jsonb_set(groups,array[key],pg_catalog.jsonb_build_object('quantity',coalesce((g->>'quantity')::numeric,0)+q,'gross',coalesce((g->>'gross')::numeric,0)+public.native_sales_int_v1(ln->'unitPriceCents')*q,'recipes',coalesce(g->'recipes','[]'::jsonb)||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('quantity',q,'recipe',ln->'recipe'))));
 end loop;
 for previous in select value from pg_catalog.jsonb_array_elements(prior) loop
  already:=already+public.native_sales_int_v1(previous->'amountCents');cash_already:=cash_already+public.native_sales_int_v1(previous->'cashRefundCents');
  for it in select value from pg_catalog.jsonb_array_elements(previous->'items') loop key:=it->>'key';returned:=pg_catalog.jsonb_set(returned,array[key],pg_catalog.to_jsonb(coalesce((returned->>key)::numeric,0)+public.native_sales_int_v1(it->'quantity',2147483647)));end loop;
  for serial in select value from pg_catalog.jsonb_array_elements(previous->'serials') loop old_serials:=old_serials||pg_catalog.jsonb_build_array(serial->>'text');end loop;
 end loop;
 for it in select value from pg_catalog.jsonb_array_elements(items) loop
  perform public.native_sales_object_v1(it,array['key','quantity']);key:=it->>'key';q:=public.native_sales_int_v1(it->'quantity',2147483647);if key is null or not groups ? key or requested ? key or q<=0 then raise exception 'NATIVE_RETURN_QUANTITY_INVALID';end if;requested:=pg_catalog.jsonb_set(requested,array[key],pg_catalog.to_jsonb(q));
 end loop;
 for key,g in select e.key,e.value from pg_catalog.jsonb_each(groups) e order by e.key collate "C" loop
  sold:=(g->>'quantity')::numeric;left_qty:=sold-coalesce((returned->>key)::numeric,0);q:=coalesce((requested->>key)::numeric,0);if q>left_qty or left_qty<0 then raise exception 'NATIVE_RETURN_QUANTITY_INVALID';end if;
  all_remaining:=all_remaining and q=left_qty;gross:=gross+(g->>'gross')::numeric;if q=0 then continue;end if;
  out_items:=out_items||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('key',key,'quantity',q::bigint::text));weight_n:=weight_n*sold+(g->>'gross')::numeric*q*weight_d;weight_d:=weight_d*sold;
  recipes:=g->'recipes';if q<sold and exists(select 1 from pg_catalog.jsonb_array_elements(recipes) x where x->'recipe' is distinct from recipes->0->'recipe') then raise exception 'NATIVE_RETURN_STOCK_AMBIGUOUS';end if;
  if key like 'free/%' then continue;end if;
  for recipe in select value from pg_catalog.jsonb_array_elements(recipes) loop
   factor_n:=(recipe->>'quantity')::numeric*q;factor_d:=sold;
   if pg_catalog.jsonb_array_length(recipe->'recipe')=0 then recipe:=pg_catalog.jsonb_set(recipe,'{recipe}',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',key,'perUnit',pg_catalog.jsonb_build_object('numerator','1','denominator','1'))));end if;
   for part in select value from pg_catalog.jsonb_array_elements(recipe->'recipe') loop
    pid:=part->>'productId';delta_n:=public.native_sales_int_v1(part->'perUnit'->'numerator')*factor_n;delta_d:=public.native_sales_int_v1(part->'perUnit'->'denominator')*factor_d;if delta_d<=0 then raise exception 'NATIVE_RETURN_BASIS_INVALID';end if;
    old_n:=coalesce((stock_map->pid->>'n')::numeric,0);old_d:=coalesce((stock_map->pid->>'d')::numeric,1);stock_map:=pg_catalog.jsonb_set(stock_map,array[pid],pg_catalog.jsonb_build_object('n',old_n*delta_d+delta_n*old_d,'d',old_d*delta_d));
   end loop;
  end loop;
 end loop;
 total:=public.native_sales_int_v1(sale->'totals'->'totalCents');remaining:=total-already;if gross<=0 or remaining<0 then raise exception 'NATIVE_RETURN_BASIS_INVALID';end if;
 amount:=case when all_remaining then remaining else least(remaining,pg_catalog.div(total*weight_n*2+weight_d*gross,weight_d*gross*2)) end;
 method:=sale->'payment'->>'method';original_cash:=public.native_sales_int_v1(sale->'payment'->'cashNetCents');if cash_already>original_cash then raise exception 'NATIVE_RETURN_BASIS_INVALID';end if;
 cash:=case when original_cash=0 then 0 when all_remaining then original_cash-cash_already when method='EFECTIVO' then least(amount,original_cash-cash_already) when total>0 then least(original_cash-cash_already,pg_catalog.div(amount*original_cash*2+total,total*2)) else 0 end;
 if cash>amount or method is null or method not in('EFECTIVO','TARJETA','TRANSFERENCIA','MIXTO','FIADO') then raise exception 'NATIVE_RETURN_BASIS_INVALID';end if;
 for pid,g in select e.key,e.value from pg_catalog.jsonb_each(stock_map) e order by e.key collate "C" loop delta_n:=(g->>'n')::numeric;delta_d:=(g->>'d')::numeric;if pg_catalog.mod(delta_n,delta_d)<>0 or pg_catalog.div(delta_n,delta_d)>2147483647 then raise exception 'NATIVE_RETURN_STOCK_FRACTIONAL';end if;stock:=stock||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'delta',pg_catalog.div(delta_n,delta_d)::bigint::text));end loop;
 for serial in select value from pg_catalog.jsonb_array_elements(sale->'serials') order by value->>'text' collate "C" loop
  sn:=serial->>'text';if selected ? sn then if old_serials ? sn then raise exception 'NATIVE_RETURN_SERIAL_INVALID';end if;ss:=ss||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',serial->>'productId','text',sn));end if;
 end loop;
 if pg_catalog.jsonb_array_length(ss)<>pg_catalog.jsonb_array_length(selected) then raise exception 'NATIVE_RETURN_SERIAL_INVALID';end if;
 for key,g in select e.key,e.value from pg_catalog.jsonb_each(requested) e loop
  if exists(select 1 from pg_catalog.jsonb_array_elements(sale->'serials') x where x->>'productId'=key) then select count(*) into count_serial from pg_catalog.jsonb_array_elements(ss) x where x->>'productId'=key;if count_serial<>(g#>>'{}')::numeric then raise exception 'NATIVE_RETURN_SERIAL_INVALID';end if;end if;
 end loop;
 if exists(select 1 from pg_catalog.jsonb_array_elements(ss) x where not requested ? (x->>'productId')) then raise exception 'NATIVE_RETURN_SERIAL_INVALID';end if;
 return pg_catalog.jsonb_build_object('items',out_items,'amountCents',amount::bigint::text,'cashRefundCents',cash::bigint::text,'bankRefundCents',case when method='FIADO' then '0' else (amount-cash)::bigint::text end,'creditAdjustmentCents',case when method='FIADO' then amount::bigint::text else '0' end,'method',method,'bankSettlementVerified',false,'inventory',stock,'serials',ss);
end $f$;
revoke all on function public.native_return_plan_v1(jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
create or replace function public.native_returns_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
#variable_conflict use_variable
declare v jsonb;req jsonb;doc jsonb;old public.native_sales_ledger_v1%rowtype;original public.native_sales_ledger_v1%rowtype;n uuid;op uuid;i uuid;d uuid;b uuid;k text;epoch bigint;role text;sale_id uuid;turn uuid;reason text;prior jsonb;prior_ids jsonb;revision_basis jsonb;rev text;refund jsonb;expected jsonb;stock_expected jsonb:='[]';proof jsonb;part jsonb;pend jsonb;pid uuid;cur integer;after integer;delta integer;version bigint;expected_version bigint;effective numeric;projection numeric;seq bigint;sn text;serial_proof jsonb:='[]';credit jsonb:='null';cid uuid;before bigint;bal_rev bigint;amount bigint;receipt jsonb;effects jsonb;stock jsonb:='[]';clock_ms text;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 or p_snapshot is not null or p_snapshot_hash is not null then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;if v->>'kind' is distinct from 'SALE_RETURN' or public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent) is distinct from p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 if v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or v->'expectedVersions' is distinct from '{}'::jsonb or v->'dependencies' is distinct from '[]'::jsonb then raise exception 'NATIVE_INTENT_INVALID';end if;
 perform public.native_sales_int_v1(v->'originAtUtcMs');n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or (v->>'actorId')::uuid is distinct from auth.uid() or role not in('owner','admin') or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role) then raise exception using errcode='42501',message='NATIVE_INTENT_CONTEXT_INVALID';end if;
 if not exists(select 1 from public.native_sales_mode_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b) then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is not null or old.snapshot_text is not null then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 perform public.native_sales_object_v1(v->'payload',array['request','document']);req:=v->'payload'->'request';doc:=v->'payload'->'document';perform public.native_sales_object_v1(req,array['kind','operationId','saleId','expectedReturnRevision','items','serials','reason','turnId']);
 sale_id:=(req->>'saleId')::uuid;turn:=(req->>'turnId')::uuid;reason:=req->>'reason';if req->>'kind' is distinct from 'SALE_RETURN' or req->>'operationId' is distinct from op::text or v->>'originalTurnId' is distinct from turn::text or pg_catalog.jsonb_typeof(req->'reason') is distinct from 'string' or pg_catalog.length(reason) not between 1 and 256 or pg_catalog.btrim(reason)<>reason or reason ~ '[[:cntrl:]]' then raise exception 'NATIVE_RETURN_REQUEST_INVALID';end if;
 if not exists(select 1 from public.native_sales_turns_v1 t where t.negocio_id=n and t.turn_id=turn and t.scope_kind=k and t.sucursal_id is not distinct from b and t.status='OPEN' and (v->>'originAtUtcMs')::bigint>=t.opened_at_ms::bigint) then raise exception 'NATIVE_TURN_REQUIRED';end if;
 select * into original from public.native_sales_ledger_v1 where negocio_id=n and operation_id=sale_id and kind='SALE_CONFIRM' and scope_kind=k and sucursal_id is not distinct from b;
 if not found or original.snapshot_text is null or original.ncf is not null then raise exception 'NATIVE_RETURN_BASIS_OR_FISCAL_PENDING';end if;
 if (v->>'originAtUtcMs')::bigint<(original.intent_text::jsonb->>'originAtUtcMs')::bigint then raise exception 'NATIVE_RETURN_DATE_INVALID';end if;
 select coalesce(pg_catalog.jsonb_agg(m.document->'refund' order by m.operation_id),'[]'),coalesce(pg_catalog.jsonb_agg(m.operation_id order by m.operation_id),'[]'),coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('operationId',m.operation_id,'refund',m.document->'refund') order by m.operation_id),'[]') into prior,prior_ids,revision_basis from public.native_management_records_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b and m.kind='SALE_RETURN' and m.document->>'saleId'=sale_id::text;
 rev:=public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object('snapshotHash',original.snapshot_hash,'returns',revision_basis)));if req->>'expectedReturnRevision' is distinct from rev then raise exception 'NATIVE_RETURN_CHANGED';end if;
 refund:=public.native_return_plan_v1(original.snapshot_text::jsonb->'sale',prior,req->'items',req->'serials');amount:=(refund->>'amountCents')::bigint;
 if pg_catalog.jsonb_typeof(doc->'stock') is distinct from 'array' or pg_catalog.jsonb_array_length(doc->'stock')<>pg_catalog.jsonb_array_length(refund->'inventory') then raise exception 'NATIVE_RETURN_STOCK_INVALID';end if;
 for part in select value from pg_catalog.jsonb_array_elements(doc->'stock') loop
  pid:=(part->>'productId')::uuid;delta:=public.native_sales_int_v1(part->'delta',2147483647)::integer;if not refund->'inventory' @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text)) then raise exception 'NATIVE_RETURN_STOCK_INVALID';end if;
  proof:=part->'stockEvidence';perform public.native_sales_object_v1(proof,array['productId','remoteBaseQty','remoteSequence','pending','effectiveQty']);if proof->>'productId' is distinct from pid::text or pg_catalog.jsonb_typeof(proof->'pending') is distinct from 'array' or pg_catalog.jsonb_array_length(proof->'pending')>1000 or (select count(distinct x->>'effectId') from pg_catalog.jsonb_array_elements(proof->'pending') x)<>pg_catalog.jsonb_array_length(proof->'pending') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
  select revision into version from public.native_sales_stock_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid for update;if not found then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
  if k='BRANCH' then select stock_actual into cur from public.inventario_sucursales where sucursal_id=b and producto_id=pid for update;else select stock_actual into cur from public.productos where negocio_id=n and id=pid for update;end if;if cur is null then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
  effective:=public.native_sales_int_v1(proof->'remoteBaseQty',2147483647);expected_version:=public.native_sales_int_v1(proof->'remoteSequence')::bigint;
  for pend in select value from pg_catalog.jsonb_array_elements(proof->'pending') loop select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=(pend->>'operationId')::uuid and installation_id=i and scope_kind=k and sucursal_id is not distinct from b;if not found or not exists(select 1 from public.native_sales_effects_v1 x where x.negocio_id=n and x.operation_id=old.operation_id and x.effect_id=(pend->>'effectId')::uuid and x.kind='STOCK' and x.payload->>'productId'=pid::text and x.payload->>'delta'=pend->>'delta') then raise exception 'NATIVE_PENDING_COVERAGE_INVALID';end if;effective:=effective+(pend->>'delta')::integer;expected_version:=greatest(expected_version,old.remote_sequence);end loop;
  if version<>expected_version or effective<>cur or public.native_sales_int_v1(proof->'effectiveQty',2147483647)<>cur or part->>'expectedRevision' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object('quantity',proof->>'effectiveQty','remoteSequence',proof->>'remoteSequence','pending',proof->'pending'))) then raise exception 'NATIVE_STOCK_VERSION_CONFLICT';end if;
  after:=cur+delta;stock_expected:=stock_expected||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text,'before',cur::text,'after',after::text,'expectedRevision',part->>'expectedRevision','stockEvidence',proof));
 end loop;
 for part in select value from pg_catalog.jsonb_array_elements(refund->'serials') loop sn:=part->>'text';pid:=(part->>'productId')::uuid;if not exists(select 1 from public.seriales z where z.negocio_id=n and z.producto_id=pid and z.numero_serial=sn and z.estado='vendido' and z.venta_id=sale_id) then raise exception 'NATIVE_RETURN_SERIAL_INVALID';end if;serial_proof:=serial_proof||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'text',sn,'expectedRevision','1'));end loop;
 if refund->>'method'='FIADO' then cid:=(original.snapshot_text::jsonb->'sale'->'payment'->>'customerId')::uuid;select balance_cents,revision into before,bal_rev from public.native_sales_credit_v1 where negocio_id=n and cliente_id=cid for update;if before is null or before<amount then raise exception 'NATIVE_RETURN_PAID_CREDIT_PENDING';end if;credit:=pg_catalog.jsonb_build_object('customerId',cid,'beforeCents',before::text,'afterCents',(before-amount)::text,'expectedRevision',bal_rev::text);end if;
 expected:=pg_catalog.jsonb_build_object('saleId',sale_id,'originalSnapshotHash',original.snapshot_hash,'priorReturnIds',prior_ids,'returnRevision',rev,'refund',refund,'stock',stock_expected,'serialProof',serial_proof,'credit',credit,'method',refund->>'method','amountCents',amount::text,'concept',reason,'cashDeltaCents',(-(refund->>'cashRefundCents')::bigint)::text);if expected is distinct from doc then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'management'),'kind','SALE_RETURN','payload',doc));
 for part in select value from pg_catalog.jsonb_array_elements(stock_expected) loop
  pid:=(part->>'productId')::uuid;delta:=(part->>'delta')::integer;after:=(part->>'after')::integer;
  if k='BRANCH' then select sum(z.stock_actual) into projection from public.inventario_sucursales z where z.producto_id=pid;if projection is distinct from (select p.stock_actual::numeric from public.productos p where p.id=pid and p.negocio_id=n) then raise exception 'NATIVE_STOCK_DIVERGENCE';end if;update public.inventario_sucursales set stock_actual=after,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where sucursal_id=b and producto_id=pid;update public.productos set stock_actual=(projection+delta)::integer,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;else update public.productos set stock_actual=after,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;end if;
  update public.native_sales_stock_v1 set revision=seq where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid;effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'stock/'||pid::text),'kind','STOCK','payload',pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text)));stock:=stock||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'after',after::text,'version',seq::text));
 end loop;
 for part in select value from pg_catalog.jsonb_array_elements(serial_proof) loop update public.seriales set estado='disponible',venta_id=null,fecha_venta=null,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where negocio_id=n and producto_id=(part->>'productId')::uuid and numero_serial=part->>'text' and estado='vendido' and venta_id=sale_id;end loop;
 if cid is not null then update public.native_sales_credit_v1 set balance_cents=before-amount,revision=revision+1 where negocio_id=n and cliente_id=cid;end if;
 clock_ms:=(pg_catalog.trunc(extract(epoch from pg_catalog.clock_timestamp())*1000))::bigint::text;receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',null,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',null,'ncf',null,'totalCents',null,'effects',effects,'stock',stock);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,'SALE_RETURN',p_intent,p_hash,null,null,null,null,seq,receipt);for part in select value from pg_catalog.jsonb_array_elements(effects) loop insert into public.native_sales_effects_v1 values(n,op,(part->>'id')::uuid,part->>'kind',part->'payload');end loop;
 insert into public.native_management_records_v1 values(n,op,k,b,'SALE_RETURN',turn,cid,refund->>'method',amount,reason,v->>'originAtUtcMs',doc);delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;return receipt;
end $f$;
revoke all on function public.native_returns_submit_v1(text,text,text,text) from public,anon,authenticated;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
begin
 if p_intent::jsonb->>'kind'='SALE_RETURN' then return public.native_returns_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);elsif p_intent::jsonb->>'kind' in('PRODUCT_CREATE','PRODUCT_PATCH','PRODUCT_DELETE','INVENTORY_DELTA','INVENTORY_COUNT') then return public.native_inventory_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);else return public.native_management_submit_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end if;
end $f$;
revoke all on function public.native_sales_submit_v1(text,text,text,text) from public,anon;
grant execute on function public.native_sales_submit_v1(text,text,text,text) to authenticated;

-- Source: 20261012153049_native_repairs_staging_v1.sql SHA256 5c43f66bd12cc01d659e0ab5112f66fee0b364c7cacf9ada8a2cbe5eb84aa405
do $guard$ begin

end $guard$;
create or replace function public.native_repair_plan_v1(req jsonb,previous jsonb,at_ms text,actor uuid,folio text,folio_number text) returns jsonb
language plpgsql immutable set search_path='' as $f$
#variable_conflict use_variable
declare r jsonb;def jsonb;part jsonb;field text;field_value text;parts jsonb:='[]';checks jsonb;seen text[]:='{}';qty bigint;price bigint;total numeric:=0;paid bigint;amount bigint;revision bigint;state text;next_state text;action text;method text;payment_type text:='abono';payment jsonb:='null';days bigint;uncosted boolean;
begin
 revision:=public.native_sales_int_v1(req->'expectedRevision',2147483646)::bigint;
 if previous is null then
  if revision<>0 or req->>'kind' is distinct from 'REPAIR_SAVE' then raise exception 'NATIVE_SERVICE_VERSION';end if;
  r:=pg_catalog.jsonb_build_object('id',req->>'repairId','revision','0','folio',folio,'folioNumber',folio_number,'state','recibido','definition','{}'::jsonb,'totalCents','0','paidCents','0','payments','[]'::jsonb,'log','[]'::jsonb,'createdAtMs',at_ms,'updatedAtMs',at_ms,'deliveredAtMs',null,'warrantyDays','0','warrantyUntilMs',null);
 else
  r:=previous;if r->>'revision' is distinct from revision::text or (r->>'updatedAtMs')::bigint>at_ms::bigint then raise exception 'NATIVE_SERVICE_VERSION';end if;
 end if;
 state:=r->>'state';next_state:=state;paid:=public.native_sales_int_v1(r->'paidCents')::bigint;
 if state in('entregado','cancelado','no_reparado','abandonado') and not(req->>'kind'='REPAIR_DISASSEMBLE' and state='abandonado') then raise exception 'NATIVE_SERVICE_STATE_INVALID';end if;
 if req->>'kind'='REPAIR_DISASSEMBLE' then
  perform public.native_sales_object_v1(req,array['kind','operationId','repairId','expectedRevision','entries']);if state<>'abandonado' or pg_catalog.jsonb_typeof(req->'entries') is distinct from 'array' or pg_catalog.jsonb_array_length(req->'entries') not between 1 and 100 then raise exception 'NATIVE_SERVICE_STATE_INVALID';end if;
  next_state:='cancelado';amount:=0;r:=pg_catalog.jsonb_set(r,'{definition,notes}',pg_catalog.to_jsonb(case when r->'definition'->>'notes'='' then 'Equipo abandonado y despiezado' else (r->'definition'->>'notes')||' · Equipo abandonado y despiezado' end));
 elsif req->>'kind'='REPAIR_SAVE' then
  perform public.native_sales_object_v1(req,array['kind','operationId','repairId','expectedRevision','definition','quote','initialPaymentCents','method','turnId']);
  def:=req->'definition';perform public.native_sales_object_v1(def,array['customerId','customerName','phone','brand','model','imei','color','conditionChecks','conditionNotes','accessories','problem','diagnosis','notes','technician','labourCents','partsChargeSeparate','parts']);
  if pg_catalog.jsonb_typeof(req->'quote') is distinct from 'boolean' or pg_catalog.jsonb_typeof(def->'partsChargeSeparate') is distinct from 'boolean' or pg_catalog.jsonb_typeof(def->'customerId') not in('string','null') or ((def->>'customerId') is not null and (def->>'customerId')::uuid is null) then raise exception 'NATIVE_SERVICE_DEFINITION_INVALID';end if;
  for field in select unnest(array['customerName','phone','brand','model','imei','color','conditionNotes','accessories','problem','diagnosis','notes','technician']) loop
   field_value:=def->>field;
   if pg_catalog.jsonb_typeof(def->field) is distinct from 'string' or pg_catalog.btrim(field_value)<>field_value or pg_catalog.regexp_replace(field_value,E'\n','','g') ~ '[[:cntrl:]]' or pg_catalog.length(field_value)>(case field when 'customerName' then 256 when 'phone' then 64 when 'brand' then 128 when 'model' then 256 when 'imei' then 128 when 'color' then 64 when 'conditionNotes' then 2000 when 'accessories' then 1000 when 'problem' then 2000 when 'technician' then 256 else 4000 end) or (field in('customerName','model','problem') and field_value='') then raise exception 'NATIVE_SERVICE_DEFINITION_INVALID';end if;
  end loop;
  checks:=def->'conditionChecks';if pg_catalog.jsonb_typeof(checks) is distinct from 'array' or pg_catalog.jsonb_array_length(checks)>9 or (select count(distinct x) from pg_catalog.jsonb_array_elements(checks) x)<>pg_catalog.jsonb_array_length(checks) or exists(select 1 from pg_catalog.jsonb_array_elements_text(checks) x where x not in('Enciende','Pantalla con rayones','Pantalla rota / estrellada','No enciende','Mojado / humedad','Carcasa / tapa dañada','Botones con falla','Con funda / mica','Sin bandeja SIM')) then raise exception 'NATIVE_SERVICE_DEFINITION_INVALID';end if;
  if pg_catalog.jsonb_typeof(def->'parts') is distinct from 'array' or pg_catalog.jsonb_array_length(def->'parts')>100 then raise exception 'NATIVE_SERVICE_PART_INVALID';end if;
  total:=public.native_sales_int_v1(def->'labourCents');
  for part in select value from pg_catalog.jsonb_array_elements(def->'parts') loop
   perform public.native_sales_object_v1(part,array['productId','name','quantity','costCents','priceCents']);qty:=public.native_sales_int_v1(part->'quantity',2147483647)::bigint;price:=public.native_sales_int_v1(part->'priceCents')::bigint;perform public.native_sales_int_v1(part->'costCents');
   if qty<=0 or pg_catalog.jsonb_typeof(part->'name') is distinct from 'string' or pg_catalog.length(part->>'name') not between 1 and 256 or pg_catalog.btrim(part->>'name')<>part->>'name' or pg_catalog.regexp_replace(part->>'name',E'\n','','g') ~ '[[:cntrl:]]' or pg_catalog.jsonb_typeof(part->'productId') not in('string','null') then raise exception 'NATIVE_SERVICE_PART_INVALID';end if;
   if part->>'productId' is not null then if (part->>'productId')::uuid is null or (part->>'productId')=any(seen) then raise exception 'NATIVE_SERVICE_PART_INVALID';end if;seen:=pg_catalog.array_append(seen,part->>'productId');end if;
   if (def->>'partsChargeSeparate')::boolean then total:=total+price::numeric*qty;else part:=pg_catalog.jsonb_set(part,'{priceCents}','"0"');end if;parts:=parts||pg_catalog.jsonb_build_array(part);
  end loop;
  if total>9007199254740991 then raise exception 'NATIVE_SERVICE_AMOUNT_INVALID';end if;
  amount:=public.native_sales_int_v1(req->'initialPaymentCents')::bigint;if revision<>0 and amount<>0 then raise exception 'NATIVE_SERVICE_AMOUNT_INVALID';end if;
  if def ? 'warrantyOriginId' then if (def->>'warrantyOriginId')::uuid is null or total<>0 or amount<>0 then raise exception 'NATIVE_SERVICE_GUARANTEE_FREE';end if;end if;
  if revision>0 and def->'warrantyOriginId' is distinct from previous->'definition'->'warrantyOriginId' then raise exception 'NATIVE_SERVICE_STATE_INVALID';end if;
  uncosted:=not (req->>'quote')::boolean and total=0 and parts='[]'::jsonb and state in('recibido','diagnostico');
  if paid::numeric+amount>9007199254740991 or (paid::numeric+amount>total and not uncosted) then raise exception 'NATIVE_SERVICE_OVERPAY';end if;
  if (req->>'quote')::boolean then if state not in('recibido','diagnostico','cotizado') then raise exception 'NATIVE_SERVICE_STATE_INVALID';end if;next_state:='cotizado';end if;
  def:=pg_catalog.jsonb_set(def,'{parts}',parts);r:=r||pg_catalog.jsonb_build_object('definition',def,'totalCents',total::bigint::text);
 elsif req->>'kind'='REPAIR_ACTION' then
  perform public.native_sales_object_v1(req,array['kind','operationId','repairId','expectedRevision','action','amountCents','method','turnId','warrantyDays']);
  action:=req->>'action';amount:=public.native_sales_int_v1(req->'amountCents')::bigint;days:=public.native_sales_int_v1(req->'warrantyDays',3650)::bigint;total:=public.native_sales_int_v1(r->'totalCents');
  if r->'definition' ? 'warrantyOriginId' and amount>0 then raise exception 'NATIVE_SERVICE_GUARANTEE_FREE';end if;
  next_state:=case when action='PAYMENT' then state when action='DIAGNOSE' and state='recibido' then 'diagnostico' when action='APPROVE' and state='cotizado' then 'en_reparacion' when action in('WORK','WAIT','READY') and state in('en_reparacion','esperando_repuesto','listo') then case action when 'WORK' then 'en_reparacion' when 'WAIT' then 'esperando_repuesto' else 'listo' end when action='DELIVER' and state='listo' then 'entregado' when action in('REJECT','ABANDON') and state='cotizado' then case action when 'REJECT' then 'no_reparado' else 'abandonado' end when action='CANCEL' then 'cancelado' else null end;
  if next_state is null then raise exception 'NATIVE_SERVICE_STATE_INVALID';end if;
  if action='DELIVER' then
   if amount<>0 or paid>total then raise exception 'NATIVE_SERVICE_OVERPAY';end if;amount:=total-paid;payment_type:='final';if at_ms::numeric+days*86400000>9007199254740991 then raise exception 'NATIVE_SERVICE_DATE_INVALID';end if;
   r:=r||pg_catalog.jsonb_build_object('deliveredAtMs',at_ms,'warrantyDays',days::text,'warrantyUntilMs',case when days=0 then null else (at_ms::bigint+days*86400000)::text end);
  elsif action='PAYMENT' then if amount<=0 or amount>total-paid then raise exception 'NATIVE_SERVICE_OVERPAY';end if;
  elsif action in('REJECT','ABANDON') then if paid::numeric+amount>9007199254740991 then raise exception 'NATIVE_SERVICE_OVERPAY';end if;r:=pg_catalog.jsonb_set(r,'{definition,labourCents}','"0"')||pg_catalog.jsonb_build_object('totalCents',amount::text,'settlementPendingCents',paid::text);payment_type:='revision';
  elsif amount<>0 then raise exception 'NATIVE_SERVICE_AMOUNT_INVALID';end if;
 else raise exception 'NATIVE_SERVICE_REQUEST_INVALID';end if;
 method:=case when req->>'kind'='REPAIR_DISASSEMBLE' then 'EFECTIVO' else req->>'method' end;if method not in('EFECTIVO','TARJETA','TRANSFERENCIA') or method is null or (req->>'kind'<>'REPAIR_DISASSEMBLE' and pg_catalog.jsonb_typeof(req->'turnId') not in('string','null')) then raise exception 'NATIVE_SERVICE_PAYMENT_INVALID';end if;
 if amount>0 then
  if method='EFECTIVO' and req->>'turnId' is null then raise exception 'NATIVE_TURN_REQUIRED';end if;
  payment:=pg_catalog.jsonb_build_object('operationId',req->>'operationId','amountCents',amount::text,'method',method,'turnId',req->>'turnId','dateMs',at_ms,'type',payment_type);
  r:=r||pg_catalog.jsonb_build_object('payments',(r->'payments')||pg_catalog.jsonb_build_array(payment),'paidCents',(paid+amount)::text);
 end if;
 if revision=0 then r:=pg_catalog.jsonb_set(r,'{log}',(r->'log')||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('state','recibido','dateMs',at_ms,'actorId',actor)));end if;
 if next_state<>state then r:=pg_catalog.jsonb_set(r,'{log}',(r->'log')||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('state',next_state,'dateMs',at_ms,'actorId',actor)));end if;
 r:=r||pg_catalog.jsonb_build_object('state',next_state,'revision',(revision+1)::text,'updatedAtMs',at_ms);
 return pg_catalog.jsonb_build_object('operationId',req->>'operationId','repair',r,'payment',payment,'amountCents',amount::text,'method',case when amount=0 then null else method end,'concept','Reparación '||(r->>'folio'))||case when amount>0 and req->>'turnId' is not null then pg_catalog.jsonb_build_object('cashDeltaCents',case when method='EFECTIVO' then amount::text else '0' end) else '{}'::jsonb end;
end $f$;
revoke all on function public.native_repair_plan_v1(jsonb,jsonb,text,uuid,text,text) from public,anon,authenticated;
create or replace function public.native_repair_reserved_v1(r jsonb) returns jsonb language plpgsql immutable set search_path='' as $f$
declare part jsonb;stock jsonb:='{}';begin
 if r is null or r->>'state' in('cancelado','no_reparado','abandonado') then return stock;end if;
 for part in select value from pg_catalog.jsonb_array_elements(r->'definition'->'parts') loop if part->>'productId' is not null then stock:=stock||pg_catalog.jsonb_build_object(part->>'productId',part->>'quantity');end if;end loop;return stock;
end $f$;
revoke all on function public.native_repair_reserved_v1(jsonb) from public,anon,authenticated;
create or replace function public.native_repairs_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
#variable_conflict use_variable
declare v jsonb;req jsonb;doc jsonb;previous jsonb;repair jsonb;expected jsonb;business jsonb;old public.native_sales_ledger_v1%rowtype;
 n uuid;op uuid;i uuid;d uuid;b uuid;k text;kind text;epoch bigint;role text;rid uuid;turn uuid;revision bigint;amount bigint;folio text;folio_number bigint;stock_before jsonb;stock_after jsonb;stock_map jsonb:='{}';stock_expected jsonb:='[]';proof jsonb;part jsonb;pend jsonb;pid uuid;delta integer;cur integer;after integer;version bigint;expected_version bigint;effective numeric;projection numeric;seq bigint;receipt jsonb;effects jsonb;stock jsonb:='[]';clock_ms text;val bigint;customer uuid;original_warranty jsonb;field text;created_products jsonb:='[]';created_ids text[]:='{}';recover_ids text[]:='{}';definition jsonb;product_doc jsonb;product_request jsonb;cost bigint;name text;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 or p_snapshot is not null or p_snapshot_hash is not null then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;kind:=v->>'kind';if kind not in('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') or kind is null or public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent) is distinct from p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 if v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or v->'expectedVersions' is distinct from '{}'::jsonb or v->'dependencies' is distinct from '[]'::jsonb then raise exception 'NATIVE_INTENT_INVALID';end if;
 perform public.native_sales_int_v1(v->'originAtUtcMs');n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or (v->>'actorId')::uuid is distinct from auth.uid() or role not in('owner','admin') or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role and rr.receipt->'license'->>'planTier'='pro') then raise exception using errcode='42501',message='NATIVE_PRO_REQUIRED';end if;
 perform 1 from public.native_entitlements_v1 where negocio_id=n and plan_tier='pro' for share;if not found then raise exception using errcode='42501',message='NATIVE_PRO_REQUIRED';end if;
 if not exists(select 1 from public.native_sales_mode_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b) then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is not null or old.snapshot_text is not null then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 perform public.native_sales_object_v1(v->'payload',array['request','document']);req:=v->'payload'->'request';doc:=v->'payload'->'document';rid:=(req->>'repairId')::uuid;revision:=public.native_sales_int_v1(req->'expectedRevision',2147483646)::bigint;
 if req->>'operationId' is distinct from op::text or rid is null or (kind='REPAIR_CREATE')<>(revision=0) then raise exception 'NATIVE_SERVICE_REQUEST_INVALID';end if;
 select m.document into previous from public.native_management_records_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b and m.kind in('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') and m.document->'repair'->>'id'=rid::text order by (m.document->'repair'->>'revision')::bigint desc limit 1;
 if revision=0 then
  if previous is not null or exists(select 1 from public.native_management_records_v1 where document->'repair'->>'id'=rid::text) then raise exception 'NATIVE_SERVICE_VERSION';end if;
  folio_number:=public.native_sales_int_v1(doc->'repair'->'folioNumber')::bigint;if folio_number<=0 then raise exception 'NATIVE_SERVICE_FOLIO_INVALID';end if;
  folio:='REP-N'||pg_catalog.replace(i::text,'-','')||'-'||case when folio_number<1000 then pg_catalog.lpad(folio_number::text,3,'0') else folio_number::text end;
  if exists(select 1 from public.native_management_records_v1 where negocio_id=n and kind='REPAIR_CREATE' and document->'repair'->>'folio'=folio) then raise exception 'NATIVE_SERVICE_FOLIO_INVALID';end if;
  business:=doc->'business';if business is null or pg_catalog.jsonb_typeof(business) not in('object','null') then raise exception 'NATIVE_SERVICE_HEADER_INVALID';end if;
  if business<>'null'::jsonb and not exists(select 1 from public.native_sales_snapshots_v1 ss where ss.negocio_id=n and ss.installation_id=i and ss.scope_kind=k and ss.sucursal_id is not distinct from b and ss.manifest->'business'=business) then raise exception 'NATIVE_SERVICE_HEADER_INVALID';end if;
 else
  if previous is null then raise exception 'NATIVE_SERVICE_VERSION';end if;folio:=previous->'repair'->>'folio';folio_number:=(previous->'repair'->>'folioNumber')::bigint;business:=previous->'business';
 end if;
 expected:=public.native_repair_plan_v1(req,previous->'repair',v->>'originAtUtcMs',auth.uid(),folio,folio_number::text);repair:=expected->'repair';amount:=(expected->>'amountCents')::bigint;turn:=(expected->'payment'->>'turnId')::uuid;
 if revision=0 and repair->'definition' ? 'warrantyOriginId' then
  select mr.document->'repair' into original_warranty from public.native_management_records_v1 mr where mr.negocio_id=n and mr.scope_kind=k and mr.sucursal_id is not distinct from b and mr.kind in('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') and mr.document->'repair'->>'id'=repair->'definition'->>'warrantyOriginId' order by (mr.document->'repair'->>'revision')::bigint desc limit 1;
  if original_warranty is null or original_warranty->>'state' is distinct from 'entregado' or original_warranty->>'warrantyUntilMs' is null or (original_warranty->>'deliveredAtMs')::bigint>(v->>'originAtUtcMs')::bigint or (original_warranty->>'warrantyUntilMs')::bigint<(v->>'originAtUtcMs')::bigint or original_warranty->>'id'=rid::text then raise exception 'NATIVE_SERVICE_GUARANTEE_EXPIRED';end if;
  foreach field in array array['customerId','customerName','phone','brand','model','imei','color'] loop if original_warranty->'definition'->field is distinct from repair->'definition'->field then raise exception 'NATIVE_SERVICE_STATE_INVALID';end if;end loop;
 end if;
 if v->>'originalTurnId' is distinct from turn::text then raise exception 'NATIVE_SERVICE_TURN_INVALID';end if;
 if amount>0 and turn is not null and not exists(select 1 from public.native_sales_turns_v1 t where t.negocio_id=n and t.turn_id=turn and t.scope_kind=k and t.sucursal_id is not distinct from b and t.status='OPEN' and (v->>'originAtUtcMs')::bigint>=t.opened_at_ms::bigint) then raise exception 'NATIVE_TURN_REQUIRED';end if;
 if req->>'kind'='REPAIR_SAVE' then
  customer:=(repair->'definition'->>'customerId')::uuid;
  if req ? 'createCustomer' and pg_catalog.jsonb_typeof(req->'createCustomer') is distinct from 'boolean' then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  if req->'createCustomer'='true'::jsonb then
   if customer is null or repair->'definition' ? 'warrantyOriginId' or exists(select 1 from public.clientes where id=customer) then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   expected:=expected||pg_catalog.jsonb_build_object('customer',pg_catalog.jsonb_build_object('id',customer,'name',repair->'definition'->>'customerName','phone',nullif(repair->'definition'->>'phone',''),'limitCents','0','priceTier',1,'wholesale',false,'active',true,'revision','1'));
  elsif customer is not null and not exists(select 1 from public.clientes c where c.id=customer and c.negocio_id=n and not coalesce(c.eliminado,false)) then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  for part in select value from pg_catalog.jsonb_array_elements(repair->'definition'->'parts') loop
   if part->>'productId' is not null and not exists(select 1 from public.productos p where p.id=(part->>'productId')::uuid and p.negocio_id=n and not coalesce(p.eliminado,false) and not coalesce(p.serializable,false) and p.tipo is distinct from 'combo' and not exists(select 1 from public.composiciones c where c.producto_padre_id=p.id and c.negocio_id=n)) then raise exception 'NATIVE_SERVICE_PART_UNSUPPORTED';end if;
  end loop;
 end if;
 stock_before:=public.native_repair_reserved_v1(previous->'repair');stock_after:=public.native_repair_reserved_v1(repair);
 for pid in select key::uuid from pg_catalog.jsonb_object_keys(stock_before||stock_after) key order by key loop val:=coalesce((stock_before->>pid::text)::bigint,0)-coalesce((stock_after->>pid::text)::bigint,0);if val<>0 then stock_map:=stock_map||pg_catalog.jsonb_build_object(pid::text,val::text);end if;end loop;
 if kind='REPAIR_DISASSEMBLE' then
  if req->>'kind' is distinct from kind then raise exception 'NATIVE_SERVICE_REQUEST_INVALID';end if;
  for part in select value from pg_catalog.jsonb_array_elements(req->'entries') loop
   perform public.native_sales_object_v1(part,array['productId','quantity','newProduct']);pid:=(part->>'productId')::uuid;val:=public.native_sales_int_v1(part->'quantity',2147483647)::bigint;
   if pid is null or val<=0 or pid::text=any(recover_ids) then raise exception 'NATIVE_SERVICE_PART_INVALID';end if;recover_ids:=pg_catalog.array_append(recover_ids,pid::text);stock_map:=stock_map||pg_catalog.jsonb_build_object(pid::text,(coalesce((stock_map->>pid::text)::bigint,0)+val)::text);
   definition:=part->'newProduct';
   if definition is distinct from 'null'::jsonb then
    perform public.native_sales_object_v1(definition,array['name','code','priceCents','tier2Cents','tier3Cents','costCents','taxPercent','productType','location','minimum','serialRequired','recipe']);
    name:=definition->>'name';cost:=public.native_sales_int_v1(definition->'costCents',999999999999)::bigint;
    if pg_catalog.jsonb_typeof(definition->'name') is distinct from 'string' or pg_catalog.length(name) not between 1 and 256 or pg_catalog.btrim(name)<>name or name ~ '[[:cntrl:]]' or definition->>'productType' is distinct from 'insumo' or definition->>'code' is distinct from '' or definition->>'priceCents' is distinct from '0' or definition->'tier2Cents' is distinct from 'null'::jsonb or definition->'tier3Cents' is distinct from 'null'::jsonb or definition->>'taxPercent' is distinct from '0' or definition->>'location' is distinct from '' or definition->>'minimum' is distinct from '0' or definition->'serialRequired' is distinct from 'false'::jsonb or definition->'recipe' is distinct from '[]'::jsonb or exists(select 1 from public.productos where id=pid) then raise exception 'NATIVE_SERVICE_PART_INVALID';end if;
    product_doc:=pg_catalog.jsonb_build_object('product',pg_catalog.jsonb_build_object('id',pid,'name',name,'code','','revision','1','deleted',false,'priceTiers',pg_catalog.jsonb_build_object('retailCents','0','tier2Cents',null,'tier3Cents',null),'metadata',pg_catalog.jsonb_build_object('costCents',cost::text,'taxRate',pg_catalog.jsonb_build_object('numerator','0','denominator','1'),'serialRequired',false,'recipe','[]'::jsonb,'productType','insumo','recipeCostPolicy','DECLARED','location','','minimum','0')));
    product_request:=pg_catalog.jsonb_build_object('kind','PRODUCT_SAVE','operationId',op,'productId',pid,'expectedRevision','0','definition',definition);
    created_products:=created_products||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('request',product_request,'document',product_doc));created_ids:=pg_catalog.array_append(created_ids,pid::text);
   elsif not exists(select 1 from public.productos p where p.id=pid and p.negocio_id=n and not coalesce(p.eliminado,false) and not coalesce(p.serializable,false) and p.tipo is distinct from 'combo' and not exists(select 1 from public.composiciones c where c.producto_padre_id=p.id and c.negocio_id=n)) then raise exception 'NATIVE_SERVICE_PART_UNSUPPORTED';end if;
  end loop;
  expected:=expected||pg_catalog.jsonb_build_object('products',created_products);
 end if;
 if pg_catalog.jsonb_typeof(doc->'stock') is distinct from 'array' or pg_catalog.jsonb_array_length(doc->'stock')<>(select count(*) from pg_catalog.jsonb_object_keys(stock_map)) or (select count(distinct x->>'productId') from pg_catalog.jsonb_array_elements(doc->'stock') x)<>pg_catalog.jsonb_array_length(doc->'stock') then raise exception 'NATIVE_SERVICE_STOCK_INVALID';end if;
 for part in select value from pg_catalog.jsonb_array_elements(doc->'stock') loop
  pid:=(part->>'productId')::uuid;delta:=(part->>'delta')::integer;if part->>'delta' is distinct from stock_map->>pid::text then raise exception 'NATIVE_SERVICE_STOCK_INVALID';end if;
  proof:=part->'stockEvidence';perform public.native_sales_object_v1(proof,array['productId','remoteBaseQty','remoteSequence','pending','effectiveQty']);if proof->>'productId' is distinct from pid::text or pg_catalog.jsonb_typeof(proof->'pending') is distinct from 'array' or pg_catalog.jsonb_array_length(proof->'pending')>1000 or (select count(distinct x->>'effectId') from pg_catalog.jsonb_array_elements(proof->'pending') x)<>pg_catalog.jsonb_array_length(proof->'pending') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
  if pid::text=any(created_ids) then
   version:=0;cur:=0;
  else
  select stock_revision.revision into version from public.native_sales_stock_v1 stock_revision where stock_revision.negocio_id=n and stock_revision.scope_kind=k and stock_revision.sucursal_id is not distinct from b and stock_revision.producto_id=pid for update;if not found then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
  if k='BRANCH' then select stock_actual into cur from public.inventario_sucursales where sucursal_id=b and producto_id=pid for update;else select stock_actual into cur from public.productos where negocio_id=n and id=pid for update;end if;if cur is null then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
  end if;
  effective:=public.native_sales_int_v1(proof->'remoteBaseQty',2147483647);expected_version:=public.native_sales_int_v1(proof->'remoteSequence')::bigint;
  for pend in select value from pg_catalog.jsonb_array_elements(proof->'pending') loop select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=(pend->>'operationId')::uuid and installation_id=i and scope_kind=k and sucursal_id is not distinct from b;if not found or not exists(select 1 from public.native_sales_effects_v1 x where x.negocio_id=n and x.operation_id=old.operation_id and x.effect_id=(pend->>'effectId')::uuid and x.kind='STOCK' and x.payload->>'productId'=pid::text and x.payload->>'delta'=pend->>'delta') then raise exception 'NATIVE_PENDING_COVERAGE_INVALID';end if;effective:=effective+(pend->>'delta')::integer;expected_version:=greatest(expected_version,old.remote_sequence);end loop;
  if version<>expected_version or effective<>cur or public.native_sales_int_v1(proof->'effectiveQty',2147483647)<>cur or part->>'expectedRevision' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object('quantity',proof->>'effectiveQty','remoteSequence',proof->>'remoteSequence','pending',proof->'pending'))) then raise exception 'NATIVE_STOCK_VERSION_CONFLICT';end if;
  after:=cur+delta;if after<0 then raise exception 'NATIVE_STOCK_INSUFFICIENT';end if;
  stock_expected:=stock_expected||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text,'before',cur::text,'after',after::text,'expectedRevision',part->>'expectedRevision','stockEvidence',proof));
 end loop;
 expected:=expected||pg_catalog.jsonb_build_object('stock',stock_expected,'business',business);if expected is distinct from doc then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'management'),'kind',kind,'payload',doc));
 if doc ? 'customer' then
  insert into public.clientes(id,negocio_id,nombre,limite_credito,eliminado,tipo_precio,fecha_actualizacion) values(customer,n,doc->'customer'->>'name',0,false,1,(v->>'originAtUtcMs')::bigint);
  insert into public.native_customer_metadata_v1 values(n,customer,doc->'customer'->>'phone',false,1);
  insert into public.native_sales_credit_v1 values(n,customer,0,1);
 end if;
 for part in select value from pg_catalog.jsonb_array_elements(created_products) loop
  pid:=(part->'document'->'product'->>'id')::uuid;definition:=part->'request'->'definition';
  insert into public.productos(id,negocio_id,nombre,codigo_barras,precio_venta,precio_2,precio_3,costo,stock_actual,stock_minimo,tasa_itbis,tipo,serializable,ubicacion,eliminado,fecha_actualizacion) values(pid,n,definition->>'name','',0,null,null,(definition->>'costCents')::numeric/100,0,0,0,'insumo',false,'',false,(v->>'originAtUtcMs')::bigint);
  if k='BRANCH' then insert into public.inventario_sucursales(sucursal_id,producto_id,stock_actual,stock_minimo,fecha_actualizacion) values(b,pid,0,0,(v->>'originAtUtcMs')::bigint);end if;
  insert into public.native_product_metadata_v1 values(n,pid,1,'',0);insert into public.native_sales_stock_v1(negocio_id,scope_kind,sucursal_id,producto_id,revision) values(n,k,b,pid,0);
 end loop;
 for part in select value from pg_catalog.jsonb_array_elements(stock_expected) loop
  pid:=(part->>'productId')::uuid;delta:=(part->>'delta')::integer;after:=(part->>'after')::integer;
  if k='BRANCH' then select sum(z.stock_actual) into projection from public.inventario_sucursales z where z.producto_id=pid;if projection is distinct from (select p.stock_actual::numeric from public.productos p where p.id=pid and p.negocio_id=n) then raise exception 'NATIVE_STOCK_DIVERGENCE';end if;update public.inventario_sucursales set stock_actual=after,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where sucursal_id=b and producto_id=pid;update public.productos set stock_actual=(projection+delta)::integer,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;else update public.productos set stock_actual=after,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;end if;
  update public.native_sales_stock_v1 set revision=seq where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid;effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'stock/'||pid::text),'kind','STOCK','payload',pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text)));stock:=stock||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'after',after::text,'version',seq::text));
 end loop;
 clock_ms:=(pg_catalog.trunc(extract(epoch from pg_catalog.clock_timestamp())*1000))::bigint::text;receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',null,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',null,'ncf',null,'totalCents',null,'effects',effects,'stock',stock);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,kind,p_intent,p_hash,null,null,null,null,seq,receipt);for part in select value from pg_catalog.jsonb_array_elements(effects) loop insert into public.native_sales_effects_v1 values(n,op,(part->>'id')::uuid,part->>'kind',part->'payload');end loop;
 insert into public.native_management_records_v1 values(n,op,k,b,kind,turn,null,expected->>'method',amount,expected->>'concept',v->>'originAtUtcMs',doc);delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;return receipt;
end $f$;
revoke all on function public.native_repairs_submit_v1(text,text,text,text) from public,anon,authenticated;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
begin
 if p_intent::jsonb->>'kind' in('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') then return public.native_repairs_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
 elsif p_intent::jsonb->>'kind'='SALE_RETURN' then return public.native_returns_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
 elsif p_intent::jsonb->>'kind' in('PRODUCT_CREATE','PRODUCT_PATCH','PRODUCT_DELETE','INVENTORY_DELTA','INVENTORY_COUNT') then return public.native_inventory_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
 else return public.native_management_submit_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end if;
end $f$;
revoke all on function public.native_sales_submit_v1(text,text,text,text) from public,anon;
grant execute on function public.native_sales_submit_v1(text,text,text,text) to authenticated;

-- Current service documents join the same verified paginated snapshot.
create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare m public.native_sales_mode_v1%rowtype;old public.native_sales_snapshots_v1%rowtype;rows jsonb;batch jsonb;pages jsonb:='[]';header jsonb;payload text;idx integer:=0;cnt integer;at_ms bigint;watermark bigint;last_ticket bigint;turn_event jsonb;
begin
 perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if p_snapshot_id is null then raise exception 'NATIVE_SNAPSHOT_ID_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||p_negocio_id::text,0));
 select * into old from public.native_sales_snapshots_v1 x where x.negocio_id=p_negocio_id and x.snapshot_id=p_snapshot_id;
 if found then
  if old.actor_id is distinct from auth.uid() or old.installation_id is distinct from p_installation_id or old.device_id is distinct from p_device_id or old.writer_epoch is distinct from p_writer_epoch or old.scope_kind is distinct from p_scope_kind or old.sucursal_id is distinct from p_sucursal_id then raise exception using errcode='42501',message='NATIVE_SNAPSHOT_CONTEXT_DENIED';end if;
  return old.manifest;
 end if;
 select * into m from public.native_sales_mode_v1 x where x.negocio_id=p_negocio_id and x.scope_kind=p_scope_kind and x.sucursal_id is not distinct from p_sucursal_id;
 if not found then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 -- Legacy direct changes are fenced, and native writers share the tenant lock.
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_venta is null or p.precio_venta<0 or p.precio_venta*100<>pg_catalog.trunc(p.precio_venta*100) or p.precio_venta*100>9007199254740991 or p.costo<0 or p.costo*100<>pg_catalog.trunc(p.costo*100) or p.tasa_itbis is null or p.tasa_itbis not between 0 and 1 or p.tasa_itbis*100<>pg_catalog.trunc(p.tasa_itbis*100))) then raise exception 'NATIVE_PRODUCT_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.composiciones c where c.negocio_id=p_negocio_id and (c.cantidad_necesaria is null or c.cantidad_necesaria<=0 or c.cantidad_necesaria*10000<>pg_catalog.trunc(c.cantidad_necesaria*10000))) then raise exception 'NATIVE_RECIPE_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_2<0 or p.precio_3<0 or p.precio_2*100<>pg_catalog.trunc(p.precio_2*100) or p.precio_3*100<>pg_catalog.trunc(p.precio_3*100) or p.precio_2*100>9007199254740991 or p.precio_3*100>9007199254740991)) then raise exception 'NATIVE_PRICE_TIER_UNVERIFIABLE';end if;
 if exists(select 1 from public.seriales s where s.negocio_id=p_negocio_id and (s.estado is null or s.estado not in('disponible','vendido','reservado'))) then raise exception 'NATIVE_SERIAL_SOURCE_UNVERIFIABLE';end if;
 select x.last_sequence into watermark from public.native_sales_counter_v1 x where x.negocio_id=p_negocio_id;
 select coalesce(max(pg_catalog.split_part(x.ticket,'-',2)::bigint),0) into last_ticket from public.native_sales_ledger_v1 x where x.negocio_id=p_negocio_id and x.installation_id=p_installation_id and x.writer_epoch=p_writer_epoch and x.ticket is not null;
 select pg_catalog.jsonb_build_object('receipt',l.receipt,'intent',l.intent_text,'snapshot',l.snapshot_text) into turn_event from public.native_sales_turns_v1 t join public.native_sales_ledger_v1 l on l.negocio_id=t.negocio_id and l.operation_id=t.turn_id where t.negocio_id=p_negocio_id and t.scope_kind=p_scope_kind and t.sucursal_id is not distinct from p_sucursal_id and t.status='OPEN';
 select coalesce(pg_catalog.jsonb_agg(v order by kind,id),'[]'::jsonb) into rows from (
  select 'PRODUCT' kind,p.id::text id,pg_catalog.jsonb_build_object('kind','PRODUCT','id',p.id,'name',p.nombre,'code',p.codigo_barras,'revision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),'1'),'deleted',coalesce(p.eliminado,false),'priceTiers',pg_catalog.jsonb_build_object('retailCents',(p.precio_venta*100)::bigint::text,'tier2Cents',(p.precio_2*100)::bigint::text,'tier3Cents',(p.precio_3*100)::bigint::text),'metadata',pg_catalog.jsonb_build_object('costCents',public.native_product_cost_v1(p_negocio_id,p.id)::bigint::text,'taxRate',pg_catalog.jsonb_build_object('numerator',(p.tasa_itbis*100)::bigint::text,'denominator','100'),'productType',p.tipo,'recipeCostPolicy',case when p.tipo='combo' and exists(select 1 from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id) then 'NATIVE_EXACT' else 'DECLARED' end,'location',coalesce((select pm.location from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),pg_catalog.to_jsonb(p)->>'ubicacion',''),'minimum',coalesce((select pm.minimum::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),pg_catalog.to_jsonb(p)->>'stock_minimo'),'serialRequired',coalesce(p.serializable,false),'recipe',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productId',c.insumo_id,'perUnit',pg_catalog.jsonb_build_object('numerator',(c.cantidad_necesaria*10000)::bigint::text,'denominator','10000'),'revision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=c.insumo_id),'1')) order by c.insumo_id) from public.composiciones c where c.negocio_id=p_negocio_id and c.producto_padre_id=p.id),'[]'::jsonb)),'stock',pg_catalog.jsonb_build_object('quantity',case when p_scope_kind='GLOBAL' then p.stock_actual::text else inv.stock_actual::text end,'version',st.revision::text,'authority',case when st.revision is null or (p_scope_kind='BRANCH' and inv.stock_actual is null) then 'UNKNOWN' when p_scope_kind='BRANCH' and p.stock_actual is distinct from (select sum(z.stock_actual) from public.inventario_sucursales z where z.producto_id=p.id) then 'DIVERGED' else 'VERIFIED' end)) v from public.productos p left join public.inventario_sucursales inv on inv.producto_id=p.id and inv.sucursal_id=p_sucursal_id left join public.native_sales_stock_v1 st on st.negocio_id=p_negocio_id and st.producto_id=p.id and st.scope_kind=p_scope_kind and st.sucursal_id is not distinct from p_sucursal_id where p.negocio_id=p_negocio_id
  union all select 'CUSTOMER',c.id::text,pg_catalog.jsonb_build_object('kind','CUSTOMER','id',c.id,'name',c.nombre,'balanceCents',x.balance_cents::text,'limitCents',(c.limite_credito*100)::bigint::text,'active',not coalesce(c.eliminado,false),'revision',x.revision::text,'priceTier',coalesce(c.tipo_precio,1)::text,'metadataRevision',coalesce((select cm.revision::text from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id),'1'),'phone',case when exists(select 1 from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id) then (select cm.phone from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id) else pg_catalog.to_jsonb(c)->>'telefono' end,'wholesale',coalesce((select cm.wholesale from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id),(pg_catalog.to_jsonb(c)->>'al_por_mayor')::boolean,false)) from public.clientes c join public.native_sales_credit_v1 x on x.negocio_id=c.negocio_id and x.cliente_id=c.id where c.negocio_id=p_negocio_id
  union all select 'REPAIR',mr.document->'repair'->>'id',pg_catalog.jsonb_build_object('kind','REPAIR','id',mr.document->'repair'->>'id','event',pg_catalog.jsonb_build_object('intent',l.intent_text,'snapshot',null,'receipt',l.receipt)) from
  (select distinct on (source_repair.document->'repair'->>'id') source_repair.* from public.native_management_records_v1 source_repair where source_repair.negocio_id=p_negocio_id and source_repair.scope_kind=p_scope_kind and source_repair.sucursal_id is not distinct from p_sucursal_id and source_repair.kind in('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') order by source_repair.document->'repair'->>'id',(source_repair.document->'repair'->>'revision')::bigint desc) mr join public.native_sales_ledger_v1 l on l.negocio_id=mr.negocio_id and l.operation_id=mr.operation_id where public.native_member_role_v1(p_negocio_id) in('owner','admin')
  union all select 'SERIAL',s.id::text,pg_catalog.jsonb_build_object('kind','SERIAL','productId',s.producto_id,'text',s.numero_serial,'revision','1','state',case s.estado when 'disponible' then 'AVAILABLE' when 'reservado' then 'RESERVED' else 'SOLD' end) from public.seriales s where s.negocio_id=p_negocio_id
 ) q;
 cnt:=pg_catalog.jsonb_array_length(rows);if cnt>60000 then raise exception 'NATIVE_BOOTSTRAP_SIZE';end if;
 at_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint;
 header:=pg_catalog.jsonb_build_object('version','ventard.native.operational.1','namespace','NATIVE1','snapshotId',p_snapshot_id,'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'deviceId',p_device_id,'installationId',p_installation_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),'capturedAtMs',at_ms::text,'expiresAtMs',(at_ms+86400000)::text,'coverage','CLOUD_ADOPTED_V1','watermark',watermark::text,'totalCount',cnt,'ticketPrefix','N'||pg_catalog.replace(p_installation_id::text,'-',''),'lastTicket',last_ticket::text,'freeTax',pg_catalog.jsonb_build_object('numerator',(m.free_tax*100)::bigint::text,'denominator','100'),'turn',turn_event,'business',(select pg_catalog.jsonb_build_object('name',g.nombre,'rnc',pg_catalog.to_jsonb(g)->>'rnc','address',pg_catalog.to_jsonb(g)->>'direccion','phone',pg_catalog.to_jsonb(g)->>'telefono','footer',pg_catalog.to_jsonb(g)->>'mensaje_ticket') from public.negocios g where g.id=p_negocio_id),'cashBase',public.native_cash_base_v1(p_negocio_id,p_scope_kind,p_sucursal_id,watermark),'pages','[]'::jsonb);
 insert into public.native_sales_snapshots_v1 values(p_negocio_id,p_snapshot_id,auth.uid(),p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,header,at_ms+86400000);
 for batch in select pg_catalog.jsonb_agg(value order by ordinality) from pg_catalog.jsonb_array_elements(rows) with ordinality group by ((ordinality-1)/200) order by ((ordinality-1)/200) loop
  payload:=public.native_sales_canonical_v1(batch);if pg_catalog.octet_length(payload)>1048576 then raise exception 'NATIVE_BOOTSTRAP_PAGE_SIZE';end if;
  pages:=pages||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',idx,'count',pg_catalog.jsonb_array_length(batch),'byteLength',pg_catalog.octet_length(payload),'sha256',public.native_sales_hash_v1(payload)));
  insert into public.native_sales_pages_v1 values(p_negocio_id,p_snapshot_id,idx,payload);idx:=idx+1;
 end loop;
 header:=pg_catalog.jsonb_set(header,'{pages}',pages);update public.native_sales_snapshots_v1 set manifest=header where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;return header;
end $f$;
-- Private equipment credentials never enter native_sales_ledger_v1 or its feed.
create table if not exists public.native_repair_private_operations_v1(negocio_id uuid not null,operation_id uuid not null,intent text not null,hash text not null,receipt jsonb not null,primary key(negocio_id,operation_id));
create table if not exists public.native_repair_private_values_v1(negocio_id uuid not null,repair_id uuid not null,scope_kind text not null,sucursal_id uuid,operation_id uuid not null,repair_revision bigint not null check(repair_revision>0),credential text not null check(pg_catalog.length(credential)<=256),primary key(negocio_id,repair_id));
alter table public.native_repair_private_operations_v1 enable row level security;
alter table public.native_repair_private_values_v1 enable row level security;
revoke all on public.native_repair_private_operations_v1,public.native_repair_private_values_v1 from public,anon,authenticated;
create or replace function public.native_repairs_private_submit_v1(p_intent text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
#variable_conflict use_variable
declare v jsonb;n uuid;op uuid;i uuid;d uuid;b uuid;k text;epoch bigint;role text;rid uuid;revision bigint;value_text text;old public.native_repair_private_operations_v1%rowtype;financial public.native_sales_ledger_v1%rowtype;previous public.native_repair_private_values_v1%rowtype;receipt jsonb;status text:='APPLIED';
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>8192 then raise exception 'NATIVE_PRIVATE_SIZE';end if;v:=p_intent::jsonb;
 if v->>'protocol' is distinct from 'ventard.repair.private.1' or public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent) is distinct from p_hash then raise exception 'NATIVE_PRIVATE_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','operationId','tenantId','scope','actorId','installationId','deviceId','writerEpoch','repairId','repairRevision','baseOperationId','value']);
 n:=(v->>'tenantId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'deviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'branchId')::uuid;role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if role not in('owner','admin') or (v->>'actorId')::uuid is distinct from auth.uid() or not exists(select 1 from public.native_entitlements_v1 where negocio_id=n and plan_tier='pro') then raise exception using errcode='42501',message='NATIVE_PRIVATE_DENIED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));select * into old from public.native_repair_private_operations_v1 p where p.negocio_id=n and p.operation_id=op;
 if found then if old.intent<>p_intent or old.hash<>p_hash then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 select * into financial from public.native_sales_ledger_v1 l where l.negocio_id=n and l.operation_id=op and l.actor_id=auth.uid() and l.installation_id=i and l.device_id=d and l.writer_epoch=epoch and l.scope_kind=k and l.sucursal_id is not distinct from b and l.kind in('REPAIR_CREATE','REPAIR_EDIT');
 if not found or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(financial.intent_text::jsonb->>'permissionGrantId')::uuid and rr.receipt->'license'->>'planTier'='pro') then raise exception 'NATIVE_PRIVATE_PUBLIC_OPERATION_REQUIRED';end if;
 rid:=(v->>'repairId')::uuid;revision:=public.native_sales_int_v1(v->'repairRevision',2147483647)::bigint;value_text:=v->>'value';
 if revision<=0 or rid is null or pg_catalog.jsonb_typeof(v->'value') is distinct from 'string' or pg_catalog.length(value_text)>256 or value_text ~ '[[:cntrl:]]' or financial.intent_text::jsonb->'payload'->'document'->'repair'->>'id' is distinct from rid::text or financial.intent_text::jsonb->'payload'->'document'->'repair'->>'revision' is distinct from revision::text or pg_catalog.jsonb_typeof(v->'baseOperationId') not in('string','null') then raise exception 'NATIVE_PRIVATE_INVALID';end if;
 if v->>'baseOperationId' is not null then perform (v->>'baseOperationId')::uuid;end if;
 select * into previous from public.native_repair_private_values_v1 p where p.negocio_id=n and p.repair_id=rid;
 if found and previous.repair_revision>=revision then status:='SUPERSEDED';
 else insert into public.native_repair_private_values_v1 values(n,rid,k,b,op,revision,value_text) on conflict(negocio_id,repair_id) do update set operation_id=excluded.operation_id,repair_revision=excluded.repair_revision,credential=excluded.credential;end if;
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.repair.private.receipt.1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'repairId',rid,'intentHash',p_hash,'status',status);
 insert into public.native_repair_private_operations_v1 values(n,op,p_intent,p_hash,receipt);return receipt;
end $f$;
revoke all on function public.native_repairs_private_submit_v1(text,text) from public,anon;
grant execute on function public.native_repairs_private_submit_v1(text,text) to authenticated;
create or replace function public.native_repairs_private_read_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare role text;rows jsonb;begin
 role:=public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);if role not in('owner','admin') then raise exception using errcode='42501',message='NATIVE_PRIVATE_DENIED';end if;
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('repairId',p.repair_id,'operationId',p.operation_id,'repairRevision',p.repair_revision::text,'value',p.credential) order by p.repair_id),'[]') into rows from public.native_repair_private_values_v1 p where p.negocio_id=p_negocio_id and p.scope_kind=p_scope_kind and p.sucursal_id is not distinct from p_sucursal_id;
 if pg_catalog.jsonb_array_length(rows)>10000 or pg_catalog.octet_length(rows::text)>1048576 then raise exception 'NATIVE_PRIVATE_SIZE';end if;
 return pg_catalog.jsonb_build_object('protocol','ventard.repair.private.view.1','tenantId',p_negocio_id,'scope',pg_catalog.jsonb_build_object('type',p_scope_kind,'branchId',p_sucursal_id),'rows',rows);
end $f$;
revoke all on function public.native_repairs_private_read_v1(uuid,uuid,uuid,bigint,text,uuid) from public,anon;
grant execute on function public.native_repairs_private_read_v1(uuid,uuid,uuid,bigint,text,uuid) to authenticated;

-- Source: 20261012201138_native_layaways_staging_v1.sql SHA256 f959000b2ec811d67735d42593e2df4bb97eb1dd243068cdeb3b015153b4b267
do $guard$ begin end $guard$;
alter table public.seriales add column if not exists garantia_dias integer;
alter table public.seriales add column if not exists garantia_hasta bigint;
alter table public.seriales add column if not exists precio_venta numeric;
alter table public.seriales add column if not exists cliente_nombre text;
create or replace function public.native_layaway_plan_v1(req jsonb,previous jsonb,at_ms text,actor uuid,folio text,folio_number text) returns jsonb language plpgsql immutable set search_path='' as $f$
#variable_conflict use_variable
declare a jsonb;def jsonb;item jsonb;field text;value_text text;qty bigint;total numeric:=0;amount bigint;paid bigint;revision bigint;days bigint;action text;method text;payment jsonb:='null';keys text[]:='{}';key text;
begin
 if req->>'kind'='LAYAWAY_CREATE' then
  if previous is not null then raise exception 'NATIVE_SERVICE_VERSION';end if;revision:=0;
  perform public.native_sales_object_v1(req,array['kind','operationId','layawayId','definition','initialPaymentCents','method','turnId']);def:=req->'definition';perform public.native_sales_object_v1(def,array['customerId','customerName','phone','notes','items']);
  if pg_catalog.jsonb_typeof(def->'customerId') not in('string','null') or (def->>'customerId' is not null and (def->>'customerId')::uuid is null) then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  foreach field in array array['customerName','phone','notes'] loop value_text:=def->>field;if pg_catalog.jsonb_typeof(def->field) is distinct from 'string' or pg_catalog.btrim(value_text)<>value_text or pg_catalog.regexp_replace(value_text,E'\n','','g') ~ '[[:cntrl:]]' or pg_catalog.length(value_text)>(case field when 'customerName' then 256 when 'phone' then 64 else 4000 end) or (field='customerName' and value_text='') then raise exception 'NATIVE_SERVICE_DEFINITION_INVALID';end if;end loop;
  if pg_catalog.jsonb_typeof(def->'items') is distinct from 'array' or pg_catalog.jsonb_array_length(def->'items') not between 1 and 100 then raise exception 'NATIVE_SERVICE_PART_INVALID';end if;
  for item in select value from pg_catalog.jsonb_array_elements(def->'items') loop
   perform public.native_sales_object_v1(item,array['productId','name','quantity','priceCents','serial']);qty:=public.native_sales_int_v1(item->'quantity',2147483647)::bigint;key:=(item->>'productId')||'/'||coalesce(item->>'serial','');
   if (item->>'productId')::uuid is null or qty<=0 or key=any(keys) or pg_catalog.jsonb_typeof(item->'name') is distinct from 'string' or pg_catalog.btrim(item->>'name')<>item->>'name' or pg_catalog.length(item->>'name') not between 1 and 256 or pg_catalog.regexp_replace(item->>'name',E'\n','','g') ~ '[[:cntrl:]]' or pg_catalog.jsonb_typeof(item->'serial') not in('string','null') or (item->>'serial' is not null and (qty<>1 or pg_catalog.length(item->>'serial') not between 1 and 256 or pg_catalog.btrim(item->>'serial')<>item->>'serial' or item->>'serial' ~ '[[:cntrl:]]')) then raise exception 'NATIVE_SERVICE_PART_INVALID';end if;keys:=pg_catalog.array_append(keys,key);total:=total+qty::numeric*public.native_sales_int_v1(item->'priceCents');
  end loop;if total>9007199254740991 then raise exception 'NATIVE_SERVICE_AMOUNT_INVALID';end if;
  a:=pg_catalog.jsonb_build_object('id',req->>'layawayId','revision','0','state','activo','definition',def,'totalCents',total::bigint::text,'paidCents','0','payments','[]'::jsonb,'createdAtMs',at_ms,'updatedAtMs',at_ms,'completedAtMs',null,'cancelledAtMs',null,'warrantyDays','0','warrantyUntilMs',null,'folio',folio,'folioNumber',folio_number);amount:=public.native_sales_int_v1(req->'initialPaymentCents')::bigint;
 else
  perform public.native_sales_object_v1(req,array['kind','operationId','layawayId','expectedRevision','action','amountCents','method','turnId','warrantyDays']);revision:=public.native_sales_int_v1(req->'expectedRevision',2147483646)::bigint;
  if req->>'kind' is distinct from 'LAYAWAY_ACTION' or previous is null or previous->>'revision' is distinct from revision::text or previous->>'state' is distinct from 'activo' or (previous->>'updatedAtMs')::bigint>at_ms::bigint then raise exception 'NATIVE_SERVICE_VERSION';end if;
  a:=previous;total:=public.native_sales_int_v1(a->'totalCents');amount:=public.native_sales_int_v1(req->'amountCents')::bigint;days:=public.native_sales_int_v1(req->'warrantyDays',3650)::bigint;action:=req->>'action';
  if action='PAYMENT' then if amount<=0 or days<>0 then raise exception 'NATIVE_SERVICE_AMOUNT_INVALID';end if;
  elsif action='COMPLETE' then if amount<>0 then raise exception 'NATIVE_SERVICE_AMOUNT_INVALID';end if;amount:=total::bigint-(a->>'paidCents')::bigint;a:=a||pg_catalog.jsonb_build_object('state','completado','completedAtMs',at_ms,'warrantyDays',days::text,'warrantyUntilMs',case when days=0 then null else (at_ms::bigint+days*86400000)::text end);
  elsif action='CANCEL' then if amount<>0 or days<>0 then raise exception 'NATIVE_SERVICE_AMOUNT_INVALID';end if;a:=a||pg_catalog.jsonb_build_object('state','cancelado','cancelledAtMs',at_ms,'settlementPendingCents',a->>'paidCents');else raise exception 'NATIVE_SERVICE_STATE_INVALID';end if;
 end if;
 method:=req->>'method';if method not in('EFECTIVO','TARJETA','TRANSFERENCIA') or method is null then raise exception 'NATIVE_SERVICE_METHOD_INVALID';end if;paid:=public.native_sales_int_v1(a->'paidCents')::bigint;if paid::numeric+amount>total or amount<0 then raise exception 'NATIVE_SERVICE_OVERPAY';end if;
 if amount>0 then if req->>'turnId' is null and method='EFECTIVO' then raise exception 'NATIVE_TURN_REQUIRED';end if;payment:=pg_catalog.jsonb_build_object('operationId',req->>'operationId','amountCents',amount::text,'method',method,'turnId',req->>'turnId','dateMs',at_ms);a:=a||pg_catalog.jsonb_build_object('paidCents',(paid+amount)::text,'payments',(a->'payments')||pg_catalog.jsonb_build_array(payment));end if;
 a:=a||pg_catalog.jsonb_build_object('revision',(revision+1)::text,'updatedAtMs',at_ms);
 return pg_catalog.jsonb_build_object('operationId',req->>'operationId','layaway',a,'payment',payment,'amountCents',amount::text,'method',case when amount=0 then null else method end,'concept','Apartado '||(a->>'folio'))||case when amount>0 and req->>'turnId' is not null then pg_catalog.jsonb_build_object('cashDeltaCents',case when method='EFECTIVO' then amount::text else '0' end) else '{}'::jsonb end;
end $f$;
revoke all on function public.native_layaway_plan_v1(jsonb,jsonb,text,uuid,text,text) from public,anon,authenticated;
create or replace function public.native_layaway_reserved_v1(a jsonb) returns jsonb language sql immutable set search_path='' as $$select coalesce(pg_catalog.jsonb_object_agg(pid,qty::text),'{}'::jsonb) from (select x->>'productId' pid,sum((x->>'quantity')::bigint) qty from pg_catalog.jsonb_array_elements(coalesce(a->'definition'->'items','[]'::jsonb)) x where a->>'state' in('activo','completado') group by x->>'productId') r$$;
revoke all on function public.native_layaway_reserved_v1(jsonb) from public,anon,authenticated;
create or replace function public.native_layaways_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
#variable_conflict use_variable
declare v jsonb;req jsonb;doc jsonb;previous jsonb;repair jsonb;expected jsonb;business jsonb;old public.native_sales_ledger_v1%rowtype;
 n uuid;op uuid;i uuid;d uuid;b uuid;k text;kind text;epoch bigint;role text;rid uuid;turn uuid;revision bigint;amount bigint;folio text;folio_number bigint;stock_before jsonb;stock_after jsonb;stock_map jsonb:='{}';stock_expected jsonb:='[]';proof jsonb;part jsonb;pend jsonb;pid uuid;delta integer;cur integer;after integer;version bigint;expected_version bigint;effective numeric;projection numeric;seq bigint;receipt jsonb;effects jsonb;stock jsonb:='[]';clock_ms text;val bigint;customer uuid;original_warranty jsonb;field text;serial_expected jsonb;sn text;serial_state text;created_products jsonb:='[]';created_ids text[]:='{}';recover_ids text[]:='{}';definition jsonb;product_doc jsonb;product_request jsonb;cost bigint;name text;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 or p_snapshot is not null or p_snapshot_hash is not null then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;kind:=v->>'kind';if kind not in('LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL') or kind is null or public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent) is distinct from p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 if v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or v->'expectedVersions' is distinct from '{}'::jsonb or v->'dependencies' is distinct from '[]'::jsonb then raise exception 'NATIVE_INTENT_INVALID';end if;
 perform public.native_sales_int_v1(v->'originAtUtcMs');n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or (v->>'actorId')::uuid is distinct from auth.uid() or role not in('owner','admin') or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role and rr.receipt->'license'->>'planTier'='pro') then raise exception using errcode='42501',message='NATIVE_PRO_REQUIRED';end if;
 perform 1 from public.native_entitlements_v1 where negocio_id=n and plan_tier='pro' for share;if not found then raise exception using errcode='42501',message='NATIVE_PRO_REQUIRED';end if;
 if not exists(select 1 from public.native_sales_mode_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b) then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is not null or old.snapshot_text is not null then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 perform public.native_sales_object_v1(v->'payload',array['request','document']);req:=v->'payload'->'request';doc:=v->'payload'->'document';rid:=(req->>'layawayId')::uuid;revision:=case when kind='LAYAWAY_CREATE' then 0 else public.native_sales_int_v1(req->'expectedRevision',2147483646)::bigint end;
 if req->>'operationId' is distinct from op::text or rid is null or (kind='LAYAWAY_CREATE')<>(revision=0) then raise exception 'NATIVE_SERVICE_REQUEST_INVALID';end if;
 select m.document into previous from public.native_management_records_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b and m.kind in('LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL') and m.document->'layaway'->>'id'=rid::text order by (m.document->'layaway'->>'revision')::bigint desc limit 1;
 if revision=0 then
  if previous is not null or exists(select 1 from public.native_management_records_v1 where document->'layaway'->>'id'=rid::text) then raise exception 'NATIVE_SERVICE_VERSION';end if;
  folio_number:=public.native_sales_int_v1(doc->'layaway'->'folioNumber')::bigint;if folio_number<=0 then raise exception 'NATIVE_SERVICE_FOLIO_INVALID';end if;
  folio:='AP-N'||pg_catalog.replace(i::text,'-','')||'-'||case when folio_number<1000 then pg_catalog.lpad(folio_number::text,3,'0') else folio_number::text end;
  if exists(select 1 from public.native_management_records_v1 where negocio_id=n and kind='LAYAWAY_CREATE' and document->'layaway'->>'folio'=folio) then raise exception 'NATIVE_SERVICE_FOLIO_INVALID';end if;
  business:=doc->'business';if business is null or pg_catalog.jsonb_typeof(business) not in('object','null') then raise exception 'NATIVE_SERVICE_HEADER_INVALID';end if;
  if business<>'null'::jsonb and not exists(select 1 from public.native_sales_snapshots_v1 ss where ss.negocio_id=n and ss.installation_id=i and ss.scope_kind=k and ss.sucursal_id is not distinct from b and ss.manifest->'business'=business) then raise exception 'NATIVE_SERVICE_HEADER_INVALID';end if;
 else
  if previous is null then raise exception 'NATIVE_SERVICE_VERSION';end if;folio:=previous->'layaway'->>'folio';folio_number:=(previous->'layaway'->>'folioNumber')::bigint;business:=previous->'business';
 end if;
 if kind is distinct from (case when req->>'kind'='LAYAWAY_CREATE' then 'LAYAWAY_CREATE' when req->>'action'='PAYMENT' then 'LAYAWAY_PAYMENT' when req->>'action'='COMPLETE' then 'LAYAWAY_COMPLETE' when req->>'action'='CANCEL' then 'LAYAWAY_CANCEL' else null end) then raise exception 'NATIVE_SERVICE_REQUEST_INVALID';end if;
 expected:=public.native_layaway_plan_v1(req,previous->'layaway',v->>'originAtUtcMs',auth.uid(),folio,folio_number::text);repair:=expected->'layaway';amount:=(expected->>'amountCents')::bigint;turn:=(expected->'payment'->>'turnId')::uuid;
 if v->>'originalTurnId' is distinct from turn::text then raise exception 'NATIVE_SERVICE_TURN_INVALID';end if;
 if amount>0 and turn is not null and not exists(select 1 from public.native_sales_turns_v1 t where t.negocio_id=n and t.turn_id=turn and t.scope_kind=k and t.sucursal_id is not distinct from b and t.status='OPEN' and (v->>'originAtUtcMs')::bigint>=t.opened_at_ms::bigint) then raise exception 'NATIVE_TURN_REQUIRED';end if;
 if req->>'kind'='LAYAWAY_CREATE' then
  customer:=(repair->'definition'->>'customerId')::uuid;
  if req ? 'createCustomer' and pg_catalog.jsonb_typeof(req->'createCustomer') is distinct from 'boolean' then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  if req->'createCustomer'='true'::jsonb then
   if customer is null or exists(select 1 from public.clientes where id=customer) then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
   expected:=expected||pg_catalog.jsonb_build_object('customer',pg_catalog.jsonb_build_object('id',customer,'name',repair->'definition'->>'customerName','phone',nullif(repair->'definition'->>'phone',''),'limitCents','0','priceTier',1,'wholesale',false,'active',true,'revision','1','balanceCents','0','balanceRevision','1','authority','VERIFIED'));
  elsif customer is not null and not exists(select 1 from public.clientes c where c.id=customer and c.negocio_id=n and not coalesce(c.eliminado,false)) then raise exception 'NATIVE_CUSTOMER_INVALID';end if;
  for part in select value from pg_catalog.jsonb_array_elements(repair->'definition'->'items') loop
   if part->>'productId' is not null and not exists(select 1 from public.productos p where p.id=(part->>'productId')::uuid and p.negocio_id=n and not coalesce(p.eliminado,false) and coalesce(p.serializable,false)=(part->>'serial' is not null) and p.tipo is distinct from 'combo' and not exists(select 1 from public.composiciones c where c.producto_padre_id=p.id and c.negocio_id=n)) then raise exception 'NATIVE_SERVICE_PART_UNSUPPORTED';end if;
  end loop;
 end if;
 stock_before:=public.native_layaway_reserved_v1(previous->'layaway');stock_after:=public.native_layaway_reserved_v1(repair);
 for pid in select key::uuid from pg_catalog.jsonb_object_keys(stock_before||stock_after) key order by key loop val:=coalesce((stock_before->>pid::text)::bigint,0)-coalesce((stock_after->>pid::text)::bigint,0);if val<>0 then stock_map:=stock_map||pg_catalog.jsonb_build_object(pid::text,val::text);end if;end loop;
 if pg_catalog.jsonb_typeof(doc->'stock') is distinct from 'array' or pg_catalog.jsonb_array_length(doc->'stock')<>(select count(*) from pg_catalog.jsonb_object_keys(stock_map)) or (select count(distinct x->>'productId') from pg_catalog.jsonb_array_elements(doc->'stock') x)<>pg_catalog.jsonb_array_length(doc->'stock') then raise exception 'NATIVE_SERVICE_STOCK_INVALID';end if;
 for part in select value from pg_catalog.jsonb_array_elements(doc->'stock') loop
  pid:=(part->>'productId')::uuid;delta:=(part->>'delta')::integer;if part->>'delta' is distinct from stock_map->>pid::text then raise exception 'NATIVE_SERVICE_STOCK_INVALID';end if;
  proof:=part->'stockEvidence';perform public.native_sales_object_v1(proof,array['productId','remoteBaseQty','remoteSequence','pending','effectiveQty']);if proof->>'productId' is distinct from pid::text or pg_catalog.jsonb_typeof(proof->'pending') is distinct from 'array' or pg_catalog.jsonb_array_length(proof->'pending')>1000 or (select count(distinct x->>'effectId') from pg_catalog.jsonb_array_elements(proof->'pending') x)<>pg_catalog.jsonb_array_length(proof->'pending') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
  if pid::text=any(created_ids) then
   version:=0;cur:=0;
  else
  select stock_revision.revision into version from public.native_sales_stock_v1 stock_revision where stock_revision.negocio_id=n and stock_revision.scope_kind=k and stock_revision.sucursal_id is not distinct from b and stock_revision.producto_id=pid for update;if not found then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
  if k='BRANCH' then select stock_actual into cur from public.inventario_sucursales where sucursal_id=b and producto_id=pid for update;else select stock_actual into cur from public.productos where negocio_id=n and id=pid for update;end if;if cur is null then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
  end if;
  effective:=public.native_sales_int_v1(proof->'remoteBaseQty',2147483647);expected_version:=public.native_sales_int_v1(proof->'remoteSequence')::bigint;
  for pend in select value from pg_catalog.jsonb_array_elements(proof->'pending') loop select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=(pend->>'operationId')::uuid and installation_id=i and scope_kind=k and sucursal_id is not distinct from b;if not found or not exists(select 1 from public.native_sales_effects_v1 x where x.negocio_id=n and x.operation_id=old.operation_id and x.effect_id=(pend->>'effectId')::uuid and x.kind='STOCK' and x.payload->>'productId'=pid::text and x.payload->>'delta'=pend->>'delta') then raise exception 'NATIVE_PENDING_COVERAGE_INVALID';end if;effective:=effective+(pend->>'delta')::integer;expected_version:=greatest(expected_version,old.remote_sequence);end loop;
  if version<>expected_version or effective<>cur or public.native_sales_int_v1(proof->'effectiveQty',2147483647)<>cur or part->>'expectedRevision' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object('quantity',proof->>'effectiveQty','remoteSequence',proof->>'remoteSequence','pending',proof->'pending'))) then raise exception 'NATIVE_STOCK_VERSION_CONFLICT';end if;
  after:=cur+delta;if after<0 then raise exception 'NATIVE_STOCK_INSUFFICIENT';end if;
  stock_expected:=stock_expected||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text,'before',cur::text,'after',after::text,'expectedRevision',part->>'expectedRevision','stockEvidence',proof));
 end loop;
 serial_expected:='[]';
 for part in select value from pg_catalog.jsonb_array_elements(repair->'definition'->'items') loop
  if part->>'serial' is null then continue;end if;pid:=(part->>'productId')::uuid;sn:=part->>'serial';select se.estado into serial_state from public.seriales se where se.negocio_id=n and se.producto_id=pid and se.numero_serial=sn for update;
  if serial_state is distinct from (case when revision=0 then 'disponible' else 'apartado' end) then raise exception 'NATIVE_SERIAL_CONFLICT';end if;
  if revision>0 and not exists(select 1 from pg_catalog.jsonb_array_elements(previous->'layaway'->'definition'->'items') x where x->>'productId'=pid::text and x->>'serial'=sn) then raise exception 'NATIVE_SERIAL_CONFLICT';end if;
  serial_expected:=serial_expected||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'text',sn,'expectedRevision','1','before',case when revision=0 then 'AVAILABLE' else 'RESERVED' end,'after',case kind when 'LAYAWAY_COMPLETE' then 'SOLD' when 'LAYAWAY_CANCEL' then 'AVAILABLE' else 'RESERVED' end));
 end loop;
 expected:=expected||pg_catalog.jsonb_build_object('serials',serial_expected);
 expected:=expected||pg_catalog.jsonb_build_object('stock',stock_expected,'business',business);if expected is distinct from doc then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'management'),'kind',kind,'payload',doc));
 if doc ? 'customer' then
  insert into public.clientes(id,negocio_id,nombre,limite_credito,eliminado,tipo_precio,fecha_actualizacion) values(customer,n,doc->'customer'->>'name',0,false,1,(v->>'originAtUtcMs')::bigint);
  insert into public.native_customer_metadata_v1 values(n,customer,doc->'customer'->>'phone',false,1);
  insert into public.native_sales_credit_v1 values(n,customer,0,1);
 end if;
 for part in select value from pg_catalog.jsonb_array_elements(stock_expected) loop
  pid:=(part->>'productId')::uuid;delta:=(part->>'delta')::integer;after:=(part->>'after')::integer;
  if k='BRANCH' then select sum(z.stock_actual) into projection from public.inventario_sucursales z where z.producto_id=pid;if projection is distinct from (select p.stock_actual::numeric from public.productos p where p.id=pid and p.negocio_id=n) then raise exception 'NATIVE_STOCK_DIVERGENCE';end if;update public.inventario_sucursales set stock_actual=after,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where sucursal_id=b and producto_id=pid;update public.productos set stock_actual=(projection+delta)::integer,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;else update public.productos set stock_actual=after,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;end if;
  update public.native_sales_stock_v1 set revision=seq where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid;effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'stock/'||pid::text),'kind','STOCK','payload',pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text)));stock:=stock||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'after',after::text,'version',seq::text));
 end loop;
 for part in select value from pg_catalog.jsonb_array_elements(serial_expected) loop
  update public.seriales set estado=case part->>'after' when 'SOLD' then 'vendido' when 'AVAILABLE' then 'disponible' else 'apartado' end,venta_id=case when part->>'after'='SOLD' then op else null end,fecha_actualizacion=(v->>'originAtUtcMs')::bigint,fecha_venta=case when part->>'after'='SOLD' then (v->>'originAtUtcMs')::bigint else fecha_venta end,garantia_dias=case when part->>'after'='SOLD' then (repair->>'warrantyDays')::integer else garantia_dias end,garantia_hasta=case when part->>'after'='SOLD' then (repair->>'warrantyUntilMs')::bigint else garantia_hasta end,cliente_nombre=case when part->>'after'='SOLD' then repair->'definition'->>'customerName' else cliente_nombre end,precio_venta=case when part->>'after'='SOLD' then (select (x->>'priceCents')::numeric/100 from pg_catalog.jsonb_array_elements(repair->'definition'->'items') x where x->>'serial'=part->>'text') else precio_venta end where negocio_id=n and producto_id=(part->>'productId')::uuid and numero_serial=part->>'text';
  effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'serial/'||(part->>'text')),'kind','SERIAL','payload',part));
 end loop;
 clock_ms:=(pg_catalog.trunc(extract(epoch from pg_catalog.clock_timestamp())*1000))::bigint::text;receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',null,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',null,'ncf',null,'totalCents',null,'effects',effects,'stock',stock);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,kind,p_intent,p_hash,null,null,null,null,seq,receipt);for part in select value from pg_catalog.jsonb_array_elements(effects) loop insert into public.native_sales_effects_v1 values(n,op,(part->>'id')::uuid,part->>'kind',part->'payload');end loop;
 insert into public.native_management_records_v1 values(n,op,k,b,kind,turn,null,expected->>'method',amount,expected->>'concept',v->>'originAtUtcMs',doc);delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;return receipt;
end $f$;
revoke all on function public.native_layaways_submit_v1(text,text,text,text) from public,anon,authenticated;

create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
begin if p_intent::jsonb->>'kind' in('LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL') then return public.native_layaways_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
elsif p_intent::jsonb->>'kind' in('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') then return public.native_repairs_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
elsif p_intent::jsonb->>'kind'='SALE_RETURN' then return public.native_returns_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
elsif p_intent::jsonb->>'kind' in('PRODUCT_CREATE','PRODUCT_PATCH','PRODUCT_DELETE','INVENTORY_DELTA','INVENTORY_COUNT') then return public.native_inventory_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);else return public.native_management_submit_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end if;end $f$;
revoke all on function public.native_sales_submit_v1(text,text,text,text) from public,anon;grant execute on function public.native_sales_submit_v1(text,text,text,text) to authenticated;
create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare m public.native_sales_mode_v1%rowtype;old public.native_sales_snapshots_v1%rowtype;rows jsonb;batch jsonb;pages jsonb:='[]';header jsonb;payload text;idx integer:=0;cnt integer;at_ms bigint;watermark bigint;last_ticket bigint;turn_event jsonb;
begin
 perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if p_snapshot_id is null then raise exception 'NATIVE_SNAPSHOT_ID_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||p_negocio_id::text,0));
 select * into old from public.native_sales_snapshots_v1 x where x.negocio_id=p_negocio_id and x.snapshot_id=p_snapshot_id;
 if found then
  if old.actor_id is distinct from auth.uid() or old.installation_id is distinct from p_installation_id or old.device_id is distinct from p_device_id or old.writer_epoch is distinct from p_writer_epoch or old.scope_kind is distinct from p_scope_kind or old.sucursal_id is distinct from p_sucursal_id then raise exception using errcode='42501',message='NATIVE_SNAPSHOT_CONTEXT_DENIED';end if;
  return old.manifest;
 end if;
 select * into m from public.native_sales_mode_v1 x where x.negocio_id=p_negocio_id and x.scope_kind=p_scope_kind and x.sucursal_id is not distinct from p_sucursal_id;
 if not found then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 -- Legacy direct changes are fenced, and native writers share the tenant lock.
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_venta is null or p.precio_venta<0 or p.precio_venta*100<>pg_catalog.trunc(p.precio_venta*100) or p.precio_venta*100>9007199254740991 or p.costo<0 or p.costo*100<>pg_catalog.trunc(p.costo*100) or p.tasa_itbis is null or p.tasa_itbis not between 0 and 1 or p.tasa_itbis*100<>pg_catalog.trunc(p.tasa_itbis*100))) then raise exception 'NATIVE_PRODUCT_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.composiciones c where c.negocio_id=p_negocio_id and (c.cantidad_necesaria is null or c.cantidad_necesaria<=0 or c.cantidad_necesaria*10000<>pg_catalog.trunc(c.cantidad_necesaria*10000))) then raise exception 'NATIVE_RECIPE_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_2<0 or p.precio_3<0 or p.precio_2*100<>pg_catalog.trunc(p.precio_2*100) or p.precio_3*100<>pg_catalog.trunc(p.precio_3*100) or p.precio_2*100>9007199254740991 or p.precio_3*100>9007199254740991)) then raise exception 'NATIVE_PRICE_TIER_UNVERIFIABLE';end if;
 if exists(select 1 from public.seriales s where s.negocio_id=p_negocio_id and (s.estado is null or s.estado not in('disponible','vendido','reservado','apartado') or (s.estado='apartado' and not exists(select 1 from (select distinct on (mr.document->'layaway'->>'id') mr.* from public.native_management_records_v1 mr where mr.negocio_id=p_negocio_id and mr.kind in('LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL') order by mr.document->'layaway'->>'id',(mr.document->'layaway'->>'revision')::bigint desc) a,pg_catalog.jsonb_array_elements(a.document->'layaway'->'definition'->'items') item where a.document->'layaway'->>'state'='activo' and item->>'productId'=s.producto_id::text and item->>'serial'=s.numero_serial)))) then raise exception 'NATIVE_SERIAL_SOURCE_UNVERIFIABLE';end if;
 select x.last_sequence into watermark from public.native_sales_counter_v1 x where x.negocio_id=p_negocio_id;
 select coalesce(max(pg_catalog.split_part(x.ticket,'-',2)::bigint),0) into last_ticket from public.native_sales_ledger_v1 x where x.negocio_id=p_negocio_id and x.installation_id=p_installation_id and x.writer_epoch=p_writer_epoch and x.ticket is not null;
 select pg_catalog.jsonb_build_object('receipt',l.receipt,'intent',l.intent_text,'snapshot',l.snapshot_text) into turn_event from public.native_sales_turns_v1 t join public.native_sales_ledger_v1 l on l.negocio_id=t.negocio_id and l.operation_id=t.turn_id where t.negocio_id=p_negocio_id and t.scope_kind=p_scope_kind and t.sucursal_id is not distinct from p_sucursal_id and t.status='OPEN';
 select coalesce(pg_catalog.jsonb_agg(v order by kind,id),'[]'::jsonb) into rows from (
  select 'PRODUCT' kind,p.id::text id,pg_catalog.jsonb_build_object('kind','PRODUCT','id',p.id,'name',p.nombre,'code',p.codigo_barras,'revision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),'1'),'deleted',coalesce(p.eliminado,false),'priceTiers',pg_catalog.jsonb_build_object('retailCents',(p.precio_venta*100)::bigint::text,'tier2Cents',(p.precio_2*100)::bigint::text,'tier3Cents',(p.precio_3*100)::bigint::text),'metadata',pg_catalog.jsonb_build_object('costCents',public.native_product_cost_v1(p_negocio_id,p.id)::bigint::text,'taxRate',pg_catalog.jsonb_build_object('numerator',(p.tasa_itbis*100)::bigint::text,'denominator','100'),'productType',p.tipo,'recipeCostPolicy',case when p.tipo='combo' and exists(select 1 from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id) then 'NATIVE_EXACT' else 'DECLARED' end,'location',coalesce((select pm.location from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),pg_catalog.to_jsonb(p)->>'ubicacion',''),'minimum',coalesce((select pm.minimum::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),pg_catalog.to_jsonb(p)->>'stock_minimo'),'serialRequired',coalesce(p.serializable,false),'recipe',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productId',c.insumo_id,'perUnit',pg_catalog.jsonb_build_object('numerator',(c.cantidad_necesaria*10000)::bigint::text,'denominator','10000'),'revision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=c.insumo_id),'1')) order by c.insumo_id) from public.composiciones c where c.negocio_id=p_negocio_id and c.producto_padre_id=p.id),'[]'::jsonb)),'stock',pg_catalog.jsonb_build_object('quantity',case when p_scope_kind='GLOBAL' then p.stock_actual::text else inv.stock_actual::text end,'version',st.revision::text,'authority',case when st.revision is null or (p_scope_kind='BRANCH' and inv.stock_actual is null) then 'UNKNOWN' when p_scope_kind='BRANCH' and p.stock_actual is distinct from (select sum(z.stock_actual) from public.inventario_sucursales z where z.producto_id=p.id) then 'DIVERGED' else 'VERIFIED' end)) v from public.productos p left join public.inventario_sucursales inv on inv.producto_id=p.id and inv.sucursal_id=p_sucursal_id left join public.native_sales_stock_v1 st on st.negocio_id=p_negocio_id and st.producto_id=p.id and st.scope_kind=p_scope_kind and st.sucursal_id is not distinct from p_sucursal_id where p.negocio_id=p_negocio_id
  union all select 'CUSTOMER',c.id::text,pg_catalog.jsonb_build_object('kind','CUSTOMER','id',c.id,'name',c.nombre,'balanceCents',x.balance_cents::text,'limitCents',(c.limite_credito*100)::bigint::text,'active',not coalesce(c.eliminado,false),'revision',x.revision::text,'priceTier',coalesce(c.tipo_precio,1)::text,'metadataRevision',coalesce((select cm.revision::text from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id),'1'),'phone',case when exists(select 1 from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id) then (select cm.phone from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id) else pg_catalog.to_jsonb(c)->>'telefono' end,'wholesale',coalesce((select cm.wholesale from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id),(pg_catalog.to_jsonb(c)->>'al_por_mayor')::boolean,false)) from public.clientes c join public.native_sales_credit_v1 x on x.negocio_id=c.negocio_id and x.cliente_id=c.id where c.negocio_id=p_negocio_id
  union all select 'REPAIR',mr.document->'repair'->>'id',pg_catalog.jsonb_build_object('kind','REPAIR','id',mr.document->'repair'->>'id','event',pg_catalog.jsonb_build_object('intent',l.intent_text,'snapshot',null,'receipt',l.receipt)) from
  (select distinct on (source_repair.document->'repair'->>'id') source_repair.* from public.native_management_records_v1 source_repair where source_repair.negocio_id=p_negocio_id and source_repair.scope_kind=p_scope_kind and source_repair.sucursal_id is not distinct from p_sucursal_id and source_repair.kind in('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') order by source_repair.document->'repair'->>'id',(source_repair.document->'repair'->>'revision')::bigint desc) mr join public.native_sales_ledger_v1 l on l.negocio_id=mr.negocio_id and l.operation_id=mr.operation_id where public.native_member_role_v1(p_negocio_id) in('owner','admin')
  union all select 'LAYAWAY',mr.document->'layaway'->>'id',pg_catalog.jsonb_build_object('kind','LAYAWAY','id',mr.document->'layaway'->>'id','event',pg_catalog.jsonb_build_object('intent',l.intent_text,'snapshot',null,'receipt',l.receipt)) from
  (select distinct on (source_repair.document->'layaway'->>'id') source_repair.* from public.native_management_records_v1 source_repair where source_repair.negocio_id=p_negocio_id and source_repair.scope_kind=p_scope_kind and source_repair.sucursal_id is not distinct from p_sucursal_id and source_repair.kind in('LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL') order by source_repair.document->'layaway'->>'id',(source_repair.document->'layaway'->>'revision')::bigint desc) mr join public.native_sales_ledger_v1 l on l.negocio_id=mr.negocio_id and l.operation_id=mr.operation_id where public.native_member_role_v1(p_negocio_id) in('owner','admin')
  union all select 'SERIAL',s.id::text,pg_catalog.jsonb_build_object('kind','SERIAL','productId',s.producto_id,'text',s.numero_serial,'revision','1','state',case s.estado when 'disponible' then 'AVAILABLE' when 'reservado' then 'RESERVED' when 'apartado' then 'RESERVED' else 'SOLD' end) from public.seriales s where s.negocio_id=p_negocio_id
 ) q;
 cnt:=pg_catalog.jsonb_array_length(rows);if cnt>60000 then raise exception 'NATIVE_BOOTSTRAP_SIZE';end if;
 at_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint;
 header:=pg_catalog.jsonb_build_object('version','ventard.native.operational.1','namespace','NATIVE1','snapshotId',p_snapshot_id,'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'deviceId',p_device_id,'installationId',p_installation_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),'capturedAtMs',at_ms::text,'expiresAtMs',(at_ms+86400000)::text,'coverage','CLOUD_ADOPTED_V1','watermark',watermark::text,'totalCount',cnt,'ticketPrefix','N'||pg_catalog.replace(p_installation_id::text,'-',''),'lastTicket',last_ticket::text,'freeTax',pg_catalog.jsonb_build_object('numerator',(m.free_tax*100)::bigint::text,'denominator','100'),'turn',turn_event,'business',(select pg_catalog.jsonb_build_object('name',g.nombre,'rnc',pg_catalog.to_jsonb(g)->>'rnc','address',pg_catalog.to_jsonb(g)->>'direccion','phone',pg_catalog.to_jsonb(g)->>'telefono','footer',pg_catalog.to_jsonb(g)->>'mensaje_ticket') from public.negocios g where g.id=p_negocio_id),'cashBase',public.native_cash_base_v1(p_negocio_id,p_scope_kind,p_sucursal_id,watermark),'pages','[]'::jsonb);
 insert into public.native_sales_snapshots_v1 values(p_negocio_id,p_snapshot_id,auth.uid(),p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,header,at_ms+86400000);
 for batch in select pg_catalog.jsonb_agg(value order by ordinality) from pg_catalog.jsonb_array_elements(rows) with ordinality group by ((ordinality-1)/200) order by ((ordinality-1)/200) loop
  payload:=public.native_sales_canonical_v1(batch);if pg_catalog.octet_length(payload)>1048576 then raise exception 'NATIVE_BOOTSTRAP_PAGE_SIZE';end if;
  pages:=pages||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',idx,'count',pg_catalog.jsonb_array_length(batch),'byteLength',pg_catalog.octet_length(payload),'sha256',public.native_sales_hash_v1(payload)));
  insert into public.native_sales_pages_v1 values(p_negocio_id,p_snapshot_id,idx,payload);idx:=idx+1;
 end loop;
 header:=pg_catalog.jsonb_set(header,'{pages}',pages);update public.native_sales_snapshots_v1 set manifest=header where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;return header;
end $f$;

-- Source: 20261012203519_native_warranty_staging_v1.sql SHA256 ac0210e31ee2571e262bcc71645a11470cd5e516174cabb2ff2a665049102218
do $guard$ begin end $guard$;
create or replace function public.native_warranty_default_v1(n uuid,k text,b uuid) returns jsonb language sql stable security definer set search_path='' as $$select coalesce((select m.document->'warrantyDefault' from public.native_management_records_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b and m.kind='CONFIG_PATCH' and m.document ? 'warrantyDefault' order by (m.document->'warrantyDefault'->>'revision')::bigint desc limit 1),'{"days":"30","revision":"0"}'::jsonb)$$;
revoke all on function public.native_warranty_default_v1(uuid,text,uuid) from public,anon,authenticated;
create or replace function public.native_warranty_current_v1(n uuid,k text,b uuid,pid uuid,sn text) returns jsonb language plpgsql stable security definer set search_path='' as $f$
#variable_conflict use_variable
declare se public.seriales%rowtype;a jsonb;origin jsonb;item jsonb;sr jsonb;previous jsonb;state text;name text;days text;until_ms text;price text;customer text;date_ms text;op uuid;source_hash text;
begin select * into se from public.seriales where negocio_id=n and producto_id=pid and numero_serial=sn;if not found then raise exception 'NATIVE_SERIAL_CONFLICT';end if;
 state:=case se.estado when 'vendido' then 'SOLD' when 'disponible' then 'AVAILABLE' when 'reservado' then 'RESERVED' when 'apartado' then 'RESERVED' else null end;if state is null then raise exception 'NATIVE_SERIAL_CONFLICT';end if;
 select p.nombre into name from public.productos p where p.negocio_id=n and p.id=pid;if name is null then raise exception 'NATIVE_SERIAL_CONFLICT';end if;
 if state='SOLD' then
  op:=se.venta_id;select l.intent_text::jsonb into origin from public.native_sales_ledger_v1 l where l.negocio_id=n and l.operation_id=op and l.scope_kind=k and l.sucursal_id is not distinct from b;
  if origin->>'kind'='LAYAWAY_COMPLETE' then select value into item from pg_catalog.jsonb_array_elements(origin->'payload'->'document'->'layaway'->'definition'->'items') where value->>'productId'=pid::text and value->>'serial'=sn;name:=item->>'name';price:=item->>'priceCents';customer:=origin->'payload'->'document'->'layaway'->'definition'->>'customerName';date_ms:=origin->>'originAtUtcMs';days:=origin->'payload'->'document'->'layaway'->>'warrantyDays';until_ms:=origin->'payload'->'document'->'layaway'->>'warrantyUntilMs';
  elsif origin->>'kind'='SALE_CONFIRM' then select value into item from pg_catalog.jsonb_array_elements(origin->'payload'->'sale'->'lines') where value->>'productId'=pid::text and value->>'serial'=sn;select value into sr from pg_catalog.jsonb_array_elements(origin->'payload'->'sale'->'serials') where value->>'productId'=pid::text and value->>'text'=sn;name:=item->>'name';price:=item->>'unitPriceCents';customer:=origin->'payload'->'sale'->'customer'->>'name';date_ms:=origin->>'originAtUtcMs';days:=sr->>'warrantyDays';until_ms:=case when days::bigint>0 then (date_ms::bigint+days::bigint*86400000)::text else null end;
  else date_ms:=se.fecha_venta::text;days:=se.garantia_dias::text;until_ms:=se.garantia_hasta::text;price:=(se.precio_venta*100)::bigint::text;customer:=se.cliente_nombre;end if;
 end if;
 a:=pg_catalog.jsonb_build_object('productId',pid,'serial',sn,'name',name,'state',state,'sourceOperationId',op,'soldAtMs',date_ms,'customerName',customer,'priceCents',price,'days',days,'untilMs',until_ms);
 source_hash:=public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object('productId',pid,'serial',sn,'sourceOperationId',op,'soldAtMs',date_ms,'priceCents',price,'customerName',customer)));a:=a||pg_catalog.jsonb_build_object('sourceHash',source_hash,'version','0');
 if state='SOLD' then select m.document->'warranty' into previous from public.native_management_records_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b and m.kind='WARRANTY_PATCH' and m.document->'warranty'->>'productId'=pid::text and m.document->'warranty'->>'serial'=sn and m.document->'warranty'->>'sourceHash'=source_hash order by (m.document->'warranty'->>'version')::bigint desc limit 1;if previous is not null then a:=previous;end if;end if;
 return a||pg_catalog.jsonb_build_object('revision',public.native_sales_hash_v1(public.native_sales_canonical_v1(a)));
end $f$;
revoke all on function public.native_warranty_current_v1(uuid,text,uuid,uuid,text) from public,anon,authenticated;
create or replace function public.native_warranty_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
#variable_conflict use_variable
declare v jsonb;req jsonb;doc jsonb;old public.native_sales_ledger_v1%rowtype;n uuid;op uuid;i uuid;d uuid;b uuid;k text;epoch bigint;role text;kind text;a jsonb;expected jsonb;defaults jsonb;days bigint;version bigint;pid uuid;sn text;seq bigint;receipt jsonb;effects jsonb;business jsonb;clock_ms text;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 or p_snapshot is not null or p_snapshot_hash is not null then raise exception 'NATIVE_COMMAND_SIZE';end if;v:=p_intent::jsonb;kind:=v->>'kind';if kind not in('WARRANTY_PATCH','CONFIG_PATCH') or public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent) is distinct from p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);if v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or v->'expectedVersions' is distinct from '{}'::jsonb or v->'dependencies' is distinct from '[]'::jsonb or v->'originalTurnId' is distinct from 'null'::jsonb then raise exception 'NATIVE_INTENT_INVALID';end if;
 perform public.native_sales_int_v1(v->'originAtUtcMs');n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or (v->>'actorId')::uuid is distinct from auth.uid() or role not in('owner','admin') or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role and rr.receipt->'license'->>'planTier'='pro') then raise exception using errcode='42501',message='NATIVE_PRO_REQUIRED';end if;perform 1 from public.native_entitlements_v1 where negocio_id=n and plan_tier='pro' for share;if not found then raise exception using errcode='42501',message='NATIVE_PRO_REQUIRED';end if;
 if not exists(select 1 from public.native_sales_mode_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b) then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is not null or old.snapshot_text is not null then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 perform public.native_sales_object_v1(v->'payload',array['request','document']);req:=v->'payload'->'request';doc:=v->'payload'->'document';if req->>'operationId' is distinct from op::text then raise exception 'NATIVE_REQUEST_INVALID';end if;
 if kind='CONFIG_PATCH' then
  perform public.native_sales_object_v1(req,array['kind','operationId','expectedRevision','days']);if req->>'kind' is distinct from 'WARRANTY_DEFAULT' then raise exception 'NATIVE_REQUEST_INVALID';end if;defaults:=public.native_warranty_default_v1(n,k,b);if defaults->>'revision' is distinct from req->>'expectedRevision' then raise exception 'NATIVE_SERVICE_VERSION';end if;days:=public.native_sales_int_v1(req->'days',3650)::bigint;version:=public.native_sales_int_v1(req->'expectedRevision',2147483646)::bigint+1;expected:=pg_catalog.jsonb_build_object('operationId',op,'warrantyDefault',pg_catalog.jsonb_build_object('days',days::text,'revision',version::text),'amountCents','0','method',null,'concept','Garantía por defecto');
 else
  perform public.native_sales_object_v1(req,array['kind','operationId','productId','serial','expectedRevision','action','days']);if req->>'kind' is distinct from 'WARRANTY_SAVE' then raise exception 'NATIVE_REQUEST_INVALID';end if;pid:=(req->>'productId')::uuid;sn:=req->>'serial';a:=public.native_warranty_current_v1(n,k,b,pid,sn);if a->>'revision' is distinct from req->>'expectedRevision' then raise exception 'NATIVE_SERVICE_VERSION';end if;
  if a->>'state' is distinct from 'SOLD' or a->>'soldAtMs' is null or (a->>'soldAtMs')::bigint>(v->>'originAtUtcMs')::bigint then raise exception 'NATIVE_WARRANTY_ORIGIN_UNKNOWN';end if;
  if req->>'action'='ADJUST' then days:=public.native_sales_int_v1(req->'days',3650)::bigint;a:=a||pg_catalog.jsonb_build_object('days',days::text,'untilMs',case when days=0 then null else ((a->>'soldAtMs')::bigint+days*86400000)::text end);
  elsif req->>'action' is distinct from 'CERTIFY' or req->>'days' is distinct from '' or a->>'days' is null then raise exception 'NATIVE_WARRANTY_ORIGIN_UNKNOWN';end if;
  version:=public.native_sales_int_v1(a->'version',2147483646)::bigint+1;a:=(a-'revision')||pg_catalog.jsonb_build_object('version',version::text);business:=doc->'business';if business is null or pg_catalog.jsonb_typeof(business) not in('object','null') then raise exception 'NATIVE_SERVICE_HEADER_INVALID';end if;
  if business<>'null'::jsonb and not exists(select 1 from public.native_sales_snapshots_v1 ss where ss.negocio_id=n and ss.installation_id=i and ss.scope_kind=k and ss.sucursal_id is not distinct from b and ss.manifest->'business'=business) then raise exception 'NATIVE_SERVICE_HEADER_INVALID';end if;
  expected:=pg_catalog.jsonb_build_object('operationId',op,'warranty',a,'business',business,'amountCents','0','method',null,'concept','Garantía '||sn);
 end if;if expected is distinct from doc then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;
 if kind='WARRANTY_PATCH' and req->>'action'='ADJUST' then update public.seriales set garantia_dias=(a->>'days')::integer,garantia_hasta=(a->>'untilMs')::bigint,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where negocio_id=n and producto_id=pid and numero_serial=sn and estado='vendido';end if;
 effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'management'),'kind',kind,'payload',doc));clock_ms:=(pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000))::bigint::text;receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',null,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',null,'ncf',null,'totalCents',null,'effects',effects,'stock','[]'::jsonb);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,kind,p_intent,p_hash,null,null,null,null,seq,receipt);insert into public.native_sales_effects_v1 values(n,op,public.native_sales_effect_id_v1(op,'management'),kind,doc);insert into public.native_management_records_v1 values(n,op,k,b,kind,null,null,null,0,doc->>'concept',v->>'originAtUtcMs',doc);delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;return receipt;
end $f$;
revoke all on function public.native_warranty_submit_v1(text,text,text,text) from public,anon,authenticated;
create or replace function public.native_warranty_sale_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
#variable_conflict use_variable
declare v jsonb;n uuid;op uuid;old boolean;r jsonb;serial jsonb;days bigint;
begin
 v:=p_intent::jsonb;n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));select exists(select 1 from public.native_sales_ledger_v1 l where l.negocio_id=n and l.operation_id=op) into old;
 for serial in select value from pg_catalog.jsonb_array_elements(v->'payload'->'sale'->'serials') loop if serial ? 'warrantyDays' then perform public.native_sales_int_v1(serial->'warrantyDays',3650);end if;end loop;
 r:=public.native_sales_submit_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);if old then return r;end if;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 for serial in select value from pg_catalog.jsonb_array_elements(v->'payload'->'sale'->'serials') loop if serial ? 'warrantyDays' then days:=(serial->>'warrantyDays')::bigint;update public.seriales set garantia_dias=days::integer,garantia_hasta=case when days=0 then null else (v->>'originAtUtcMs')::bigint+days*86400000 end,precio_venta=(select (ln->>'unitPriceCents')::numeric/100 from pg_catalog.jsonb_array_elements(v->'payload'->'sale'->'lines') ln where ln->>'productId'=serial->>'productId'),cliente_nombre=v->'payload'->'sale'->'customer'->>'name' where negocio_id=n and producto_id=(serial->>'productId')::uuid and numero_serial=serial->>'text' and venta_id=op and estado='vendido';end if;end loop;
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;return r;
end $f$;
revoke all on function public.native_warranty_sale_submit_v1(text,text,text,text) from public,anon,authenticated;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
begin if p_intent::jsonb->>'kind' in('WARRANTY_PATCH','CONFIG_PATCH') then return public.native_warranty_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);elsif p_intent::jsonb->>'kind'='SALE_CONFIRM' then return public.native_warranty_sale_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);elsif p_intent::jsonb->>'kind' in('LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL') then return public.native_layaways_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
elsif p_intent::jsonb->>'kind' in('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') then return public.native_repairs_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
elsif p_intent::jsonb->>'kind'='SALE_RETURN' then return public.native_returns_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
elsif p_intent::jsonb->>'kind' in('PRODUCT_CREATE','PRODUCT_PATCH','PRODUCT_DELETE','INVENTORY_DELTA','INVENTORY_COUNT') then return public.native_inventory_submit_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);else return public.native_management_submit_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);end if;end $f$;
revoke all on function public.native_sales_submit_v1(text,text,text,text) from public,anon;grant execute on function public.native_sales_submit_v1(text,text,text,text) to authenticated;

create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare m public.native_sales_mode_v1%rowtype;old public.native_sales_snapshots_v1%rowtype;rows jsonb;batch jsonb;pages jsonb:='[]';header jsonb;payload text;idx integer:=0;cnt integer;at_ms bigint;watermark bigint;last_ticket bigint;turn_event jsonb;
begin
 perform public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if p_snapshot_id is null then raise exception 'NATIVE_SNAPSHOT_ID_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||p_negocio_id::text,0));
 select * into old from public.native_sales_snapshots_v1 x where x.negocio_id=p_negocio_id and x.snapshot_id=p_snapshot_id;
 if found then
  if old.actor_id is distinct from auth.uid() or old.installation_id is distinct from p_installation_id or old.device_id is distinct from p_device_id or old.writer_epoch is distinct from p_writer_epoch or old.scope_kind is distinct from p_scope_kind or old.sucursal_id is distinct from p_sucursal_id then raise exception using errcode='42501',message='NATIVE_SNAPSHOT_CONTEXT_DENIED';end if;
  return old.manifest;
 end if;
 select * into m from public.native_sales_mode_v1 x where x.negocio_id=p_negocio_id and x.scope_kind=p_scope_kind and x.sucursal_id is not distinct from p_sucursal_id;
 if not found then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 -- Legacy direct changes are fenced, and native writers share the tenant lock.
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_venta is null or p.precio_venta<0 or p.precio_venta*100<>pg_catalog.trunc(p.precio_venta*100) or p.precio_venta*100>9007199254740991 or p.costo<0 or p.costo*100<>pg_catalog.trunc(p.costo*100) or p.tasa_itbis is null or p.tasa_itbis not between 0 and 1 or p.tasa_itbis*100<>pg_catalog.trunc(p.tasa_itbis*100))) then raise exception 'NATIVE_PRODUCT_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.composiciones c where c.negocio_id=p_negocio_id and (c.cantidad_necesaria is null or c.cantidad_necesaria<=0 or c.cantidad_necesaria*10000<>pg_catalog.trunc(c.cantidad_necesaria*10000))) then raise exception 'NATIVE_RECIPE_SOURCE_UNVERIFIABLE';end if;
 if exists(select 1 from public.productos p where p.negocio_id=p_negocio_id and (p.precio_2<0 or p.precio_3<0 or p.precio_2*100<>pg_catalog.trunc(p.precio_2*100) or p.precio_3*100<>pg_catalog.trunc(p.precio_3*100) or p.precio_2*100>9007199254740991 or p.precio_3*100>9007199254740991)) then raise exception 'NATIVE_PRICE_TIER_UNVERIFIABLE';end if;
 if exists(select 1 from public.seriales s where s.negocio_id=p_negocio_id and (s.estado is null or s.estado not in('disponible','vendido','reservado','apartado') or (s.estado='apartado' and not exists(select 1 from (select distinct on (mr.document->'layaway'->>'id') mr.* from public.native_management_records_v1 mr where mr.negocio_id=p_negocio_id and mr.kind in('LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL') order by mr.document->'layaway'->>'id',(mr.document->'layaway'->>'revision')::bigint desc) a,pg_catalog.jsonb_array_elements(a.document->'layaway'->'definition'->'items') item where a.document->'layaway'->>'state'='activo' and item->>'productId'=s.producto_id::text and item->>'serial'=s.numero_serial)))) then raise exception 'NATIVE_SERIAL_SOURCE_UNVERIFIABLE';end if;
 select x.last_sequence into watermark from public.native_sales_counter_v1 x where x.negocio_id=p_negocio_id;
 select coalesce(max(pg_catalog.split_part(x.ticket,'-',2)::bigint),0) into last_ticket from public.native_sales_ledger_v1 x where x.negocio_id=p_negocio_id and x.installation_id=p_installation_id and x.writer_epoch=p_writer_epoch and x.ticket is not null;
 select pg_catalog.jsonb_build_object('receipt',l.receipt,'intent',l.intent_text,'snapshot',l.snapshot_text) into turn_event from public.native_sales_turns_v1 t join public.native_sales_ledger_v1 l on l.negocio_id=t.negocio_id and l.operation_id=t.turn_id where t.negocio_id=p_negocio_id and t.scope_kind=p_scope_kind and t.sucursal_id is not distinct from p_sucursal_id and t.status='OPEN';
 select coalesce(pg_catalog.jsonb_agg(v order by kind,id),'[]'::jsonb) into rows from (
  select 'PRODUCT' kind,p.id::text id,pg_catalog.jsonb_build_object('kind','PRODUCT','id',p.id,'name',p.nombre,'code',p.codigo_barras,'revision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),'1'),'deleted',coalesce(p.eliminado,false),'priceTiers',pg_catalog.jsonb_build_object('retailCents',(p.precio_venta*100)::bigint::text,'tier2Cents',(p.precio_2*100)::bigint::text,'tier3Cents',(p.precio_3*100)::bigint::text),'metadata',pg_catalog.jsonb_build_object('costCents',public.native_product_cost_v1(p_negocio_id,p.id)::bigint::text,'taxRate',pg_catalog.jsonb_build_object('numerator',(p.tasa_itbis*100)::bigint::text,'denominator','100'),'productType',p.tipo,'recipeCostPolicy',case when p.tipo='combo' and exists(select 1 from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id) then 'NATIVE_EXACT' else 'DECLARED' end,'location',coalesce((select pm.location from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),pg_catalog.to_jsonb(p)->>'ubicacion',''),'minimum',coalesce((select pm.minimum::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=p.id),pg_catalog.to_jsonb(p)->>'stock_minimo'),'serialRequired',coalesce(p.serializable,false),'recipe',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productId',c.insumo_id,'perUnit',pg_catalog.jsonb_build_object('numerator',(c.cantidad_necesaria*10000)::bigint::text,'denominator','10000'),'revision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=p_negocio_id and pm.producto_id=c.insumo_id),'1')) order by c.insumo_id) from public.composiciones c where c.negocio_id=p_negocio_id and c.producto_padre_id=p.id),'[]'::jsonb)),'stock',pg_catalog.jsonb_build_object('quantity',case when p_scope_kind='GLOBAL' then p.stock_actual::text else inv.stock_actual::text end,'version',st.revision::text,'authority',case when st.revision is null or (p_scope_kind='BRANCH' and inv.stock_actual is null) then 'UNKNOWN' when p_scope_kind='BRANCH' and p.stock_actual is distinct from (select sum(z.stock_actual) from public.inventario_sucursales z where z.producto_id=p.id) then 'DIVERGED' else 'VERIFIED' end)) v from public.productos p left join public.inventario_sucursales inv on inv.producto_id=p.id and inv.sucursal_id=p_sucursal_id left join public.native_sales_stock_v1 st on st.negocio_id=p_negocio_id and st.producto_id=p.id and st.scope_kind=p_scope_kind and st.sucursal_id is not distinct from p_sucursal_id where p.negocio_id=p_negocio_id
  union all select 'CUSTOMER',c.id::text,pg_catalog.jsonb_build_object('kind','CUSTOMER','id',c.id,'name',c.nombre,'balanceCents',x.balance_cents::text,'limitCents',(c.limite_credito*100)::bigint::text,'active',not coalesce(c.eliminado,false),'revision',x.revision::text,'priceTier',coalesce(c.tipo_precio,1)::text,'metadataRevision',coalesce((select cm.revision::text from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id),'1'),'phone',case when exists(select 1 from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id) then (select cm.phone from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id) else pg_catalog.to_jsonb(c)->>'telefono' end,'wholesale',coalesce((select cm.wholesale from public.native_customer_metadata_v1 cm where cm.negocio_id=c.negocio_id and cm.cliente_id=c.id),(pg_catalog.to_jsonb(c)->>'al_por_mayor')::boolean,false)) from public.clientes c join public.native_sales_credit_v1 x on x.negocio_id=c.negocio_id and x.cliente_id=c.id where c.negocio_id=p_negocio_id
  union all select 'REPAIR',mr.document->'repair'->>'id',pg_catalog.jsonb_build_object('kind','REPAIR','id',mr.document->'repair'->>'id','event',pg_catalog.jsonb_build_object('intent',l.intent_text,'snapshot',null,'receipt',l.receipt)) from
  (select distinct on (source_repair.document->'repair'->>'id') source_repair.* from public.native_management_records_v1 source_repair where source_repair.negocio_id=p_negocio_id and source_repair.scope_kind=p_scope_kind and source_repair.sucursal_id is not distinct from p_sucursal_id and source_repair.kind in('REPAIR_CREATE','REPAIR_EDIT','REPAIR_DISASSEMBLE') order by source_repair.document->'repair'->>'id',(source_repair.document->'repair'->>'revision')::bigint desc) mr join public.native_sales_ledger_v1 l on l.negocio_id=mr.negocio_id and l.operation_id=mr.operation_id where public.native_member_role_v1(p_negocio_id) in('owner','admin')
  union all select 'LAYAWAY',mr.document->'layaway'->>'id',pg_catalog.jsonb_build_object('kind','LAYAWAY','id',mr.document->'layaway'->>'id','event',pg_catalog.jsonb_build_object('intent',l.intent_text,'snapshot',null,'receipt',l.receipt)) from
  (select distinct on (source_repair.document->'layaway'->>'id') source_repair.* from public.native_management_records_v1 source_repair where source_repair.negocio_id=p_negocio_id and source_repair.scope_kind=p_scope_kind and source_repair.sucursal_id is not distinct from p_sucursal_id and source_repair.kind in('LAYAWAY_CREATE','LAYAWAY_PAYMENT','LAYAWAY_COMPLETE','LAYAWAY_CANCEL') order by source_repair.document->'layaway'->>'id',(source_repair.document->'layaway'->>'revision')::bigint desc) mr join public.native_sales_ledger_v1 l on l.negocio_id=mr.negocio_id and l.operation_id=mr.operation_id where public.native_member_role_v1(p_negocio_id) in('owner','admin')
  union all select 'WARRANTY_RECORD',mr.operation_id::text,pg_catalog.jsonb_build_object('kind','WARRANTY_RECORD','id',mr.operation_id,'event',pg_catalog.jsonb_build_object('intent',l.intent_text,'snapshot',null,'receipt',l.receipt)) from
  (select distinct on(coalesce(r.document->'warranty'->>'sourceHash','DEFAULT')) r.* from public.native_management_records_v1 r where r.negocio_id=p_negocio_id and r.scope_kind=p_scope_kind and r.sucursal_id is not distinct from p_sucursal_id and (r.kind='WARRANTY_PATCH' or (r.kind='CONFIG_PATCH' and r.document ? 'warrantyDefault')) order by coalesce(r.document->'warranty'->>'sourceHash','DEFAULT'),coalesce((r.document->'warranty'->>'version')::bigint,(r.document->'warrantyDefault'->>'revision')::bigint) desc) mr join public.native_sales_ledger_v1 l on l.negocio_id=mr.negocio_id and l.operation_id=mr.operation_id where public.native_member_role_v1(p_negocio_id) in('owner','admin')
  union all select 'SERIAL',s.id::text,pg_catalog.jsonb_build_object('kind','SERIAL','productId',s.producto_id,'text',s.numero_serial,'revision','1','warranty',public.native_warranty_current_v1(p_negocio_id,p_scope_kind,p_sucursal_id,s.producto_id,s.numero_serial),'state',case s.estado when 'disponible' then 'AVAILABLE' when 'reservado' then 'RESERVED' when 'apartado' then 'RESERVED' else 'SOLD' end) from public.seriales s where s.negocio_id=p_negocio_id
 ) q;
 cnt:=pg_catalog.jsonb_array_length(rows);if cnt>60000 then raise exception 'NATIVE_BOOTSTRAP_SIZE';end if;
 at_ms:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint;
 header:=pg_catalog.jsonb_build_object('version','ventard.native.operational.1','namespace','NATIVE1','snapshotId',p_snapshot_id,'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'deviceId',p_device_id,'installationId',p_installation_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),'capturedAtMs',at_ms::text,'expiresAtMs',(at_ms+86400000)::text,'coverage','CLOUD_ADOPTED_V1','watermark',watermark::text,'totalCount',cnt,'ticketPrefix','N'||pg_catalog.replace(p_installation_id::text,'-',''),'lastTicket',last_ticket::text,'freeTax',pg_catalog.jsonb_build_object('numerator',(m.free_tax*100)::bigint::text,'denominator','100'),'turn',turn_event,'business',(select pg_catalog.jsonb_build_object('name',g.nombre,'rnc',pg_catalog.to_jsonb(g)->>'rnc','address',pg_catalog.to_jsonb(g)->>'direccion','phone',pg_catalog.to_jsonb(g)->>'telefono','footer',pg_catalog.to_jsonb(g)->>'mensaje_ticket') from public.negocios g where g.id=p_negocio_id),'cashBase',public.native_cash_base_v1(p_negocio_id,p_scope_kind,p_sucursal_id,watermark),'pages','[]'::jsonb);
 insert into public.native_sales_snapshots_v1 values(p_negocio_id,p_snapshot_id,auth.uid(),p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,header,at_ms+86400000);
 for batch in select pg_catalog.jsonb_agg(value order by ordinality) from pg_catalog.jsonb_array_elements(rows) with ordinality group by ((ordinality-1)/200) order by ((ordinality-1)/200) loop
  payload:=public.native_sales_canonical_v1(batch);if pg_catalog.octet_length(payload)>1048576 then raise exception 'NATIVE_BOOTSTRAP_PAGE_SIZE';end if;
  pages:=pages||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',idx,'count',pg_catalog.jsonb_array_length(batch),'byteLength',pg_catalog.octet_length(payload),'sha256',public.native_sales_hash_v1(payload)));
  insert into public.native_sales_pages_v1 values(p_negocio_id,p_snapshot_id,idx,payload);idx:=idx+1;
 end loop;
 header:=pg_catalog.jsonb_set(header,'{pages}',pages);update public.native_sales_snapshots_v1 set manifest=header where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;return header;
end $f$;

-- Source: 20261012222616_native_layaway_serial_state_compat_v1.sql SHA256 315170faaa177ab8ca8346c624ecf32a9e63fd60df8b6e43eda3cacc92dfd902
-- Baseline seriales_estado_check only allowed disponible/vendido.

do $guard$ begin

end $guard$;
alter table public.seriales drop constraint if exists seriales_estado_check;
alter table public.seriales add constraint seriales_estado_check
 check (estado in ('disponible','vendido','apartado'));

-- Source: 20261012230033_native_business_settings_staging_v1.sql SHA256 635752103b2ec911bb253fd470a67d78a1dd6481bc394441da3e3355a53789c4
do $guard$ begin

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

-- Source: 20261013163641_native_web_reconciliation_staging_v1.sql SHA256 27cde28a65e7eab3304de740b3c6065da7d99dac40f64f9481b8358ddce48571
do $guard$ begin

end $guard$;
-- Preserve numeric lexemes, including numbers nested in payments/items. A
-- tagged number is an observation, never native cents or an APPLIED receipt.
create or replace function public.native_web_observation_json_v1(v jsonb,depth integer default 0)
 returns jsonb language plpgsql immutable set search_path='' as $f$
declare result jsonb;key text;item jsonb;
begin
 if depth>64 then raise exception 'WEB_OBSERVATION_DEPTH';end if;
 case pg_catalog.jsonb_typeof(v)
 when 'number' then return pg_catalog.jsonb_build_object('$number',v#>>'{}');
 when 'array' then
  result:='[]'::jsonb;for item in select value from pg_catalog.jsonb_array_elements(v) loop result:=result||pg_catalog.jsonb_build_array(public.native_web_observation_json_v1(item,depth+1));end loop;return result;
 when 'object' then
  result:='{}'::jsonb;for key,item in select * from pg_catalog.jsonb_each(v) loop
   if key in('$number','$milliseconds') then raise exception 'WEB_OBSERVATION_RESERVED_KEY';end if;
   result:=result||pg_catalog.jsonb_build_object(key,public.native_web_observation_json_v1(item,depth+1));end loop;return result;
 else return v;end case;
end $f$;
revoke all on function public.native_web_observation_json_v1(jsonb,integer) from public,anon,authenticated;
create or replace function public.native_web_observe_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_observation_id uuid,p_table text,p_ids text[])
 returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare role text;relation oid;row_json jsonb;encoded jsonb;rows jsonb:='[]'::jsonb;col record;clock_ms text;answer jsonb;scope_filter text:='';
begin
 role:=public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if role not in('owner','admin') then raise exception using errcode='42501',message='WEB_OBSERVATION_DENIED';end if;
 if p_observation_id is null or p_ids is null or pg_catalog.cardinality(p_ids) not between 1 and 100
 or exists(select 1 from pg_catalog.unnest(p_ids) x where x is null or pg_catalog.length(x) not between 1 and 512)
 or (select count(distinct x) from pg_catalog.unnest(p_ids) x)<>pg_catalog.cardinality(p_ids) then raise exception 'WEB_OBSERVATION_REQUEST';end if;
 if p_table is null or p_table not in('apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas') then raise exception 'WEB_OBSERVATION_TABLE';end if;
 relation:=pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(p_table));
 if relation is null or (select count(*) from pg_catalog.pg_attribute where attrelid=relation and attname in('id','negocio_id') and not attisdropped)<>2 then raise exception 'WEB_OBSERVATION_UNAVAILABLE';end if;
 if p_scope_kind='BRANCH' and p_table in('apartados','cajas','cortes_caja','devoluciones','gastos','movimientos_stock','reparaciones','transacciones_fiado','venta_detalles','ventas') then
  if not exists(select 1 from pg_catalog.pg_attribute where attrelid=relation and attname='sucursal_id' and not attisdropped) then raise exception 'WEB_OBSERVATION_UNAVAILABLE';end if;
  scope_filter:=' and t.sucursal_id=$3';
 end if;
 -- One statement snapshot per batch; separate batches may observe different
 -- moments. No server ledger, allocation, cursor, stock or financial mutation.
 for row_json in execute pg_catalog.format('select pg_catalog.to_jsonb(t) from public.%I t where t.negocio_id=$1 and t.id::text=any($2)%s order by t.id limit 101',p_table,scope_filter) using p_negocio_id,p_ids,p_sucursal_id loop
  encoded:=public.native_web_observation_json_v1(row_json);
  for col in select attname,atttypid from pg_catalog.pg_attribute where attrelid=relation and attnum>0 and not attisdropped and atttypid='pg_catalog.timestamptz'::pg_catalog.regtype loop
   if row_json->col.attname<>'null'::jsonb then encoded:=pg_catalog.jsonb_set(encoded,array[col.attname],pg_catalog.jsonb_build_object('$milliseconds',((extract(epoch from (row_json->>col.attname)::timestamptz)*1000)::numeric)::text));end if;
  end loop;
  rows:=rows||pg_catalog.jsonb_build_array(encoded);
 end loop;
 clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.statement_timestamp())*1000)::bigint::text;
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.web.observation.1','observationId',p_observation_id,'tenantId',p_negocio_id,'actorId',auth.uid(),'installationId',p_installation_id,'deviceId',p_device_id,'writerEpoch',p_writer_epoch::text,'scope',pg_catalog.jsonb_build_object('type',p_scope_kind,'branchId',p_sucursal_id),'table',p_table,'requestedIds',pg_catalog.to_jsonb(p_ids),'capturedAtMs',clock_ms,'coverage','REQUESTED_IDS_ONLY','decimalEncoding','TAGGED_NUMBERS_V1','rows',rows);
 if pg_catalog.octet_length(answer::text)>2097152 then raise exception 'WEB_OBSERVATION_TOO_LARGE';end if;
 return answer;
end $f$;
revoke all on function public.native_web_observe_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.native_web_observe_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,text,text[]) to authenticated;

-- Source: 20261013180055_native_web_observation_legacy_types_staging_v1.sql SHA256 f0ed8cbee5d924fde3fa25716575885341111669bea2f62993697235e59be0b2
-- Compatibility repair for the read-only observation RPC. The deployed legacy
-- tables use both UUID and text identifiers. Returns without a branch column
-- must prove their branch through the same tenant's sale; never add a fabricated
-- sucursal_id to the original row. No business data or permissions are changed.

do $guard$ begin

end $guard$;
create or replace function public.native_web_observe_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_observation_id uuid,p_table text,p_ids text[])
 returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare role text;relation oid;parent_relation oid;item record;row_json jsonb;encoded jsonb;rows jsonb:='[]'::jsonb;col record;clock_ms text;answer jsonb;
 scope_filter text:='';parent_join text:='';evidence_expr text:='null::jsonb';evidence jsonb:='[]'::jsonb;
begin
 role:=public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if role not in('owner','admin') then raise exception using errcode='42501',message='WEB_OBSERVATION_DENIED';end if;
 if p_observation_id is null or p_ids is null or pg_catalog.cardinality(p_ids) not between 1 and 100
 or exists(select 1 from pg_catalog.unnest(p_ids) x where x is null or pg_catalog.length(x) not between 1 and 512)
 or (select count(distinct x) from pg_catalog.unnest(p_ids) x)<>pg_catalog.cardinality(p_ids) then raise exception 'WEB_OBSERVATION_REQUEST';end if;
 if p_table is null or p_table not in('apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas') then raise exception 'WEB_OBSERVATION_TABLE';end if;
 relation:=pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(p_table));
 if relation is null or (select count(*) from pg_catalog.pg_attribute where attrelid=relation and attname in('id','negocio_id') and not attisdropped and atttypid in('pg_catalog.uuid'::pg_catalog.regtype,'pg_catalog.text'::pg_catalog.regtype))<>2 then raise exception 'WEB_OBSERVATION_UNAVAILABLE';end if;
 if p_scope_kind='BRANCH' and p_table in('apartados','cajas','cortes_caja','devoluciones','gastos','movimientos_stock','reparaciones','transacciones_fiado','venta_detalles','ventas') then
  if exists(select 1 from pg_catalog.pg_attribute where attrelid=relation and attname='sucursal_id' and not attisdropped and atttypid in('pg_catalog.uuid'::pg_catalog.regtype,'pg_catalog.text'::pg_catalog.regtype)) then
   scope_filter:=' and t.sucursal_id::text=$3::text';
  elsif p_table='devoluciones' and not exists(select 1 from pg_catalog.pg_attribute where attrelid=relation and attname='sucursal_id' and not attisdropped) then
   parent_relation:=pg_catalog.to_regclass('public.ventas');
   if parent_relation is null or (select count(*) from pg_catalog.pg_attribute where attrelid=parent_relation and attname in('id','negocio_id','sucursal_id') and not attisdropped and atttypid in('pg_catalog.uuid'::pg_catalog.regtype,'pg_catalog.text'::pg_catalog.regtype))<>3
   or not exists(select 1 from pg_catalog.pg_attribute where attrelid=relation and attname='venta_id' and not attisdropped and atttypid in('pg_catalog.uuid'::pg_catalog.regtype,'pg_catalog.text'::pg_catalog.regtype)) then raise exception 'WEB_OBSERVATION_UNAVAILABLE';end if;
   parent_join:=' join public.ventas parent on parent.id::text=t.venta_id::text and parent.negocio_id::text=$1::text and parent.sucursal_id::text=$3::text';
   evidence_expr:='pg_catalog.jsonb_build_object(''rowId'',t.id::text,''sourceTable'',''ventas'',''sourceId'',parent.id::text,''tenantId'',parent.negocio_id::text,''branchId'',parent.sucursal_id::text)';
  else raise exception 'WEB_OBSERVATION_UNAVAILABLE';end if;
 end if;
 -- Keep original row fields intact. Scope evidence is a separate observation
 -- of the sale relationship, and never evidence of financial application.
 for item in execute pg_catalog.format('select pg_catalog.to_jsonb(t) as row_data,%s as scope_evidence from public.%I t%s where t.negocio_id::text=$1::text and t.id::text=any($2)%s order by t.id limit 101',evidence_expr,p_table,parent_join,scope_filter) using p_negocio_id,p_ids,p_sucursal_id loop
  row_json:=item.row_data;encoded:=public.native_web_observation_json_v1(row_json);
  for col in select attname from pg_catalog.pg_attribute where attrelid=relation and attnum>0 and not attisdropped and atttypid='pg_catalog.timestamptz'::pg_catalog.regtype loop
   if row_json->col.attname<>'null'::jsonb then encoded:=pg_catalog.jsonb_set(encoded,array[col.attname],pg_catalog.jsonb_build_object('$milliseconds',((extract(epoch from (row_json->>col.attname)::timestamptz)*1000)::numeric)::text));end if;
  end loop;
  rows:=rows||pg_catalog.jsonb_build_array(encoded);
  if item.scope_evidence is not null then evidence:=evidence||pg_catalog.jsonb_build_array(item.scope_evidence);end if;
 end loop;
 clock_ms:=pg_catalog.floor(extract(epoch from pg_catalog.statement_timestamp())*1000)::bigint::text;
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.web.observation.1','observationId',p_observation_id,'tenantId',p_negocio_id,'actorId',auth.uid(),'installationId',p_installation_id,'deviceId',p_device_id,'writerEpoch',p_writer_epoch::text,'scope',pg_catalog.jsonb_build_object('type',p_scope_kind,'branchId',p_sucursal_id),'table',p_table,'requestedIds',pg_catalog.to_jsonb(p_ids),'capturedAtMs',clock_ms,'coverage','REQUESTED_IDS_ONLY','decimalEncoding','TAGGED_NUMBERS_V1','rows',rows);
 -- Preserve the existing response shape for direct-scope rows. Older clients
 -- fail closed only on inherited return scope they could not previously read.
 if evidence<>'[]'::jsonb then answer:=answer||pg_catalog.jsonb_build_object('scopeEvidence',evidence);end if;
 if pg_catalog.octet_length(answer::text)>2097152 then raise exception 'WEB_OBSERVATION_TOO_LARGE';end if;
 return answer;
end $f$;
revoke all on function public.native_web_observe_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.native_web_observe_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,text,text[]) to authenticated;

-- Source: 20261013211219_native_web_full_capture_staging_v1.sql SHA256 7cc5e36a0d3cdab79efb424c8f691a8bafe1e36d2f04032c899644810967b0b0
-- Full read-only legacy capture. No adoption, business writes or new grants to
-- tables/helpers. All stable reads share the invoking statement's MVCC snapshot.

do $guard$ begin

end $guard$;
create or replace function public.native_web_capture_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_capture_id uuid)
 returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare role text;table_name text;relation oid;ids text[];chunk text[];observation jsonb;
 table_rows jsonb;scope_evidence jsonb;tables jsonb:='[]'::jsonb;answer jsonb;
 offset_row integer;row_count integer;total_count integer:=0;byte_count integer:=0;
begin
 role:=public.native_sales_context_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id);
 if role not in('owner','admin') then raise exception using errcode='42501',message='WEB_OBSERVATION_DENIED';end if;
 if p_capture_id is null then raise exception 'WEB_CAPTURE_REQUEST';end if;
 foreach table_name in array array['apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas'] loop
  relation:=pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(table_name));
  if relation is null or (select count(*) from pg_catalog.pg_attribute where attrelid=relation and attname in('id','negocio_id') and not attisdropped and atttypid in('pg_catalog.uuid'::pg_catalog.regtype,'pg_catalog.text'::pg_catalog.regtype))<>2 then raise exception 'WEB_OBSERVATION_UNAVAILABLE';end if;
  -- Explicit cap: never present a truncated history as a complete capture.
  execute pg_catalog.format('select pg_catalog.array_agg(id::text order by id::text) from (select id from public.%I where negocio_id::text=$1::text order by id::text limit 200001) bounded',table_name) into ids using p_negocio_id;
  if coalesce(pg_catalog.cardinality(ids),0)>200000 then raise exception 'WEB_OBSERVATION_TOO_LARGE';end if;
  table_rows:='[]'::jsonb;scope_evidence:='[]'::jsonb;offset_row:=1;
  while offset_row<=coalesce(pg_catalog.cardinality(ids),0) loop
   chunk:=ids[offset_row:offset_row+99];
   observation:=public.native_web_observe_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,p_capture_id,table_name,chunk);
   table_rows:=table_rows||(observation->'rows');
   scope_evidence:=scope_evidence||coalesce(observation->'scopeEvidence','[]'::jsonb);
   byte_count:=byte_count+pg_catalog.octet_length((observation->'rows')::text)+pg_catalog.octet_length(coalesce(observation->'scopeEvidence','[]'::jsonb)::text);
   if byte_count>33000000 then raise exception 'WEB_OBSERVATION_TOO_LARGE';end if;
   offset_row:=offset_row+100;
  end loop;
  row_count:=pg_catalog.jsonb_array_length(table_rows);total_count:=total_count+row_count;
  if total_count>200000 then raise exception 'WEB_OBSERVATION_TOO_LARGE';end if;
  tables:=tables||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('name',table_name,'count',row_count,'rows',table_rows,'scopeEvidence',scope_evidence));
 end loop;
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.web.capture.1','captureId',p_capture_id,
 'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'installationId',p_installation_id,'deviceId',p_device_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),
 'capturedAtMs',pg_catalog.floor(extract(epoch from pg_catalog.statement_timestamp())*1000)::bigint::text,
 'coverage','SCOPE_COMPLETE_SINGLE_SNAPSHOT','decimalEncoding','TAGGED_NUMBERS_V1','tables',tables);
 if pg_catalog.octet_length(answer::text)>33554432 then raise exception 'WEB_OBSERVATION_TOO_LARGE';end if;
 return answer;
end $f$;
revoke all on function public.native_web_capture_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.native_web_capture_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) to authenticated;

-- Source: 20261014004611_native_web_cutover_staging_v1.sql SHA256 3ed0e18fa0f104e85ce5a0aeb8861528848ddd6b0f740924a22758c1a1fc98e0
do $guard$ begin

end $guard$;
create table if not exists public.native_web_cutovers_v1 (
 negocio_id uuid not null references public.negocios(id),cutover_id uuid not null,
 intent text not null,intent_hash text not null check(intent_hash~'^[0-9a-f]{64}$'),receipt jsonb not null,
 actor_id uuid not null,created_at timestamptz not null default pg_catalog.now(),primary key(negocio_id,cutover_id)
);
alter table public.native_web_cutovers_v1 enable row level security;
revoke all on public.native_web_cutovers_v1 from public,anon,authenticated;
create or replace function public.native_web_cutover_normalize_v1(v jsonb,depth integer default 0) returns jsonb language plpgsql immutable set search_path='' as $f$
declare k text;x jsonb;r jsonb:='{}';a jsonb:='[]';s text;n numeric;
begin
 if depth>64 then raise exception 'CUTOVER_INVALID';end if;
 if pg_catalog.jsonb_typeof(v)='object' and (v ? '$number' or v ? '$milliseconds') then
  if (select count(*) from pg_catalog.jsonb_object_keys(v))<>1 then raise exception 'CUTOVER_INVALID';end if;
  s:=coalesce(v->>'$number',v->>'$milliseconds');n:=s::numeric;s:=n::text;
  if n=0 then s:='0';elsif pg_catalog.strpos(s,'.')>0 then s:=pg_catalog.rtrim(pg_catalog.rtrim(s,'0'),'.');end if;
  return pg_catalog.jsonb_build_object('$number',s);
 elsif pg_catalog.jsonb_typeof(v)='object' then
  for k,x in select key,value from pg_catalog.jsonb_each(v) loop
   if k='estado_sincronizacion' or pg_catalog.starts_with(k,'inventory_') or pg_catalog.starts_with(k,'sync_') or k=any(array['remote_receipt','payload_hash','attempt_count','last_attempt_at','next_attempt_at','last_outcome_code','error_class','claim_id','lease_until','conflict','origin_device_id','expected_remote_sequence']) then continue;end if;
   r:=r||pg_catalog.jsonb_build_object(k,public.native_web_cutover_normalize_v1(x,depth+1));
  end loop;return r;
 elsif pg_catalog.jsonb_typeof(v)='array' then
  for x in select value from pg_catalog.jsonb_array_elements(v) loop a:=a||pg_catalog.jsonb_build_array(public.native_web_cutover_normalize_v1(x,depth+1));end loop;return a;
 elsif pg_catalog.jsonb_typeof(v)='number' then raise exception 'CUTOVER_INVALID';
 else return v;end if;
end $f$;
create or replace function public.native_web_cutover_tables_v1(capture jsonb) returns jsonb language plpgsql immutable set search_path='' as $f$
declare t jsonb;rows jsonb;block jsonb;blocks jsonb;offset_n integer;result jsonb:='[]';
begin
 for t in select value from pg_catalog.jsonb_array_elements(capture->'tables') order by value->>'name' collate "C" loop
  select coalesce(pg_catalog.jsonb_agg(public.native_web_cutover_normalize_v1(value) order by value->>'id' collate "C"),'[]'::jsonb) into rows from pg_catalog.jsonb_array_elements(t->'rows');
  offset_n:=0;blocks:='[]';
  while offset_n<pg_catalog.jsonb_array_length(rows) loop
   select pg_catalog.jsonb_agg(value order by ordinality) into block from pg_catalog.jsonb_array_elements(rows) with ordinality where ordinality>offset_n and ordinality<=offset_n+100;
   blocks:=blocks||pg_catalog.jsonb_build_array(public.native_sales_hash_v1(public.native_sales_canonical_v1(block)));offset_n:=offset_n+100;
  end loop;
  result:=result||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('name',t->>'name','count',pg_catalog.jsonb_array_length(rows),'blocks',blocks));
 end loop;return result;
end $f$;
create or replace function public.native_web_cutover_v1(p_intent text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;ctx jsonb;n uuid;i uuid;d uuid;b uuid;e bigint;k text;op uuid;role_name text;old public.native_web_cutovers_v1%rowtype;capture jsonb;t jsonb;row_json jsonb;answer jsonb;activation jsonb;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>524288 then raise exception 'CUTOVER_INVALID';end if;
 v:=p_intent::jsonb;
 if p_hash is null or p_hash!~'^[0-9a-f]{64}$' or public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent)<>p_hash or v->>'protocol' is distinct from 'ventard.web.cutover.1' or v->>'confirmation' is distinct from 'WEB_WRITERS_CLOSED_BALANCES_REVIEWED' then raise exception 'CUTOVER_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','cutoverId','runId','revision','context','backupId','backupHash','runHash','confirmation','freeTax','sources','tables']);
 if (select count(*) from pg_catalog.jsonb_object_keys(v))<>12 or v->>'backupHash'!~'^[0-9a-f]{64}$' or v->>'runHash'!~'^[0-9a-f]{64}$' or v->>'freeTax' not in('0','0.18') or pg_catalog.jsonb_typeof(v->'revision') is distinct from 'number' or pg_catalog.jsonb_typeof(v->'sources') is distinct from 'array' or pg_catalog.jsonb_array_length(v->'sources') not between 1 and 51 then raise exception 'CUTOVER_INVALID';end if;
 perform (v->>'runId')::uuid;perform (v->>'backupId')::uuid;
 ctx:=v->'context';n:=(ctx->>'tenantId')::uuid;i:=(ctx->>'installationId')::uuid;d:=(ctx->>'deviceId')::uuid;e:=public.native_sales_int_v1(ctx->'writerEpoch')::bigint;k:=ctx->>'scopeType';b:=(ctx->>'branchId')::uuid;op:=(v->>'cutoverId')::uuid;
 if n is null or n not in('864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid,'864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid) or op is null or (ctx->>'actorId')::uuid is distinct from auth.uid() then raise exception 'CUTOVER_CONTEXT';end if;
 role_name:=public.native_sales_context_v1(n,i,d,e,k,b);if role_name not in('owner','admin') then raise exception using errcode='42501',message='CUTOVER_DENIED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_web_cutovers_v1 where negocio_id=n and cutover_id=op;
 if found then if old.intent<>p_intent or old.intent_hash<>p_hash then raise exception 'CUTOVER_ID_CONFLICT';end if;return old.receipt;end if;
 -- Same locks/fence used by native sale dispatch. Waiting old writes finish;
 -- later old writers fail when the mode is activated. Offline clients require
 -- the declared operational closure; this is no instant remote offline stop.
 for t in select pg_catalog.to_jsonb(name) from pg_catalog.unnest(array['apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','inventario_sucursales','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas']) as name loop
  execute pg_catalog.format('lock table public.%I in share row exclusive mode',t#>>'{}');
 end loop;
 capture:=public.native_web_capture_v1(n,i,d,e,k,b,op);
 if public.native_web_cutover_tables_v1(capture) is distinct from v->'tables' then raise exception 'CUTOVER_SOURCE_CHANGED';end if;
 for t in select value from pg_catalog.jsonb_array_elements(capture->'tables') loop
  for row_json in select value from pg_catalog.jsonb_array_elements(t->'rows') loop
   if t->>'name'='cajas' and row_json->>'estado' is distinct from 'cerrada' then raise exception 'CUTOVER_CLOSE_WEB_CASH';end if;
   if t->>'name'='reparaciones' and coalesce(row_json->>'estado','') not in('entregado','cancelado','no_reparado') or t->>'name'='apartados' and coalesce(row_json->>'estado','') not in('completado','cancelado') then raise exception 'CUTOVER_SERVICE_REQUIRES_RECONCILIATION';end if;
  end loop;
 end loop;
 -- Baseline authority comes from present cloud facts, never an old sync flag.
 -- Already adopted accounts are compared; their journals/balances are untouched.
 if exists(select 1 from public.transacciones_fiado f where f.negocio_id=n and (f.tipo not in('cargo','abono') or f.tipo is null or f.monto is null or f.monto<0 or f.monto*100<>pg_catalog.trunc(f.monto*100) or not exists(select 1 from public.clientes c where c.id=f.cliente_id and c.negocio_id=n))) then raise exception 'CUTOVER_CREDIT_UNVERIFIABLE';end if;
 if exists(select 1 from public.clientes c where c.negocio_id=n and (coalesce((select sum(case when f.tipo='cargo' then f.monto else -f.monto end)*100 from public.transacciones_fiado f where f.negocio_id=n and f.cliente_id=c.id),0)<0 or coalesce((select sum(case when f.tipo='cargo' then f.monto else -f.monto end)*100 from public.transacciones_fiado f where f.negocio_id=n and f.cliente_id=c.id),0)>9007199254740991)) then raise exception 'CUTOVER_CREDIT_UNVERIFIABLE';end if;
 if exists(select 1 from public.native_sales_mode_v1 where negocio_id=n) and exists(select 1 from public.clientes c left join public.native_sales_credit_v1 x on x.negocio_id=c.negocio_id and x.cliente_id=c.id where c.negocio_id=n and (x.cliente_id is null or x.balance_cents is distinct from coalesce((select sum(case when f.tipo='cargo' then f.monto else -f.monto end)*100 from public.transacciones_fiado f where f.negocio_id=n and f.cliente_id=c.id),0)::bigint)) then raise exception 'CUTOVER_ACTIVE_BALANCE_CONFLICT';end if;
 activation:=public.native_sales_activate_v1(n,i,d,e,k,b,'PRODUCTION_CLOUD_BASELINE_REVIEWED',v->>'freeTax');
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.web.cutover.receipt.1','status','BASELINE_ADOPTED','cutoverId',op,'planHash',p_hash,'context',ctx,'runId',v->'runId','revision',v->'revision','backupId',v->'backupId','coverage','CLOUD_CONVERGED_BASELINE','legacyReplay',false);
 insert into public.native_web_cutovers_v1(negocio_id,cutover_id,intent,intent_hash,receipt,actor_id) values(n,op,p_intent,p_hash,answer,auth.uid());return answer;
end $f$;
create or replace function public.native_web_cutover_abandon_v1(p_intent text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;ctx jsonb;n uuid;op uuid;role_name text;old public.native_web_cutovers_v1%rowtype;answer jsonb;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>524288 then raise exception 'CUTOVER_INVALID';end if;
 v:=p_intent::jsonb;ctx:=v->'context';n:=(ctx->>'tenantId')::uuid;op:=(v->>'cutoverId')::uuid;
 if p_hash is null or public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent)<>p_hash or v->>'protocol' is distinct from 'ventard.web.cutover.1' or n not in('864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid,'864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid) or (ctx->>'actorId')::uuid is distinct from auth.uid() then raise exception 'CUTOVER_INVALID';end if;
 role_name:=public.native_sales_context_v1(n,(ctx->>'installationId')::uuid,(ctx->>'deviceId')::uuid,(ctx->>'writerEpoch')::bigint,ctx->>'scopeType',(ctx->>'branchId')::uuid);
 if role_name not in('owner','admin') then raise exception using errcode='42501',message='CUTOVER_DENIED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_web_cutovers_v1 where negocio_id=n and cutover_id=op;
 if found then if old.intent<>p_intent or old.intent_hash<>p_hash then raise exception 'CUTOVER_ID_CONFLICT';end if;return old.receipt;end if;
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.web.cutover.receipt.1','status','ABANDONED','cutoverId',op,'planHash',p_hash,'context',ctx,'runId',v->'runId','revision',v->'revision','backupId',v->'backupId','coverage','NO_BASELINE_CHANGE','legacyReplay',false);
 insert into public.native_web_cutovers_v1(negocio_id,cutover_id,intent,intent_hash,receipt,actor_id) values(n,op,p_intent,p_hash,answer,auth.uid());return answer;
end $f$;
revoke all on function public.native_web_cutover_normalize_v1(jsonb,integer),public.native_web_cutover_tables_v1(jsonb),public.native_web_cutover_v1(text,text),public.native_web_cutover_abandon_v1(text,text) from public,anon,authenticated;
grant execute on function public.native_web_cutover_v1(text,text),public.native_web_cutover_abandon_v1(text,text) to authenticated;
-- Preserve source data and deny every legacy table writer after native mode.
do $fence$ declare t text;begin
 foreach t in array array['apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas'] loop
  if pg_catalog.to_regclass('public.'||t) is not null then
   execute pg_catalog.format('drop trigger if exists native_sales_fence_v1 on public.%I',t);
   execute pg_catalog.format('create trigger native_sales_fence_v1 before insert or update or delete on public.%I for each row execute function public.native_sales_fence_v1()',t);
  end if;
 end loop;
end $fence$;

-- Source: 20261014023547_native_legacy_service_baselines_staging_v1.sql SHA256 8aa72c06e500356439df101230e7b7043712385ccd6bbb63942f565f2b0d6c32
do $guard$ begin end $guard$;
create table if not exists public.native_legacy_services_v1 (
 negocio_id uuid not null references public.negocios(id),scope_kind text not null,sucursal_id uuid,
 service_kind text not null check(service_kind in('repair','layaway')),service_id uuid not null,
 envelope jsonb not null,primary key(negocio_id,service_kind,service_id)
);
alter table public.native_legacy_services_v1 enable row level security;
revoke all on public.native_legacy_services_v1 from public,anon,authenticated;
create or replace function public.native_legacy_service_int_v1(v jsonb,multiplier integer default 1) returns text language plpgsql immutable set search_path='' as $f$
declare n numeric;begin
 n:=coalesce(v->>'$number',v->>'$milliseconds')::numeric*multiplier;
 if n is null or n<0 or n>9007199254740991 or n<>pg_catalog.trunc(n) then raise exception 'CUTOVER_SERVICE_REQUIRES_RECONCILIATION';end if;
 return n::bigint::text;end $f$;
create or replace function public.native_legacy_service_optional_int_v1(v jsonb,multiplier integer default 1) returns text language plpgsql immutable set search_path='' as $f$
begin return public.native_legacy_service_int_v1(v,multiplier);exception when invalid_text_representation or numeric_value_out_of_range or raise_exception then return null;end $f$;
create or replace function public.native_legacy_service_project_v1(t text,source jsonb) returns jsonb language plpgsql immutable set search_path='' as $f$
declare r jsonb:=public.native_web_cutover_normalize_v1(source);d jsonb;def jsonb;parts jsonb:='[]';item jsonb;part jsonb;created text;updated text;total text;paid text;computed numeric:=0;separate boolean;req jsonb;checked jsonb;field text;payments jsonb:='[]';log_json jsonb:='[]';occurrences jsonb:='{}';fingerprint text;occurrence integer;identity text;
begin
 perform (r->>'id')::uuid;created:=public.native_legacy_service_int_v1(r->'fecha_creacion');updated:=public.native_legacy_service_int_v1(r->'fecha_actualizacion');
 if created::bigint>updated::bigint or pg_catalog.length(r->>'folio') not between 1 and 256 or r->>'folio' is null then raise exception 'CUTOVER_SERVICE_REQUIRES_RECONCILIATION';end if;
 total:=public.native_legacy_service_int_v1(r->'total',100);paid:=public.native_legacy_service_int_v1(r->(case when t='apartados' then 'abonado' else 'abono' end),100);
 d:=pg_catalog.jsonb_build_object('id',r->'id','revision','1','folio',r->'folio','folioNumber','1','state',r->'estado','totalCents',total,'paidCents',paid,'payments','[]'::jsonb,'createdAtMs',created,'updatedAtMs',updated,'warrantyDays','0','warrantyUntilMs',null,'legacyBaseline',pg_catalog.jsonb_build_object('protocol','ventard.service.baseline.1','sourceHash',public.native_sales_hash_v1(public.native_sales_canonical_v1(r)),'paidCents',paid));
 field:=case when t='apartados' then 'abonos' else 'pagos' end;
 for item in select value from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(r->field)='array' then r->field else '[]'::jsonb end) loop
  fingerprint:=public.native_sales_hash_v1(public.native_sales_canonical_v1(item));occurrence:=coalesce((occurrences->>fingerprint)::integer,0);occurrences:=occurrences||pg_catalog.jsonb_build_object(fingerprint,occurrence+1);
  identity:=public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_array(r->'negocio_id',t,r->'id',field,fingerprint,occurrence)));
  payments:=payments||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',identity,'amountCents',public.native_legacy_service_optional_int_v1(item->'monto',100),'method',case when pg_catalog.jsonb_typeof(item->'metodo')='string' then item->>'metodo' else null end,'dateMs',public.native_legacy_service_optional_int_v1(item->'fecha')));
 end loop;
 for item in select value from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(r->'bitacora')='array' then r->'bitacora' else '[]'::jsonb end) loop
  log_json:=log_json||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('state',case when pg_catalog.jsonb_typeof(item->'estado')='string' then item->>'estado' else null end,'dateMs',public.native_legacy_service_optional_int_v1(item->'fecha'),'actor',case when pg_catalog.jsonb_typeof(item->'usuario')='string' then item->>'usuario' else null end));
 end loop;
 d:=pg_catalog.jsonb_set(d,'{legacyBaseline}',d->'legacyBaseline'||pg_catalog.jsonb_build_object('payments',payments,'paymentsRecorded',coalesce(pg_catalog.jsonb_typeof(r->field)='array',false),'log',log_json));
 def:=pg_catalog.jsonb_build_object('customerId',r->'cliente_id','customerName',coalesce(r->>'cliente_nombre',''),'phone',coalesce(r->>'cliente_telefono',''),'notes',coalesce(r->>'notas',''));
 if t='apartados' then
  for item in select value from pg_catalog.jsonb_array_elements(r->'items') loop
   part:=pg_catalog.jsonb_build_object('productId',item->'producto_id','name',item->'nombre','quantity',public.native_legacy_service_int_v1(item->'cantidad'),'priceCents',public.native_legacy_service_int_v1(item->'precio_unitario',100),'serial',item->'serial_numero');
   computed:=computed+(part->>'quantity')::numeric*(part->>'priceCents')::numeric;parts:=parts||pg_catalog.jsonb_build_array(part);
  end loop;
  if computed<>total::numeric or paid::numeric>computed or r->>'estado' is distinct from 'activo' then raise exception 'CUTOVER_SERVICE_REQUIRES_RECONCILIATION';end if;
  def:=def||pg_catalog.jsonb_build_object('items',parts);d:=d||pg_catalog.jsonb_build_object('completedAtMs',null,'cancelledAtMs',null);
  req:=pg_catalog.jsonb_build_object('kind','LAYAWAY_CREATE','operationId',r->'id','layawayId',r->'id','definition',def,'initialPaymentCents','0','method','TARJETA','turnId',null);
  checked:=public.native_layaway_plan_v1(req,null,created,'00000000-0000-4000-8000-000000000001',r->>'folio','1');
 elsif t='reparaciones' then
  if coalesce(r->>'estado','') not in('recibido','diagnostico','cotizado','en_reparacion','esperando_repuesto','listo','abandonado') then raise exception 'CUTOVER_SERVICE_REQUIRES_RECONCILIATION';end if;
  def:=def||pg_catalog.jsonb_build_object('brand',coalesce(r->>'equipo_marca',''),'model',coalesce(r->>'equipo_modelo',''),'imei',coalesce(r->>'equipo_imei',''),'color',coalesce(r->>'equipo_color',''),'conditionChecks',coalesce(r->'condicion_checklist','[]'::jsonb),'conditionNotes',coalesce(r->>'condicion_entrada',''),'accessories',coalesce(r->>'accesorios',''),'problem',coalesce(r->>'problema_reportado',''),'diagnosis',coalesce(r->>'diagnostico',''),'technician',coalesce(r->>'tecnico_nombre',''),'labourCents',public.native_legacy_service_int_v1(r->'mano_obra',100));
  computed:=(def->>'labourCents')::numeric;
  for item in select value from pg_catalog.jsonb_array_elements(r->'repuestos') loop
   part:=pg_catalog.jsonb_build_object('productId',case when item->'desde_inventario'='true'::jsonb then item->'producto_id' else 'null'::jsonb end,'name',item->'nombre','quantity',public.native_legacy_service_int_v1(item->'cantidad'),'costCents',public.native_legacy_service_int_v1(item->'costo',100),'priceCents',public.native_legacy_service_int_v1(item->'precio',100));
   computed:=computed+(part->>'quantity')::numeric*(part->>'priceCents')::numeric;parts:=parts||pg_catalog.jsonb_build_array(part);
  end loop;
  separate:=computed=total::numeric;
  if not separate and def->>'labourCents'<>total and r->>'estado'<>'abandonado' then raise exception 'CUTOVER_SERVICE_REQUIRES_RECONCILIATION';end if;
  if not separate then select coalesce(pg_catalog.jsonb_agg(value||'{"priceCents":"0"}'::jsonb),'[]'::jsonb) into parts from pg_catalog.jsonb_array_elements(parts);end if;
  def:=def||pg_catalog.jsonb_build_object('partsChargeSeparate',separate,'parts',parts);
  if r->'es_garantia'='true'::jsonb then def:=def||pg_catalog.jsonb_build_object('warrantyOriginId',r->'reparacion_origen_id');end if;
  d:=d||pg_catalog.jsonb_build_object('log','[]'::jsonb,'deliveredAtMs',null);
  req:=pg_catalog.jsonb_build_object('kind','REPAIR_SAVE','operationId',r->'id','repairId',r->'id','expectedRevision','0','definition',def,'quote',false,'initialPaymentCents','0','method','TARJETA','turnId',null);
  checked:=public.native_repair_plan_v1(req,null,created,'00000000-0000-4000-8000-000000000001',r->>'folio','1');
 else raise exception 'CUTOVER_SERVICE_REQUIRES_RECONCILIATION';end if;
 return d||pg_catalog.jsonb_build_object('definition',def);
end $f$;
-- Separate authority from native operation journal and old APPLIED flags.
create or replace view public.native_service_records_v1 as
 select negocio_id,operation_id,scope_kind,sucursal_id,kind,document from public.native_management_records_v1
 union all select negocio_id,(envelope->'receipt'->>'cutoverId')::uuid,scope_kind,sucursal_id,
 case service_kind when 'repair' then 'REPAIR_BASELINE' else 'LAYAWAY_BASELINE' end,
 pg_catalog.jsonb_build_object(service_kind,envelope->'document','business',null) from public.native_legacy_services_v1;
revoke all on public.native_service_records_v1 from public,anon,authenticated;
create or replace function public.native_legacy_services_adopt_v1(capture jsonb,ctx jsonb,cutover uuid,confirmed boolean) returns void language plpgsql set search_path='' as $f$
#variable_conflict use_variable
declare t jsonb;r jsonb;d jsonb;e jsonb;kind text;part jsonb;n uuid:=(ctx->>'tenantId')::uuid;b uuid:=(ctx->>'branchId')::uuid;k text:=ctx->>'scopeType';old jsonb;count_n integer:=0;
begin
 for t in select value from pg_catalog.jsonb_array_elements(capture->'tables') where value->>'name' in('apartados','reparaciones') loop
  for r in select value from pg_catalog.jsonb_array_elements(t->'rows') where (t->>'name'='apartados' and value->>'estado'='activo') or (t->>'name'='reparaciones' and coalesce(value->>'estado','') not in('entregado','cancelado','no_reparado')) loop
   count_n:=count_n+1;if count_n>10000 or confirmed is distinct from true then raise exception 'CUTOVER_SERVICE_RESERVATIONS_REQUIRED';end if;
   d:=public.native_legacy_service_project_v1(t->>'name',r);kind:=case when t->>'name'='apartados' then 'layaway' else 'repair' end;
   select envelope into old from public.native_legacy_services_v1 where negocio_id=n and service_kind=kind and service_id=(r->>'id')::uuid;
   if found then if old->'document' is distinct from d then raise exception 'CUTOVER_SERVICE_BASELINE_CONFLICT';end if;continue;end if;
   if exists(select 1 from public.native_management_records_v1 m where m.negocio_id=n and m.document->kind->>'id'=r->>'id') then raise exception 'CUTOVER_SERVICE_BASELINE_CONFLICT';end if;
   for part in select value from pg_catalog.jsonb_array_elements(d->'definition'->(case kind when 'repair' then 'parts' else 'items' end)) loop
    if part->>'productId' is not null and not exists(select 1 from public.productos p where p.id=(part->>'productId')::uuid and p.negocio_id=n and not coalesce(p.eliminado,false) and p.tipo is distinct from 'combo' and not exists(select 1 from public.composiciones c where c.negocio_id=n and c.producto_padre_id=p.id) and (kind='layaway' or not coalesce(p.serializable,false))) then raise exception 'NATIVE_SERVICE_PART_UNSUPPORTED';end if;
    if kind='layaway' and part->>'serial' is not null and not exists(select 1 from public.seriales s where s.negocio_id=n and s.producto_id=(part->>'productId')::uuid and s.numero_serial=part->>'serial' and s.estado='apartado') then raise exception 'NATIVE_SERIAL_SOURCE_UNVERIFIABLE';end if;
    if kind='layaway' and part->>'serial' is not null and exists(select 1 from public.native_legacy_services_v1 a,pg_catalog.jsonb_array_elements(a.envelope->'document'->'definition'->'items') x where a.negocio_id=n and a.service_kind='layaway' and x->>'productId'=part->>'productId' and x->>'serial'=part->>'serial') then raise exception 'NATIVE_SERIAL_CONFLICT';end if;
   end loop;
   e:=pg_catalog.jsonb_build_object('table',t->>'name','source',public.native_web_cutover_normalize_v1(r),'document',d,'receipt',pg_catalog.jsonb_build_object('protocol','ventard.service.baseline.receipt.1','status','BASELINE_ADOPTED','cutoverId',cutover,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'sourceHash',d->'legacyBaseline'->'sourceHash','documentHash',public.native_sales_hash_v1(public.native_sales_canonical_v1(d)),'legacyReplay',false));
   insert into public.native_legacy_services_v1 values(n,k,b,kind,(r->>'id')::uuid,e);
  end loop;
 end loop;
 if coalesce((select sum(pg_catalog.octet_length(envelope::text)) from public.native_legacy_services_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b),0)>524288 then raise exception 'CUTOVER_SERVICE_CAPTURE_TOO_LARGE';end if;
end $f$;
create or replace function public.native_legacy_services_current_v1(n uuid,k text,b uuid) returns jsonb language sql stable set search_path='' as $f$
 select coalesce(pg_catalog.jsonb_agg(envelope order by service_kind,service_id),'[]'::jsonb) from public.native_legacy_services_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b;
$f$;
-- Adapt the exact parent contracts, failing closed if incompatible.
do $patch$ declare name text;source text;needle text;replacement text;begin
 foreach name in array array['native_repairs_submit_v1','native_layaways_submit_v1'] loop
  select pg_catalog.pg_get_functiondef(p.oid) into source from pg_catalog.pg_proc p join pg_catalog.pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname=name;
  if source is null then raise exception 'NATIVE_SERVICE_PARENT_INCOMPATIBLE';end if;
  source:=pg_catalog.replace(source,'from public.native_management_records_v1 m where','from public.native_service_records_v1 m where');
  source:=pg_catalog.replace(source,'m.kind in(''REPAIR_CREATE'',''REPAIR_EDIT'',''REPAIR_DISASSEMBLE'')','m.kind in(''REPAIR_CREATE'',''REPAIR_EDIT'',''REPAIR_DISASSEMBLE'',''REPAIR_BASELINE'')');
  source:=pg_catalog.replace(source,'m.kind in(''LAYAWAY_CREATE'',''LAYAWAY_PAYMENT'',''LAYAWAY_COMPLETE'',''LAYAWAY_CANCEL'')','m.kind in(''LAYAWAY_CREATE'',''LAYAWAY_PAYMENT'',''LAYAWAY_COMPLETE'',''LAYAWAY_CANCEL'',''LAYAWAY_BASELINE'')');execute source;
 end loop;
 for source in select pg_catalog.pg_get_functiondef(p.oid) from pg_catalog.pg_proc p join pg_catalog.pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname like 'native_sales_bootstrap%' and pg_catalog.strpos(p.prosrc,'NATIVE_SERIAL_SOURCE_UNVERIFIABLE')>0 loop
  source:=pg_catalog.replace(source,'from public.native_management_records_v1 mr where','from public.native_service_records_v1 mr where');
  source:=pg_catalog.replace(source,'mr.kind in(''LAYAWAY_CREATE'',''LAYAWAY_PAYMENT'',''LAYAWAY_COMPLETE'',''LAYAWAY_CANCEL'')','mr.kind in(''LAYAWAY_CREATE'',''LAYAWAY_PAYMENT'',''LAYAWAY_COMPLETE'',''LAYAWAY_CANCEL'',''LAYAWAY_BASELINE'')');execute source;
 end loop;
 select pg_catalog.pg_get_functiondef('public.native_web_cutover_v1(text,text)'::regprocedure) into source;
 needle:='if t->>''name''=''reparaciones'' and coalesce(row_json->>''estado'','''') not in(''entregado'',''cancelado'',''no_reparado'') or t->>''name''=''apartados'' and coalesce(row_json->>''estado'','''') not in(''completado'',''cancelado'') then raise exception ''CUTOVER_SERVICE_REQUIRES_RECONCILIATION'';end if;';
 if pg_catalog.strpos(source,needle)>0 then
  source:=pg_catalog.replace(source,needle,'');
  source:=pg_catalog.replace(source,'from pg_catalog.jsonb_object_keys(v))<>12','from pg_catalog.jsonb_object_keys(v))<>(12+case when v ? ''serviceReservationsConfirmed'' then 1 else 0 end)');
  source:=pg_catalog.replace(source,'v->>''freeTax'' not in(''0'',''0.18'')','v->>''freeTax'' not in(''0'',''0.18'') or (v ? ''serviceReservationsConfirmed'' and pg_catalog.jsonb_typeof(v->''serviceReservationsConfirmed'') is distinct from ''boolean'')');
  source:=pg_catalog.replace(source,'activation:=public.native_sales_activate_v1','perform public.native_legacy_services_adopt_v1(capture,ctx,op,(v->''serviceReservationsConfirmed''=''true''::jsonb)); activation:=public.native_sales_activate_v1');execute source;
 elsif pg_catalog.strpos(source,'native_legacy_services_adopt_v1')=0 then raise exception 'NATIVE_SERVICE_PARENT_INCOMPATIBLE';end if;
end $patch$;
do $rename$ begin
 if pg_catalog.to_regprocedure('public.native_sales_bootstrap_services_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)') is null then alter function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) rename to native_sales_bootstrap_services_base_v1;end if;
 if pg_catalog.to_regprocedure('public.native_sales_feed_services_base_v1(uuid,uuid,uuid,bigint,text,uuid,bigint)') is null then alter function public.native_sales_feed_v1(uuid,uuid,uuid,bigint,text,uuid,bigint) rename to native_sales_feed_services_base_v1;end if;
end $rename$;
create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare m jsonb;old boolean;begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||p_negocio_id::text,0));
 select exists(select 1 from public.native_sales_snapshots_v1 where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id) into old;
 m:=public.native_sales_bootstrap_services_base_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,p_snapshot_id);
 if old then return m;end if;
 if public.native_member_role_v1(p_negocio_id) in('owner','admin') then m:=m||pg_catalog.jsonb_build_object('legacyServices',public.native_legacy_services_current_v1(p_negocio_id,p_scope_kind,p_sucursal_id));end if;
 update public.native_sales_snapshots_v1 set manifest=m where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;return m;
end $f$;
create or replace function public.native_sales_feed_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_after bigint) returns jsonb language plpgsql security definer set search_path='' as $f$
declare page jsonb;begin
 page:=public.native_sales_feed_services_base_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,p_after);
 if public.native_member_role_v1(p_negocio_id) in('owner','admin') then page:=page||pg_catalog.jsonb_build_object('legacyServices',public.native_legacy_services_current_v1(p_negocio_id,p_scope_kind,p_sucursal_id));end if;return page;end $f$;
revoke all on function public.native_legacy_service_int_v1(jsonb,integer),public.native_legacy_service_optional_int_v1(jsonb,integer),public.native_legacy_service_project_v1(text,jsonb),public.native_legacy_services_adopt_v1(jsonb,jsonb,uuid,boolean),public.native_legacy_services_current_v1(uuid,text,uuid),public.native_sales_bootstrap_services_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid),public.native_sales_feed_services_base_v1(uuid,uuid,uuid,bigint,text,uuid,bigint) from public,anon,authenticated;
revoke all on function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid),public.native_sales_feed_v1(uuid,uuid,uuid,bigint,text,uuid,bigint) from public,anon;
grant execute on function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid),public.native_sales_feed_v1(uuid,uuid,uuid,bigint,text,uuid,bigint) to authenticated;

-- Source: 20261014134601_native_serial_inventory_adjustments_staging_v1.sql SHA256 8e9830abb50bf5aa2fb11549569896ea76d996bc8284faef626e86c05a91a825
do $guard$ begin

end $guard$;
alter table public.seriales drop constraint if exists seriales_estado_check;
alter table public.seriales add constraint seriales_estado_check check(estado in('disponible','vendido','reservado','apartado','merma'));
create or replace function public.native_inventory_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
#variable_conflict use_variable
declare v jsonb;req jsonb;doc jsonb;def jsonb;expected jsonb;meta jsonb;prices jsonb;recipe jsonb:='[]';part jsonb;ingredient public.productos%rowtype;product public.productos%rowtype;old public.native_sales_ledger_v1%rowtype;
 n uuid;op uuid;i uuid;d uuid;b uuid;k text;epoch bigint;role text;kind text;pid uuid;rev bigint;percent bigint;g bigint;num bigint;den bigint;price bigint;cost bigint;tier2 bigint;tier3 bigint;minimum integer;ptype text;serializable boolean;loc text;code text;name text;seq bigint;clock_ms text;effects jsonb;stock jsonb:='[]';receipt jsonb;proof jsonb;pend jsonb;cur integer;after integer;delta integer;version bigint;expected_version bigint;projection numeric;effective numeric;qty integer;mode text;reason text;serial jsonb;sn text;serial_count integer;newserials jsonb:='[]';expected_cost numeric:=0;serial_changes jsonb:='[]';serial_row public.seriales%rowtype;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>1048576 then raise exception 'NATIVE_COMMAND_SIZE';end if;
 v:=p_intent::jsonb;kind:=v->>'kind';
 if kind is null or kind not in('PRODUCT_CREATE','PRODUCT_PATCH','PRODUCT_DELETE','INVENTORY_DELTA','INVENTORY_COUNT') or p_snapshot is not null or p_snapshot_hash is not null then raise exception 'NATIVE_KIND_INVALID';end if;
 if public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent) is distinct from p_hash then raise exception 'NATIVE_CANON_HASH_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','kind','contractVersion','canonicalizationVersion','operationId','negocioId','scope','originDeviceId','installationId','writerEpoch','actorId','permissionGrantId','originalTurnId','originAtUtcMs','expectedVersions','dependencies','payload']);
 if v->>'protocol' is distinct from 'ventard.native.v1' or v->>'canonicalizationVersion' is distinct from 'C-N1' or v->'contractVersion' is distinct from '1'::jsonb or v->'expectedVersions' is distinct from '{}'::jsonb or v->'dependencies' is distinct from '[]'::jsonb or v->>'originalTurnId' is not null then raise exception 'NATIVE_INTENT_INVALID';end if;
 perform public.native_sales_int_v1(v->'originAtUtcMs');n:=(v->>'negocioId')::uuid;op:=(v->>'operationId')::uuid;i:=(v->>'installationId')::uuid;d:=(v->>'originDeviceId')::uuid;epoch:=public.native_sales_int_v1(v->'writerEpoch')::bigint;k:=v->'scope'->>'type';b:=(v->'scope'->>'sucursalId')::uuid;
 role:=public.native_sales_context_v1(n,i,d,epoch,k,b);
 if op is null or (v->>'actorId')::uuid is distinct from auth.uid() or role not in('owner','admin') or not exists(select 1 from public.native_registration_requests_v1 rr where rr.actor_id=auth.uid() and rr.request_id=(v->>'permissionGrantId')::uuid and rr.request->>'tenantId'=n::text and rr.request->>'installationId'=i::text and rr.receipt->>'role'=role) then raise exception using errcode='42501',message='NATIVE_INTENT_CONTEXT_INVALID';end if;
 if not exists(select 1 from public.native_sales_mode_v1 m where m.negocio_id=n and m.scope_kind=k and m.sucursal_id is not distinct from b) then raise exception 'NATIVE_ACTIVATION_REQUIRED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op;
 if found then if old.intent_hash<>p_hash or old.intent_text<>p_intent or old.snapshot_hash is not null or old.snapshot_text is not null then raise exception 'NATIVE_OPERATION_ID_CONFLICT';end if;return old.receipt;end if;
 perform public.native_sales_object_v1(v->'payload',array['request','document']);req:=v->'payload'->'request';doc:=v->'payload'->'document';
 if req->>'operationId' is distinct from op::text or pg_catalog.jsonb_typeof(doc) is distinct from 'object' then raise exception 'NATIVE_REQUEST_INVALID';end if;
 pid:=(req->>'productId')::uuid;if pid is null then raise exception 'NATIVE_REQUEST_INVALID';end if;
 select * into product from public.productos where negocio_id=n and id=pid for update;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n);
 if kind in('PRODUCT_CREATE','PRODUCT_PATCH','PRODUCT_DELETE') then
  rev:=public.native_sales_int_v1(req->'expectedRevision')::bigint;
  if kind='PRODUCT_CREATE' then if rev<>0 or product.id is not null or exists(select 1 from public.productos where id=pid) then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;
  else if product.id is null or coalesce(product.eliminado,false) or rev<>coalesce((select pm.revision from public.native_product_metadata_v1 pm where pm.negocio_id=n and pm.producto_id=pid),1) then raise exception 'NATIVE_PRODUCT_VERSION_CONFLICT';end if;end if;
  if kind='PRODUCT_DELETE' then
   perform public.native_sales_object_v1(req,array['kind','operationId','productId','expectedRevision']);if req->>'kind' is distinct from 'PRODUCT_DELETE' or exists(select 1 from public.composiciones c join public.productos p on p.id=c.producto_padre_id where c.negocio_id=n and c.insumo_id=pid and not coalesce(p.eliminado,false)) then raise exception 'NATIVE_PRODUCT_RECIPE_IN_USE';end if;
   -- Compare unchanged historical fields; deletion retains stock and composition rows.
   if doc->'product'->>'id' is distinct from pid::text or doc->'product'->>'revision' is distinct from (rev+1)::text or doc->'product'->'deleted' is distinct from 'true'::jsonb or doc->'product'->>'name' is distinct from product.nombre or doc->'product'->>'code' is distinct from coalesce(product.codigo_barras,'') or (doc->'product'->'priceTiers'->>'retailCents')::numeric is distinct from product.precio_venta*100 or (doc->'product'->'metadata'->>'costCents')::numeric is distinct from product.costo*100 then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
   update public.productos set eliminado=true,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;
   insert into public.native_product_metadata_v1 values(n,pid,rev+1,coalesce(doc->'product'->'metadata'->>'location',''),coalesce((doc->'product'->'metadata'->>'minimum')::integer,0)) on conflict(negocio_id,producto_id) do update set revision=excluded.revision;
  else
   perform public.native_sales_object_v1(req,array['kind','operationId','productId','expectedRevision','definition']);if req->>'kind' is distinct from 'PRODUCT_SAVE' then raise exception 'NATIVE_REQUEST_INVALID';end if;def:=req->'definition';
   perform public.native_sales_object_v1(def,array['name','code','priceCents','tier2Cents','tier3Cents','costCents','taxPercent','productType','location','minimum','serialRequired','recipe']);
   name:=def->>'name';code:=def->>'code';loc:=def->>'location';ptype:=def->>'productType';
   if pg_catalog.jsonb_typeof(def->'name') is distinct from 'string' or pg_catalog.length(name) not between 1 and 256 or pg_catalog.btrim(name)<>name or name ~ '[[:cntrl:]]' or pg_catalog.jsonb_typeof(def->'code') is distinct from 'string' or pg_catalog.length(code)>64 or pg_catalog.btrim(code)<>code or code ~ '[[:cntrl:]]' or pg_catalog.jsonb_typeof(def->'location') is distinct from 'string' or pg_catalog.length(loc)>256 or pg_catalog.btrim(loc)<>loc or loc ~ '[[:cntrl:]]' or ptype is null or ptype not in('simple','insumo','combo') or pg_catalog.jsonb_typeof(def->'serialRequired') is distinct from 'boolean' then raise exception 'NATIVE_REQUEST_INVALID';end if;
   if code<>'' and exists(select 1 from public.productos where negocio_id=n and codigo_barras=code and id<>pid and not coalesce(eliminado,false)) then raise exception 'NATIVE_PRODUCT_CODE_EXISTS';end if;
   price:=public.native_sales_int_v1(def->'priceCents',999999999999)::bigint;cost:=public.native_sales_int_v1(def->'costCents',999999999999)::bigint;minimum:=public.native_sales_int_v1(def->'minimum',2147483647)::integer;percent:=public.native_sales_int_v1(def->'taxPercent',100)::bigint;
   if def->'tier2Cents'<>'null'::jsonb then tier2:=public.native_sales_int_v1(def->'tier2Cents')::bigint;end if;if def->'tier3Cents'<>'null'::jsonb then tier3:=public.native_sales_int_v1(def->'tier3Cents')::bigint;end if;
   serializable:=(def->>'serialRequired')::boolean;if serializable and ptype<>'simple' then raise exception 'NATIVE_PRODUCT_TYPE_IN_USE';end if;
   if kind='PRODUCT_PATCH' and (coalesce(product.serializable,false)<>serializable or (product.tipo='combo')<>(ptype='combo')) and (coalesce(product.stock_actual,0)<>0 or exists(select 1 from public.seriales where negocio_id=n and producto_id=pid) or exists(select 1 from public.composiciones where negocio_id=n and insumo_id=pid)) then raise exception 'NATIVE_PRODUCT_TYPE_IN_USE';end if;
   if pg_catalog.jsonb_typeof(def->'recipe') is distinct from 'array' or pg_catalog.jsonb_array_length(def->'recipe')>100 or (ptype='combo')<>(pg_catalog.jsonb_array_length(def->'recipe')>0) or (select count(distinct x->>'productId') from pg_catalog.jsonb_array_elements(def->'recipe') x)<>pg_catalog.jsonb_array_length(def->'recipe') then raise exception 'NATIVE_RECIPE_INVALID';end if;
   for part in select value from pg_catalog.jsonb_array_elements(def->'recipe') order by value->>'productId' loop
    perform public.native_sales_object_v1(part,array['productId','numerator','denominator']);select * into ingredient from public.productos where negocio_id=n and id=(part->>'productId')::uuid;
    num:=public.native_sales_int_v1(part->'numerator',999999999999)::bigint;den:=public.native_sales_int_v1(part->'denominator',10000)::bigint;
    if ingredient.id is null or ingredient.id=pid or coalesce(ingredient.eliminado,false) or coalesce(ingredient.serializable,false) or ingredient.tipo='combo' or num=0 or den=0 or 10000%den<>0 or pg_catalog.gcd(num,den)<>1 or num::numeric/den>99999999.9999 then raise exception 'NATIVE_RECIPE_INVALID';end if;
    expected_cost:=expected_cost+ingredient.costo*100*num/den;
    recipe:=recipe||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',ingredient.id,'perUnit',pg_catalog.jsonb_build_object('numerator',num::text,'denominator',den::text),'revision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=n and pm.producto_id=ingredient.id),'1')));
   end loop;
   if ptype='combo' and (expected_cost<>pg_catalog.trunc(expected_cost) or cost is distinct from expected_cost::bigint) then raise exception 'NATIVE_RECIPE_COST_INVALID';end if;
   g:=pg_catalog.gcd(percent,100::bigint);prices:=pg_catalog.jsonb_build_object('retailCents',price::text,'tier2Cents',tier2::text,'tier3Cents',tier3::text);
   meta:=pg_catalog.jsonb_build_object('costCents',cost::text,'taxRate',pg_catalog.jsonb_build_object('numerator',(percent/g)::text,'denominator',(100/g)::text),'serialRequired',serializable,'recipe',recipe,'productType',ptype,'recipeCostPolicy',case when ptype='combo' then 'NATIVE_EXACT' else 'DECLARED' end,'location',loc,'minimum',minimum::text);
   expected:=pg_catalog.jsonb_build_object('product',pg_catalog.jsonb_build_object('id',pid,'name',name,'code',code,'revision',(rev+1)::text,'deleted',false,'priceTiers',prices,'metadata',meta));
   if doc is distinct from expected then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
   if kind='PRODUCT_CREATE' then
    insert into public.productos(id,negocio_id,nombre,codigo_barras,precio_venta,precio_2,precio_3,costo,stock_actual,stock_minimo,tasa_itbis,tipo,serializable,ubicacion,eliminado,fecha_actualizacion) values(pid,n,name,code,price::numeric/100,tier2::numeric/100,tier3::numeric/100,cost::numeric/100,0,minimum,percent::numeric/100,ptype,serializable,loc,false,(v->>'originAtUtcMs')::bigint);
    if k='BRANCH' then insert into public.inventario_sucursales(sucursal_id,producto_id,stock_actual,stock_minimo,fecha_actualizacion) values(b,pid,0,minimum,(v->>'originAtUtcMs')::bigint);end if;
   else
    update public.productos set nombre=name,codigo_barras=code,precio_venta=price::numeric/100,precio_2=tier2::numeric/100,precio_3=tier3::numeric/100,costo=cost::numeric/100,stock_minimo=minimum,tasa_itbis=percent::numeric/100,tipo=ptype,serializable=serializable,ubicacion=loc,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;
   end if;
   delete from public.composiciones where negocio_id=n and producto_padre_id=pid;
   for part in select value from pg_catalog.jsonb_array_elements(def->'recipe') loop insert into public.composiciones(id,negocio_id,producto_padre_id,insumo_id,cantidad_necesaria) values(public.native_sales_effect_id_v1(op,'recipe/'||(part->>'productId')),n,pid,(part->>'productId')::uuid,(part->>'numerator')::numeric/(part->>'denominator')::numeric);end loop;
   insert into public.native_product_metadata_v1 values(n,pid,rev+1,loc,minimum) on conflict(negocio_id,producto_id) do update set revision=excluded.revision,location=excluded.location,minimum=excluded.minimum;
  end if;
 else
  perform public.native_sales_object_v1(req,array['kind','operationId','productId','expectedStockRevision','mode','quantity','reason','serials']);if req->>'kind' is distinct from 'INVENTORY_CHANGE' or product.id is null or coalesce(product.eliminado,false) or product.tipo='combo' then raise exception 'NATIVE_REQUEST_INVALID';end if;
  qty:=public.native_sales_int_v1(req->'quantity',2147483647)::integer;mode:=req->>'mode';reason:=req->>'reason';
  if mode is null or mode not in('IN','LOSS','COUNT') or (mode<>'COUNT' and qty=0) or pg_catalog.jsonb_typeof(req->'reason') is distinct from 'string' or pg_catalog.length(reason) not between 1 and 256 or pg_catalog.btrim(reason)<>reason or reason ~ '[[:cntrl:]]' or (kind='INVENTORY_COUNT')<>(mode='COUNT') then raise exception 'NATIVE_REQUEST_INVALID';end if;
  proof:=doc->'stockEvidence';perform public.native_sales_object_v1(proof,array['productId','remoteBaseQty','remoteSequence','pending','effectiveQty']);
  if proof->>'productId' is distinct from pid::text or pg_catalog.jsonb_typeof(proof->'pending') is distinct from 'array' or pg_catalog.jsonb_array_length(proof->'pending')>1000 or (select count(distinct x->>'effectId') from pg_catalog.jsonb_array_elements(proof->'pending') x)<>pg_catalog.jsonb_array_length(proof->'pending') then raise exception 'NATIVE_STOCK_COVERAGE_INVALID';end if;
  expected_version:=public.native_sales_int_v1(proof->'remoteSequence')::bigint;
  select revision into version from public.native_sales_stock_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid for update;if not found then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
  if k='BRANCH' then select stock_actual into cur from public.inventario_sucursales where sucursal_id=b and producto_id=pid for update;else cur:=product.stock_actual;end if;if cur is null then raise exception 'NATIVE_STOCK_UNVERIFIED';end if;
  effective:=public.native_sales_int_v1(proof->'remoteBaseQty',2147483647);
  for pend in select value from pg_catalog.jsonb_array_elements(proof->'pending') loop
   select * into old from public.native_sales_ledger_v1 where negocio_id=n and operation_id=(pend->>'operationId')::uuid and installation_id=i and scope_kind=k and sucursal_id is not distinct from b;
   if not found or not exists(select 1 from public.native_sales_effects_v1 x where x.negocio_id=n and x.operation_id=old.operation_id and x.effect_id=(pend->>'effectId')::uuid and x.kind='STOCK' and x.payload->>'productId'=pid::text and x.payload->>'delta'=pend->>'delta') then raise exception 'NATIVE_PENDING_COVERAGE_INVALID';end if;
   effective:=effective+(pend->>'delta')::integer;expected_version:=greatest(expected_version,old.remote_sequence);
  end loop;
  if version<>expected_version or effective<>cur or public.native_sales_int_v1(proof->'effectiveQty',2147483647)<>cur or req->>'expectedStockRevision' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(pg_catalog.jsonb_build_object('quantity',proof->>'effectiveQty','remoteSequence',proof->>'remoteSequence','pending',proof->'pending'))) then raise exception 'NATIVE_STOCK_VERSION_CONFLICT';end if;
  delta:=case mode when 'IN' then qty when 'LOSS' then -qty else qty-cur end;after:=cur+delta;if after<0 then raise exception 'NATIVE_STOCK_UNAVAILABLE';end if;
  if pg_catalog.jsonb_typeof(req->'serials') is distinct from 'array' or pg_catalog.jsonb_array_length(req->'serials')>1000 then raise exception 'NATIVE_SERIAL_INVALID';end if;serial_count:=pg_catalog.jsonb_array_length(req->'serials');
  if coalesce(product.serializable,false) then if serial_count<>qty then raise exception 'NATIVE_SERIAL_INVALID';end if;else if serial_count<>0 then raise exception 'NATIVE_SERIAL_INVALID';end if;end if;
  for serial in select value from pg_catalog.jsonb_array_elements(req->'serials') loop sn:=serial#>>'{}';if pg_catalog.jsonb_typeof(serial) is distinct from 'string' or pg_catalog.length(sn) not between 1 and 128 or sn<>pg_catalog.btrim(sn) or sn ~ '[[:cntrl:]]' or newserials @> pg_catalog.jsonb_build_array(sn) or (mode='IN' and exists(select 1 from public.seriales where negocio_id=n and numero_serial=sn)) then raise exception 'NATIVE_SERIAL_INVALID';end if;newserials:=newserials||pg_catalog.jsonb_build_array(sn);end loop;
  expected:=pg_catalog.jsonb_build_object('productId',pid,'productRevision',coalesce((select pm.revision::text from public.native_product_metadata_v1 pm where pm.negocio_id=n and pm.producto_id=pid),'1'),'delta',delta::text,'before',cur::text,'after',after::text,'mode',mode,'reason',reason,'serials',req->'serials','stockEvidence',proof);
  if coalesce(product.serializable,false) and mode<>'IN' then
   -- Serial ownership is business-wide in the legacy schema. Only its single
   -- verifiable native scope may adjust it; never infer a multi-branch owner.
   if k='BRANCH' and (select count(*) from public.sucursales where negocio_id=n)<>1 then raise exception 'NATIVE_SERIAL_SOURCE_UNVERIFIABLE';end if;
   if (select count(*) from public.seriales where negocio_id=n and producto_id=pid and estado='disponible')<>cur or cur>1000 then raise exception 'SERIAL_INVENTORY_DIVERGED';end if;
   for serial_row in select * from public.seriales where negocio_id=n and producto_id=pid order by numero_serial collate "C" for update loop
    if serial_row.estado='disponible' and ((mode='LOSS' and newserials @> pg_catalog.jsonb_build_array(serial_row.numero_serial)) or (mode='COUNT' and not newserials @> pg_catalog.jsonb_build_array(serial_row.numero_serial))) then
     serial_changes:=serial_changes||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'text',serial_row.numero_serial,'expectedRevision','1','before','AVAILABLE','after','LOST'));
    end if;
   end loop;
   for sn in select value#>>'{}' from pg_catalog.jsonb_array_elements(newserials) loop
    if (select count(*) from public.seriales where negocio_id=n and numero_serial=sn)>1 then raise exception 'NATIVE_SERIAL_INVALID';end if;
    select * into serial_row from public.seriales where negocio_id=n and numero_serial=sn for update;
    if found then
     if serial_row.producto_id<>pid or serial_row.estado not in('disponible','merma') or (mode='LOSS' and serial_row.estado<>'disponible') then raise exception 'NATIVE_SERIAL_INVALID';end if;
     if mode='COUNT' and serial_row.estado='merma' then serial_changes:=serial_changes||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'text',sn,'expectedRevision','1','before','LOST','after','AVAILABLE'));end if;
    elsif mode='LOSS' then raise exception 'NATIVE_SERIAL_INVALID';
    else serial_changes:=serial_changes||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'text',sn,'expectedRevision',null,'before',null,'after','AVAILABLE'));end if;
   end loop;
   select coalesce(pg_catalog.jsonb_agg(value order by value->>'text' collate "C"),'[]'::jsonb) into serial_changes from pg_catalog.jsonb_array_elements(serial_changes);
   expected:=expected||pg_catalog.jsonb_build_object('serialChanges',serial_changes);
  end if;
  if doc is distinct from expected then raise exception 'NATIVE_DOCUMENT_INVALID';end if;
  if k='BRANCH' then
   if exists(select 1 from public.inventario_sucursales z left join public.sucursales br on br.id=z.sucursal_id where z.producto_id=pid and br.negocio_id is distinct from n) then raise exception 'NATIVE_STOCK_SOURCE_UNVERIFIABLE';end if;
   select sum(stock_actual) into projection from public.inventario_sucursales where producto_id=pid;if projection is distinct from product.stock_actual::numeric then raise exception 'AUTHORITY_PROJECTION_DIVERGED';end if;
   update public.inventario_sucursales set stock_actual=after,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where sucursal_id=b and producto_id=pid;
   update public.productos set stock_actual=(projection+delta)::integer,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;
  else update public.productos set stock_actual=after,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where id=pid and negocio_id=n;end if;
  if mode='IN' then
   for serial in select value from pg_catalog.jsonb_array_elements(req->'serials') loop sn:=serial#>>'{}';insert into public.seriales(id,negocio_id,producto_id,numero_serial,estado,fecha_actualizacion) values(public.native_sales_effect_id_v1(op,'serial/'||sn),n,pid,sn,'disponible',(v->>'originAtUtcMs')::bigint);end loop;
  else
   for serial in select value from pg_catalog.jsonb_array_elements(serial_changes) loop
    sn:=serial->>'text';
    if serial->'before'='null'::jsonb then insert into public.seriales(id,negocio_id,producto_id,numero_serial,estado,fecha_actualizacion) values(public.native_sales_effect_id_v1(op,'serial/'||sn),n,pid,sn,'disponible',(v->>'originAtUtcMs')::bigint);
    else update public.seriales set estado=case serial->>'after' when 'LOST' then 'merma' else 'disponible' end,fecha_actualizacion=(v->>'originAtUtcMs')::bigint where negocio_id=n and producto_id=pid and numero_serial=sn;end if;
   end loop;
  end if;
 end if;
 update public.native_sales_counter_v1 set last_sequence=last_sequence+1 where negocio_id=n returning last_sequence into seq;
 effects:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'management'),'kind',kind,'payload',doc));
 if kind='PRODUCT_CREATE' then insert into public.native_sales_stock_v1(negocio_id,scope_kind,sucursal_id,producto_id,revision) values(n,k,b,pid,seq);delta:=0;after:=0;end if;
 if kind='PRODUCT_CREATE' or kind in('INVENTORY_DELTA','INVENTORY_COUNT') then
  update public.native_sales_stock_v1 set revision=seq where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b and producto_id=pid;
  effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'stock/'||pid::text),'kind','STOCK','payload',pg_catalog.jsonb_build_object('productId',pid,'delta',delta::text)));
  stock:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('productId',pid,'after',after::text,'version',seq::text));
 end if;
 for serial in select value from pg_catalog.jsonb_array_elements(serial_changes) loop effects:=effects||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',public.native_sales_effect_id_v1(op,'serial/'||(serial->>'text')),'kind','SERIAL','payload',serial));end loop;
 clock_ms:=(pg_catalog.trunc(extract(epoch from pg_catalog.clock_timestamp())*1000))::bigint::text;
 receipt:=pg_catalog.jsonb_build_object('protocol','ventard.native.receipt.1','status','APPLIED','namespace','NATIVE1','operationId',op,'tenantId',n,'scope',pg_catalog.jsonb_build_object('type',k,'branchId',b),'actorId',auth.uid(),'installationId',i,'deviceId',d,'writerEpoch',epoch::text,'intentHash',p_hash,'snapshotHash',null,'remoteSequence',seq::text,'appliedAtMs',clock_ms,'ticket',null,'ncf',null,'totalCents',null,'effects',effects,'stock',stock);
 insert into public.native_sales_ledger_v1 values(n,op,k,b,auth.uid(),i,d,epoch,kind,p_intent,p_hash,null,null,null,null,seq,receipt);
 for part in select value from pg_catalog.jsonb_array_elements(effects) loop insert into public.native_sales_effects_v1 values(n,op,(part->>'id')::uuid,part->>'kind',part->'payload');end loop;
 insert into public.native_management_records_v1 values(n,op,k,b,kind,null,null,null,0,coalesce(reason,kind),v->>'originAtUtcMs',doc);
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;return receipt;
end $f$;
revoke all on function public.native_inventory_submit_v1(text,text,text,text) from public,anon,authenticated;


-- Preserve every installed bootstrap wrapper and its service/warranty guards.
do $patch$ declare source text;begin
 for source in select pg_catalog.pg_get_functiondef(p.oid) from pg_catalog.pg_proc p join pg_catalog.pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname like 'native_sales_bootstrap%' and pg_catalog.strpos(p.prosrc,'NATIVE_SERIAL_SOURCE_UNVERIFIABLE')>0 loop
  if pg_catalog.strpos(source,'''merma''')=0 then
   if pg_catalog.strpos(source,'s.estado not in(''disponible'',''vendido'',''reservado''')=0 or pg_catalog.strpos(source,'case s.estado when ''disponible'' then ''AVAILABLE''')=0 then raise exception 'NATIVE_SERIAL_PARENT_INCOMPATIBLE';end if;
   source:=pg_catalog.replace(source,'s.estado not in(''disponible'',''vendido'',''reservado''','s.estado not in(''merma'',''disponible'',''vendido'',''reservado''');
   source:=pg_catalog.replace(source,'case s.estado when ''disponible'' then ''AVAILABLE''','case s.estado when ''merma'' then ''LOST'' when ''disponible'' then ''AVAILABLE''');execute source;
  end if;
 end loop;
end $patch$;

-- Source: 20261014140730_native_product_photos_staging_v1.sql SHA256 40c3527cc4c50d7553e5da8985bcffc7fd506b78ea65ab550e0343283756e852
do $guard$ begin end $guard$;
alter table public.native_product_metadata_v1 add column if not exists photo jsonb;
alter table public.productos add column if not exists imagen_url text;
create or replace function public.native_product_photo_validate_v1(d jsonb) returns void language plpgsql set search_path='' as $f$
declare v text;encoded text;data bytea;w bigint;h bigint;
begin
 perform public.native_sales_object_v1(d,array['data']);
 if d->'data'<>'null'::jsonb then
  v:=d->>'data';if pg_catalog.jsonb_typeof(d->'data') is distinct from 'string' or pg_catalog.left(v,22)<>'data:image/png;base64,' or pg_catalog.length(v)>131094 then raise exception 'NATIVE_PRODUCT_PHOTO_INVALID';end if;
  encoded:=pg_catalog.substr(v,23);if encoded !~ '^[A-Za-z0-9+/]*={0,2}$' then raise exception 'NATIVE_PRODUCT_PHOTO_INVALID';end if;
  data:=pg_catalog.decode(encoded,'base64');
  if pg_catalog.octet_length(data) not between 45 and 98304 or pg_catalog.replace(pg_catalog.encode(data,'base64'),E'\n','')<>encoded or pg_catalog.encode(pg_catalog.substr(data,1,16),'hex')<>'89504e470d0a1a0a0000000d49484452' or pg_catalog.encode(pg_catalog.substr(data,pg_catalog.octet_length(data)-11),'hex')<>'0000000049454e44ae426082' then raise exception 'NATIVE_PRODUCT_PHOTO_INVALID';end if;
  w:=pg_catalog.get_byte(data,16)::bigint*16777216+pg_catalog.get_byte(data,17)*65536+pg_catalog.get_byte(data,18)*256+pg_catalog.get_byte(data,19);
  h:=pg_catalog.get_byte(data,20)::bigint*16777216+pg_catalog.get_byte(data,21)*65536+pg_catalog.get_byte(data,22)*256+pg_catalog.get_byte(data,23);
  if w not between 1 and 480 or h not between 1 and 480 or pg_catalog.get_byte(data,24)<>8 or pg_catalog.get_byte(data,25) not in(2,6) or pg_catalog.encode(pg_catalog.substr(data,27,3),'hex')<>'000000' then raise exception 'NATIVE_PRODUCT_PHOTO_INVALID';end if;
 end if;
end $f$;
revoke all on function public.native_product_photo_validate_v1(jsonb) from public,anon,authenticated;
create or replace function public.native_product_photo_metadata_v1(n uuid,pid uuid) returns jsonb language sql stable security definer set search_path='' as $f$
 select case when m.photo is not null then pg_catalog.jsonb_build_object('photo',m.photo)
 when p.imagen_url like 'data:image/png;base64,%' then pg_catalog.jsonb_build_object('photo',pg_catalog.jsonb_build_object('data',p.imagen_url))
 when coalesce(p.imagen_url,'')<>'' then pg_catalog.jsonb_build_object('photo',pg_catalog.jsonb_build_object('data',null,'source',p.imagen_url)) else '{}'::jsonb end
 from public.productos p left join public.native_product_metadata_v1 m on m.negocio_id=p.negocio_id and m.producto_id=p.id where p.negocio_id=n and p.id=pid;
$f$;
revoke all on function public.native_product_photo_metadata_v1(uuid,uuid) from public,anon,authenticated;
do $patch$ declare source text;needle text;begin
 select pg_catalog.pg_get_functiondef('public.native_inventory_submit_v1(text,text,text,text)'::regprocedure) into source;
 if pg_catalog.strpos(source,'native_product_photo_validate_v1')=0 then
  needle:='perform public.native_sales_object_v1(def,array[''name'',''code'',''priceCents'',''tier2Cents'',''tier3Cents'',''costCents'',''taxPercent'',''productType'',''location'',''minimum'',''serialRequired'',''recipe'']);';
  if pg_catalog.strpos(source,needle)=0 then raise exception 'NATIVE_PHOTO_PARENT_INCOMPATIBLE';end if;
  source:=pg_catalog.replace(source,needle,'perform public.native_sales_object_v1(def,case when def ? ''photo'' then array[''name'',''code'',''priceCents'',''tier2Cents'',''tier3Cents'',''costCents'',''taxPercent'',''productType'',''location'',''minimum'',''serialRequired'',''recipe'',''photo''] else array[''name'',''code'',''priceCents'',''tier2Cents'',''tier3Cents'',''costCents'',''taxPercent'',''productType'',''location'',''minimum'',''serialRequired'',''recipe''] end);if def ? ''photo'' then perform public.native_product_photo_validate_v1(def->''photo'');end if;');
  source:=pg_catalog.replace(source,'insert into public.native_product_metadata_v1 values(','insert into public.native_product_metadata_v1(negocio_id,producto_id,revision,location,minimum) values(');
  needle:='expected:=pg_catalog.jsonb_build_object(''product'',pg_catalog.jsonb_build_object(''id'',pid,''name'',name';
  if pg_catalog.strpos(source,needle)=0 then raise exception 'NATIVE_PHOTO_PARENT_INCOMPATIBLE';end if;
  source:=pg_catalog.replace(source,needle,'meta:=meta||case when def ? ''photo'' then pg_catalog.jsonb_build_object(''photo'',def->''photo'') when kind=''PRODUCT_PATCH'' then public.native_product_photo_metadata_v1(n,pid) else ''{}''::jsonb end;'||needle);
  needle:='do update set revision=excluded.revision,location=excluded.location,minimum=excluded.minimum;';
  source:=pg_catalog.replace(source,needle,needle||'if def ? ''photo'' then update public.native_product_metadata_v1 set photo=def->''photo'' where negocio_id=n and producto_id=pid;update public.productos set imagen_url=def->''photo''->>''data'' where negocio_id=n and id=pid;end if;');execute source;
 end if;
 for source in select pg_catalog.pg_get_functiondef(p.oid) from pg_catalog.pg_proc p join pg_catalog.pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname like 'native_sales_bootstrap%' and pg_catalog.strpos(p.prosrc,'''PRODUCT''')>0 loop
  if pg_catalog.strpos(source,'native_product_photo_metadata_v1')=0 and pg_catalog.strpos(source,'''metadata'',pg_catalog.jsonb_build_object(''costCents''')>0 then
   source:=pg_catalog.replace(source,'''metadata'',pg_catalog.jsonb_build_object(''costCents''','''metadata'',public.native_product_photo_metadata_v1(p_negocio_id,p.id)||pg_catalog.jsonb_build_object(''costCents''');
   -- Split by bytes and row count, preserving order and the 1 MiB IPC cap.
   needle:='for batch in select pg_catalog.jsonb_agg(value order by ordinality) from pg_catalog.jsonb_array_elements(rows) with ordinality group by ((ordinality-1)/200) order by ((ordinality-1)/200) loop';
   if pg_catalog.strpos(source,needle)=0 then raise exception 'NATIVE_PHOTO_BOOTSTRAP_PARENT_INCOMPATIBLE';end if;
   source:=pg_catalog.replace(source,needle,'for batch in select pg_catalog.jsonb_agg(value order by ordinality) from (select value,ordinality,pg_catalog.sum(pg_catalog.octet_length(public.native_sales_canonical_v1(value))+1) over(order by ordinality) bytes from pg_catalog.jsonb_array_elements(rows) with ordinality) sized group by ((bytes-1)/800000),((ordinality-1)/200) order by pg_catalog.min(ordinality) loop');execute source;
  end if;
 end loop;
end $patch$;

-- Source: 20261014143238_native_service_refunds_staging_v1.sql SHA256 442cbae62faebd4b68158131fd93bea8ad53dd8a3c4a2f738c6527f67e6f1c9d
do $guard$ begin

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
 perform 1 from public.native_entitlements_v1 where negocio_id=n and plan_tier='pro' for share;if not found then raise exception using errcode='42501',message='NATIVE_PRO_REQUIRED';end if;
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

-- Source: 20261014151242_native_legacy_cash_archive_staging_v1.sql SHA256 5f31da7b0b74eb915fe3ef96f420e67ee3ae3a14623afcd1c9224b4cdb45bf8d
-- Explicit archival consent for historical sales with an unknown cash link.
-- No source row, cash/debt/stock amount, old flag, ticket or identity is changed.

do $guard$ begin

end $guard$;
do $patch$ declare source text;needle text;begin
 select pg_catalog.pg_get_functiondef('public.native_web_cutover_v1(text,text)'::regprocedure) into source;
 if pg_catalog.strpos(source,'legacyCashHistoryConfirmed')=0 then
  needle:='from pg_catalog.jsonb_object_keys(v))<>(12+case when v ? ''serviceReservationsConfirmed'' then 1 else 0 end)';
  if pg_catalog.strpos(source,needle)>0 then
   source:=pg_catalog.replace(source,needle,'from pg_catalog.jsonb_object_keys(v))<>(12+case when v ? ''serviceReservationsConfirmed'' then 1 else 0 end+case when v ? ''legacyCashHistoryConfirmed'' then 1 else 0 end)');
  elsif pg_catalog.strpos(source,'from pg_catalog.jsonb_object_keys(v))<>12')>0 then
   source:=pg_catalog.replace(source,'from pg_catalog.jsonb_object_keys(v))<>12','from pg_catalog.jsonb_object_keys(v))<>(12+case when v ? ''legacyCashHistoryConfirmed'' then 1 else 0 end)');
  else raise exception 'CUTOVER_CASH_PARENT_INCOMPATIBLE';end if;
  source:=pg_catalog.replace(source,'v->>''freeTax'' not in(''0'',''0.18'')','v->>''freeTax'' not in(''0'',''0.18'') or (v ? ''legacyCashHistoryConfirmed'' and pg_catalog.jsonb_typeof(v->''legacyCashHistoryConfirmed'') is distinct from ''boolean'')');
  needle:='if t->>''name''=''cajas'' and row_json->>''estado'' is distinct from ''cerrada'' then raise exception ''CUTOVER_CLOSE_WEB_CASH'';end if;';
  if pg_catalog.strpos(source,needle)=0 then raise exception 'CUTOVER_CASH_PARENT_INCOMPATIBLE';end if;
  source:=pg_catalog.replace(source,needle,needle||$code$
   if t->>'name'='ventas' and pg_catalog.jsonb_typeof(row_json->'caja_id') is distinct from 'string' and
    ((row_json->>'metodo_pago'='efectivo' and coalesce((row_json->'total'->>'$number')::numeric,-1)<>0) or (row_json->>'metodo_pago'='mixto' and coalesce((row_json->'monto_efectivo'->>'$number')::numeric,-1)<>0)) and
    (v->'legacyCashHistoryConfirmed') is distinct from 'true'::jsonb then raise exception 'CUTOVER_CASH_HISTORY_CONFIRMATION_REQUIRED';end if;
  $code$);execute source;
 end if;
end $patch$;

-- Source: 20261014190051_native_history_bootstrap_staging_v1.sql SHA256 6b6182f1dbbf796a9c57931306e4fceaf5d9d721893cf9442ea9b7475f7509f3
-- Native historical facts share the frozen operational snapshot. No replay.

do $guard$ begin

 if pg_catalog.to_regprocedure('public.native_sales_bootstrap_history_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)') is null then alter function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) rename to native_sales_bootstrap_history_base_v1;end if;
end $guard$;
create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare result jsonb;events jsonb;batch jsonb;pages jsonb;native_wire text;idx integer;cnt integer;source record;original jsonb;changed jsonb;owner uuid;
begin
 result:=public.native_sales_bootstrap_history_base_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,p_snapshot_id);
 -- Parent authenticates the exact request and reuses its frozen snapshot.
 if result->>'historyCoverage'='NATIVE_LEDGER_THROUGH_WATERMARK' then return result;end if;
 -- Preserve only explicit native ownership for sold serials, in this scope.
 for source in select page_index,payload from public.native_sales_pages_v1 where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id order by page_index loop
  changed:='[]'::jsonb;
  for original in select value from pg_catalog.jsonb_array_elements(source.payload::jsonb) loop
   if original->>'kind'='SERIAL' and original->>'state'='SOLD' then
    owner:=null;
    select l.operation_id into owner from public.seriales s join public.native_sales_ledger_v1 l on l.negocio_id=s.negocio_id and l.operation_id=s.venta_id and l.kind='SALE_CONFIRM' where s.negocio_id=p_negocio_id and s.producto_id=(original->>'productId')::uuid and s.numero_serial=original->>'text' and s.estado='vendido' and l.scope_kind=p_scope_kind and l.sucursal_id is not distinct from p_sucursal_id and l.remote_sequence<=(result->>'watermark')::bigint;
    if owner is not null then original:=original||pg_catalog.jsonb_build_object('saleOperationId',owner);end if;
   end if;
   changed:=changed||pg_catalog.jsonb_build_array(original);
  end loop;
  native_wire:=public.native_sales_canonical_v1(changed);
  if pg_catalog.octet_length(native_wire)>1048576 then raise exception 'NATIVE_BOOTSTRAP_PAGE_SIZE';end if;
  update public.native_sales_pages_v1 set payload=native_wire where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id and page_index=source.page_index;
  result:=pg_catalog.jsonb_set(result,array['pages',source.page_index::text,'byteLength'],pg_catalog.to_jsonb(pg_catalog.octet_length(native_wire)));
  result:=pg_catalog.jsonb_set(result,array['pages',source.page_index::text,'sha256'],pg_catalog.to_jsonb(public.native_sales_hash_v1(native_wire)));
 end loop;
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind','HISTORY_EVENT','id',l.operation_id,'event',pg_catalog.jsonb_build_object('intent',l.intent_text,'snapshot',l.snapshot_text,'receipt',l.receipt)) order by l.remote_sequence),'[]'::jsonb) into events from public.native_sales_ledger_v1 l where l.negocio_id=p_negocio_id and l.scope_kind=p_scope_kind and l.sucursal_id is not distinct from p_sucursal_id and l.remote_sequence<=(result->>'watermark')::bigint;
 cnt:=pg_catalog.jsonb_array_length(events);
 if cnt+(result->>'totalCount')::integer>60000 then raise exception 'NATIVE_BOOTSTRAP_SIZE';end if;
 pages:=result->'pages';idx:=pg_catalog.jsonb_array_length(pages);
 for batch in select pg_catalog.jsonb_agg(value order by ordinality) from (select value,ordinality,pg_catalog.sum(pg_catalog.octet_length(public.native_sales_canonical_v1(value))+1) over(order by ordinality) bytes from pg_catalog.jsonb_array_elements(events) with ordinality) sized group by ((bytes-1)/800000),((ordinality-1)/200) order by pg_catalog.min(ordinality) loop
  native_wire:=public.native_sales_canonical_v1(batch);if pg_catalog.octet_length(native_wire)>1048576 or idx>=300 then raise exception 'NATIVE_BOOTSTRAP_PAGE_SIZE';end if;
  insert into public.native_sales_pages_v1 values(p_negocio_id,p_snapshot_id,idx,native_wire);
  pages:=pages||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',idx,'count',pg_catalog.jsonb_array_length(batch),'byteLength',pg_catalog.octet_length(native_wire),'sha256',public.native_sales_hash_v1(native_wire)));idx:=idx+1;
 end loop;
 result:=result||pg_catalog.jsonb_build_object('historyCoverage','NATIVE_LEDGER_THROUGH_WATERMARK','historyCount',cnt,'totalCount',cnt+(result->>'totalCount')::integer,'pages',pages);
 update public.native_sales_snapshots_v1 set manifest=result where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;
 return result;
end $f$;
revoke all on function public.native_sales_bootstrap_history_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) from public,anon;
grant execute on function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) to authenticated;

-- Source: 20261014195345_native_recovery_handoff_staging_v1.sql SHA256 f69178231356c99a2b59a2dfd5e51fcdfef6aa9867e02cb6c3d9f2bef5c87a9b
do $guard$ begin end $guard$;
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

-- Source: 20261015011959_native_public_catalogue_staging_v1.sql SHA256 1da4fa2dea7a6c317644d0eda5b682cabc93adc9b05b4c4db1ccb58347fb2232
do $guard$ begin

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

-- Source: 20261015013926_native_team_staging_v1.sql SHA256 d0521a749e90b2e98ad3a81db25908d7532bd4e7f26222e19d3128bdf92c2071
do $guard$ begin

end $guard$;
alter table public.usuarios_negocio add column if not exists invite_expires_at timestamptz;
-- Preserve the original cashier role: signed POS-only access, never admin.
create or replace function public.native_member_role_v1(p_negocio_id uuid) returns text language sql stable security definer set search_path='' as $f$
 select case when n."dueño_id"=auth.uid() then 'owner' else (select u.rol from public.usuarios_negocio u where u.negocio_id=n.id and u.user_id=auth.uid() and u.activo and u.rol in('admin','vendedor','cajero') order by u.id limit 1) end from public.negocios n where auth.uid() is not null and n.id=p_negocio_id and n.id in('864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid,'864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid);
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
 select * into m from public.usuarios_negocio where negocio_id in('864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid,'864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid) and invite_token=p_token and user_id is null and activo and coalesce(invite_expires_at,created_at+interval '24 hours')>pg_catalog.statement_timestamp();
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
 select negocio_id into n from public.usuarios_negocio where negocio_id in('864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid,'864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid) and invite_token=p_token;
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

-- Source: 20261015115206_native_web_resolution_staging_v1.sql SHA256 ffac13aa693beb2efa2fbaf681a11d1e1631e4572b289b2c5ab31e884fd22af4
-- selected historical documents before the first native financial operation.
-- Original captures/intentions remain evidence; no historical APPLIED receipt.

do $guard$ begin

end $guard$;
create table if not exists public.native_web_resolutions_v1 (
 negocio_id uuid not null references public.negocios(id),cutover_id uuid not null,
 source_capture jsonb not null,source_stock jsonb not null,selected_rows jsonb not null,
 receipt jsonb not null,history jsonb not null,history_hash text not null,primary key(negocio_id,cutover_id)
);
alter table public.native_web_resolutions_v1 enable row level security;
revoke all on public.native_web_resolutions_v1 from public,anon,authenticated;
create table if not exists public.native_web_resolution_parts_v1 (
 negocio_id uuid not null,cutover_id uuid not null,context jsonb not null,plan_hash text not null,
 part_count integer not null,part_index integer not null,part_hash text not null,part text not null,
 primary key(negocio_id,cutover_id,part_index)
);
alter table public.native_web_resolution_parts_v1 enable row level security;
revoke all on public.native_web_resolution_parts_v1 from public,anon,authenticated;

create or replace function public.native_web_resolution_stock_v1(n uuid) returns jsonb language sql stable set search_path='' as $f$
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('productId',p.id,'quantity',p.stock_actual::text,'branches',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('branchId',i.sucursal_id,'quantity',i.stock_actual::text) order by i.sucursal_id) from public.inventario_sucursales i where i.producto_id=p.id),'[]'::jsonb)) order by p.id),'[]'::jsonb) from public.productos p where p.negocio_id=n;
$f$;
create or replace function public.native_web_resolution_basis_v1(p_context jsonb,p_capture_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare c jsonb:=p_context;n uuid:=(c->>'tenantId')::uuid;capture jsonb;stock jsonb;r text;
begin
 if (c->>'actorId')::uuid is distinct from auth.uid() then raise exception 'CUTOVER_CONTEXT';end if;
 r:=public.native_sales_context_v1(n,(c->>'installationId')::uuid,(c->>'deviceId')::uuid,(c->>'writerEpoch')::bigint,c->>'scopeType',(c->>'branchId')::uuid);
 if r not in('owner','admin') then raise exception using errcode='42501',message='CUTOVER_DENIED';end if;
 capture:=public.native_web_capture_v1(n,(c->>'installationId')::uuid,(c->>'deviceId')::uuid,(c->>'writerEpoch')::bigint,c->>'scopeType',(c->>'branchId')::uuid,p_capture_id);
 stock:=public.native_web_resolution_stock_v1(n);
 return pg_catalog.jsonb_build_object('protocol','ventard.web.resolution.basis.1','context',c,'captureId',p_capture_id,'tables',public.native_web_cutover_tables_v1(capture),'stockBase',stock,'stockHash',public.native_sales_hash_v1(public.native_sales_canonical_v1(stock)),'started',exists(select 1 from public.native_sales_ledger_v1 where negocio_id=n));
end $f$;
-- Small immutable transport blocks, bound to the actual actor/context. No
-- business effect occurs until every block is assembled and verified.
create or replace function public.native_web_resolution_transport_v1(c jsonb,op uuid,h text,parts integer) returns uuid language plpgsql set search_path='' as $f$
declare n uuid:=(c->>'tenantId')::uuid;r text;begin
 if op is null or h is null or h!~'^[0-9a-f]{64}$' or parts is null or parts not between 1 and 128 or (c->>'actorId')::uuid is distinct from auth.uid() then raise exception 'RESOLUTION_INVALID';end if;
 r:=public.native_sales_context_v1(n,(c->>'installationId')::uuid,(c->>'deviceId')::uuid,(c->>'writerEpoch')::bigint,c->>'scopeType',(c->>'branchId')::uuid);
 if r not in('owner','admin') then raise exception using errcode='42501',message='CUTOVER_DENIED';end if;
 return n;
end $f$;
create or replace function public.native_web_resolution_stage_v1(p_context jsonb,p_cutover_id uuid,p_hash text,p_part_count integer,p_index integer,p_part text,p_part_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare n uuid;old public.native_web_resolution_parts_v1%rowtype;done public.native_web_cutovers_v1%rowtype;bytes_n bigint;begin
 n:=public.native_web_resolution_transport_v1(p_context,p_cutover_id,p_hash,p_part_count);
 if p_index is null or p_index<0 or p_index>=p_part_count or p_part is null or pg_catalog.octet_length(p_part) not between 1 and 524288 or public.native_sales_hash_v1(p_part) is distinct from p_part_hash then raise exception 'RESOLUTION_PART_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into done from public.native_web_cutovers_v1 where negocio_id=n and cutover_id=p_cutover_id;
 if found then
  if done.intent_hash<>p_hash or done.actor_id is distinct from auth.uid() or done.intent::jsonb->'context' is distinct from p_context then raise exception 'CUTOVER_ID_CONFLICT';end if;
  return pg_catalog.jsonb_build_object('status','STAGED','cutoverId',p_cutover_id,'planHash',p_hash,'index',p_index,'partHash',p_part_hash);
 end if;
 select * into old from public.native_web_resolution_parts_v1 where negocio_id=n and cutover_id=p_cutover_id and part_index=p_index;
 if found then if old.context<>p_context or old.plan_hash<>p_hash or old.part_count<>p_part_count or old.part_hash<>p_part_hash or old.part<>p_part then raise exception 'CUTOVER_ID_CONFLICT';end if;
 else
  if exists(select 1 from public.native_web_resolution_parts_v1 where negocio_id=n and cutover_id=p_cutover_id and (context<>p_context or plan_hash<>p_hash or part_count<>p_part_count)) then raise exception 'CUTOVER_ID_CONFLICT';end if;
  select coalesce(sum(pg_catalog.octet_length(part)),0) into bytes_n from public.native_web_resolution_parts_v1 where negocio_id=n and cutover_id=p_cutover_id;
  if bytes_n+pg_catalog.octet_length(p_part)>33554432 then raise exception 'RESOLUTION_TOO_LARGE';end if;
  select coalesce(sum(pg_catalog.octet_length(part)),0) into bytes_n from public.native_web_resolution_parts_v1 where negocio_id=n;
  if bytes_n+pg_catalog.octet_length(p_part)>134217728 then raise exception 'RESOLUTION_TRANSPORT_FULL';end if;
  insert into public.native_web_resolution_parts_v1 values(n,p_cutover_id,p_context,p_hash,p_part_count,p_index,p_part_hash,p_part);
 end if;
 return pg_catalog.jsonb_build_object('status','STAGED','cutoverId',p_cutover_id,'planHash',p_hash,'index',p_index,'partHash',p_part_hash);
end $f$;
create or replace function public.native_web_resolution_assembled_v1(c jsonb,op uuid,h text,parts integer,n uuid) returns text language plpgsql set search_path='' as $f$
declare raw text;actual integer;begin
 if exists(select 1 from public.native_web_resolution_parts_v1 where negocio_id=n and cutover_id=op and (context<>c or plan_hash<>h or part_count<>parts)) then raise exception 'CUTOVER_ID_CONFLICT';end if;
 select count(*),pg_catalog.string_agg(part,'' order by part_index) into actual,raw from public.native_web_resolution_parts_v1 where negocio_id=n and cutover_id=op;
 if actual<>parts then return null;end if;
 if pg_catalog.octet_length(raw)>33554432 or public.native_sales_hash_v1(raw)<>h or public.native_sales_canonical_v1(raw::jsonb)<>raw or raw::jsonb->'context' is distinct from c or raw::jsonb->>'cutoverId' is distinct from op::text or not(raw::jsonb ? 'reconciliation') then raise exception 'RESOLUTION_PART_INVALID';end if;
 return raw;
end $f$;
create or replace function public.native_web_resolution_finish_v1(c jsonb,op uuid,h text,parts integer,cancelled boolean) returns jsonb language plpgsql set search_path='' as $f$
declare n uuid;old public.native_web_cutovers_v1%rowtype;raw text;answer jsonb;begin
 n:=public.native_web_resolution_transport_v1(c,op,h,parts);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_web_cutovers_v1 where negocio_id=n and cutover_id=op;
 if found then if old.intent_hash<>h or old.actor_id is distinct from auth.uid() or old.intent::jsonb->'context' is distinct from c then raise exception 'CUTOVER_ID_CONFLICT';end if;delete from public.native_web_resolution_parts_v1 where negocio_id=n and cutover_id=op;return old.receipt;end if;
 raw:=public.native_web_resolution_assembled_v1(c,op,h,parts,n);
 if raw is null then return pg_catalog.jsonb_build_object('status','UPLOAD_REQUIRED','cutoverId',op,'planHash',h);end if;
 if cancelled then answer:=public.native_web_cutover_abandon_v1(raw,h);else answer:=public.native_web_cutover_v1(raw,h);end if;
 delete from public.native_web_resolution_parts_v1 where negocio_id=n and cutover_id=op;
 return answer;
end $f$;
create or replace function public.native_web_resolution_commit_v1(p_context jsonb,p_cutover_id uuid,p_hash text,p_part_count integer) returns jsonb language sql security definer set search_path='' as $f$
 select public.native_web_resolution_finish_v1(p_context,p_cutover_id,p_hash,p_part_count,false);
$f$;
create or replace function public.native_web_resolution_abandon_v1(p_context jsonb,p_cutover_id uuid,p_hash text,p_part_count integer) returns jsonb language sql security definer set search_path='' as $f$
 select public.native_web_resolution_finish_v1(p_context,p_cutover_id,p_hash,p_part_count,true);
$f$;
do $cancel_size$ declare source text;begin
 select pg_catalog.pg_get_functiondef('public.native_web_cutover_abandon_v1(text,text)'::regprocedure) into source;
 if pg_catalog.strpos(source,'pg_catalog.octet_length(p_intent)>524288')>0 then source:=pg_catalog.replace(source,'pg_catalog.octet_length(p_intent)>524288','pg_catalog.octet_length(p_intent)>33554432');execute source;
 elsif pg_catalog.strpos(source,'pg_catalog.octet_length(p_intent)>33554432')=0 then raise exception 'RESOLUTION_PARENT_INCOMPATIBLE';end if;
end $cancel_size$;
create or replace function public.native_web_resolution_decode_v1(v jsonb,depth integer default 0) returns jsonb language plpgsql immutable set search_path='' as $f$
declare r jsonb:='{}';a jsonb:='[]';k text;x jsonb;begin
 if depth>64 then raise exception 'RESOLUTION_INVALID';end if;
 if pg_catalog.jsonb_typeof(v)='object' and (v ? '$number' or v ? '$milliseconds') then
  if (select count(*) from pg_catalog.jsonb_object_keys(v))<>1 then raise exception 'RESOLUTION_INVALID';end if;
  return pg_catalog.to_jsonb(coalesce(v->>'$number',v->>'$milliseconds')::numeric);
 elsif pg_catalog.jsonb_typeof(v)='object' then
  for k,x in select key,value from pg_catalog.jsonb_each(v) loop r:=r||pg_catalog.jsonb_build_object(k,public.native_web_resolution_decode_v1(x,depth+1));end loop;return r;
 elsif pg_catalog.jsonb_typeof(v)='array' then
  for x in select value from pg_catalog.jsonb_array_elements(v) loop a:=a||pg_catalog.jsonb_build_array(public.native_web_resolution_decode_v1(x,depth+1));end loop;return a;
 else return v;end if;
end $f$;
-- Identifiers come only from this fixed table whitelist and catalogued columns.
-- Unknown compatibility fields stay in selected_rows, never become SQL.
create or replace function public.native_web_resolution_upsert_v1(t text,v jsonb,n uuid,k text,b uuid) returns void language plpgsql set search_path='' as $f$
declare body jsonb:=public.native_web_resolution_decode_v1(v);col record;keys text:='';expr text:='';updates text:='';old_n text;old_json jsonb;
begin
 if t not in('apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas') or body->>'negocio_id' is distinct from n::text or body->>'id' is null then raise exception 'RESOLUTION_SCOPE';end if;
 execute pg_catalog.format('select negocio_id::text from public.%I where id::text=$1',t) into old_n using body->>'id';
 if old_n is not null and old_n<>n::text then raise exception 'RESOLUTION_SCOPE';end if;
 if old_n is not null and t in('apartados','cajas','cortes_caja','devoluciones','gastos','movimientos_stock','reparaciones','transacciones_fiado','venta_detalles','ventas') then
  execute pg_catalog.format('select pg_catalog.to_jsonb(x) from public.%I x where id::text=$1',t) into old_json using body->>'id';
  if old_json ? 'sucursal_id' then if old_json->>'sucursal_id' is distinct from b::text then raise exception 'RESOLUTION_SCOPE';end if;
  elsif t='devoluciones' and not exists(select 1 from public.ventas s where s.id::text=old_json->>'venta_id' and s.negocio_id=n and s.sucursal_id is not distinct from b) then raise exception 'RESOLUTION_SCOPE';end if;
 end if;
 if k='BRANCH' and t='productos' then body:=body-'stock_actual';end if;
 for col in select a.attname,a.atttypid from pg_catalog.pg_attribute a where a.attrelid=pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(t)) and a.attnum>0 and not a.attisdropped and a.attgenerated='' and a.attidentity='' order by a.attnum loop
  if not (body ? col.attname) then continue;end if;
  if col.attname='estado_sincronizacion' or pg_catalog.starts_with(col.attname,'sync_') or pg_catalog.starts_with(col.attname,'inventory_') then continue;end if;
  if col.atttypid in('pg_catalog.timestamptz'::pg_catalog.regtype,'pg_catalog.timestamp'::pg_catalog.regtype) and pg_catalog.jsonb_typeof(body->col.attname)='number' then
   body:=pg_catalog.jsonb_set(body,array[col.attname],pg_catalog.to_jsonb(pg_catalog.to_timestamp((body->>col.attname)::numeric/1000)));
  end if;
  keys:=keys||case when keys='' then '' else ',' end||pg_catalog.quote_ident(col.attname);
  expr:=expr||case when expr='' then '' else ',' end||pg_catalog.format('(pg_catalog.jsonb_populate_record(null::public.%I,$1)).%I',t,col.attname);
  if col.attname not in('id','negocio_id') then updates:=updates||case when updates='' then '' else ',' end||pg_catalog.format('%I=(pg_catalog.jsonb_populate_record(null::public.%I,$1)).%I',col.attname,t,col.attname);end if;
 end loop;
 if keys='' then raise exception 'RESOLUTION_INVALID';end if;
 if old_n is not null then
  if updates<>'' then execute pg_catalog.format('update public.%I set %s where id::text=$2 and negocio_id::text=$3',t,updates) using body,body->>'id',n::text;end if;
 else execute pg_catalog.format('insert into public.%I(%s) select %s',t,keys,expr) using body;end if;
end $f$;
do $rename$ begin
 if pg_catalog.to_regprocedure('public.native_web_cutover_resolution_base_v1(text,text)') is null then alter function public.native_web_cutover_v1(text,text) rename to native_web_cutover_resolution_base_v1;end if;
end $rename$;
create or replace function public.native_web_cutover_v1(p_intent text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;recon jsonb;c jsonb;n uuid;i uuid;d uuid;b uuid;e bigint;k text;op uuid;role_name text;old public.native_web_cutovers_v1%rowtype;
 capture jsonb;stock_before jsonb;t jsonb;r jsonb;decoded jsonb;table_name text;all_rows jsonb:='{}';body jsonb;missing_ids text[];
 item jsonb;pid uuid;cid uuid;quantity bigint;balance bigint;count_n integer;answer jsonb;validation_snapshot uuid;manifest jsonb;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>33554432 then raise exception 'RESOLUTION_TOO_LARGE';end if;
 v:=p_intent::jsonb;
 if not (v ? 'reconciliation') then return public.native_web_cutover_resolution_base_v1(p_intent,p_hash);end if;
 if p_hash is null or public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent)<>p_hash or v->>'protocol' is distinct from 'ventard.web.cutover.1' or v->>'confirmation' is distinct from 'WEB_WRITERS_CLOSED_BALANCES_REVIEWED' then raise exception 'RESOLUTION_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','cutoverId','runId','revision','context','backupId','backupHash','runHash','confirmation','freeTax','sources','tables','reconciliation']);
 if (select count(*) from pg_catalog.jsonb_object_keys(v))<>(13+case when v ? 'serviceReservationsConfirmed' then 1 else 0 end+case when v ? 'legacyCashHistoryConfirmed' then 1 else 0 end) or v->>'freeTax' not in('0','0.18') or v->>'backupHash'!~'^[0-9a-f]{64}$' or v->>'runHash'!~'^[0-9a-f]{64}$' or pg_catalog.jsonb_typeof(v->'revision') is distinct from 'number' then raise exception 'RESOLUTION_INVALID';end if;
 perform (v->>'runId')::uuid;perform (v->>'backupId')::uuid;
 c:=v->'context';n:=(c->>'tenantId')::uuid;i:=(c->>'installationId')::uuid;d:=(c->>'deviceId')::uuid;b:=(c->>'branchId')::uuid;e:=(c->>'writerEpoch')::bigint;k:=c->>'scopeType';op:=(v->>'cutoverId')::uuid;
 if n is null or n not in('864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid,'864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid) or op is null or (c->>'actorId')::uuid is distinct from auth.uid() then raise exception 'CUTOVER_CONTEXT';end if;
 role_name:=public.native_sales_context_v1(n,i,d,e,k,b);if role_name not in('owner','admin') then raise exception using errcode='42501',message='CUTOVER_DENIED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_web_cutovers_v1 where negocio_id=n and cutover_id=op;
 if found then if old.intent<>p_intent or old.intent_hash<>p_hash then raise exception 'CUTOVER_ID_CONFLICT';end if;return old.receipt;end if;
 -- Import is a pre-operation handover, never a rewrite of native trade history.
 if exists(select 1 from public.native_sales_ledger_v1 where negocio_id=n) or exists(select 1 from public.native_sales_turns_v1 where negocio_id=n) then raise exception 'RESOLUTION_NATIVE_ALREADY_STARTED';end if;
 if exists(select 1 from public.native_sales_mode_v1 where negocio_id=n) and exists(select 1 from public.native_installations_v1 where negocio_id=n and installation_id<>i and status='REGISTERED') then raise exception 'RESOLUTION_OTHER_WRITERS_ACTIVE';end if;
 recon:=v->'reconciliation';
 perform public.native_sales_object_v1(recon,array['protocol','reason','basis','rows','stockCounts','debtBalances','decisions','history']);
 if (select count(*) from pg_catalog.jsonb_object_keys(recon))<>8 or recon->>'protocol' is distinct from 'ventard.web.resolution.1' or pg_catalog.length(pg_catalog.btrim(recon->>'reason')) not between 10 and 500 or recon->>'reason' is null or recon->'basis'->'context' is distinct from c or recon->'basis'->>'protocol' is distinct from 'ventard.web.resolution.basis.1' or v->'legacyCashHistoryConfirmed' is distinct from 'true'::jsonb then raise exception 'RESOLUTION_INVALID';end if;
 if pg_catalog.jsonb_typeof(recon->'rows') is distinct from 'array' or pg_catalog.jsonb_typeof(recon->'stockCounts') is distinct from 'array' or pg_catalog.jsonb_typeof(recon->'debtBalances') is distinct from 'array' or pg_catalog.jsonb_typeof(recon->'decisions') is distinct from 'array' then raise exception 'RESOLUTION_INVALID';end if;
 if recon->'history'->>'protocol' is distinct from 'ventard.web.resolution.history.1' or pg_catalog.jsonb_array_length(recon->'history'->'tables')<>15 or pg_catalog.jsonb_typeof(recon->'history'->'tickets') is distinct from 'array' then raise exception 'RESOLUTION_HISTORY_INVALID';end if;
 for t in select value from pg_catalog.jsonb_array_elements(recon->'history'->'tables') loop
  for r in select value from pg_catalog.jsonb_array_elements(t->'rows') loop if r->>'negocio_id' is distinct from n::text then raise exception 'RESOLUTION_SCOPE';end if;end loop;
 end loop;
 foreach table_name in array array['apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','inventario_sucursales','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas'] loop execute pg_catalog.format('lock table public.%I in share row exclusive mode',table_name);end loop;
 if exists(select 1 from pg_catalog.pg_trigger tr join pg_catalog.pg_class cl on cl.oid=tr.tgrelid join pg_catalog.pg_namespace ns on ns.oid=cl.relnamespace join pg_catalog.pg_proc fn on fn.oid=tr.tgfoid where ns.nspname='public' and cl.relname in('apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','inventario_sucursales','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas') and not tr.tgisinternal and tr.tgenabled<>'D' and fn.proname not in('native_sales_fence_v1','normalizar_fecha_actualizacion')) then raise exception 'RESOLUTION_SCHEMA_INCOMPATIBLE';end if;
 capture:=public.native_web_capture_v1(n,i,d,e,k,b,(recon->'basis'->>'captureId')::uuid);stock_before:=public.native_web_resolution_stock_v1(n);
 if public.native_web_cutover_tables_v1(capture) is distinct from v->'tables' or recon->'basis'->'tables' is distinct from v->'tables' or recon->'basis'->>'stockHash' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(stock_before)) or recon->'basis'->'stockBase' is distinct from stock_before then raise exception 'RESOLUTION_SOURCE_CHANGED';end if;
 if pg_catalog.jsonb_array_length(recon->'rows')<>15 or (select count(distinct value->>'name') from pg_catalog.jsonb_array_elements(recon->'rows'))<>15 then raise exception 'RESOLUTION_INVALID';end if;
 for t in select value from pg_catalog.jsonb_array_elements(recon->'rows') loop
  table_name:=t->>'name';if table_name not in('apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas') or pg_catalog.jsonb_typeof(t->'rows') is distinct from 'array' or pg_catalog.jsonb_array_length(t->'rows')>200000 then raise exception 'RESOLUTION_INVALID';end if;
  if (select count(distinct x->>'id') from pg_catalog.jsonb_array_elements(t->'rows') x)<>pg_catalog.jsonb_array_length(t->'rows') then raise exception 'RESOLUTION_INVALID';end if;
  for r in select value from pg_catalog.jsonb_array_elements(t->'rows') loop
   if r->>'negocio_id' is distinct from n::text or r->>'id' is null then raise exception 'RESOLUTION_SCOPE';end if;
   if table_name in('apartados','cajas','cortes_caja','gastos','movimientos_stock','reparaciones','transacciones_fiado','venta_detalles','ventas') and (not (r ? 'sucursal_id') or r->>'sucursal_id' is distinct from b::text) then raise exception 'RESOLUTION_SCOPE';end if;
  end loop;
  all_rows:=all_rows||pg_catalog.jsonb_build_object(table_name,t->'rows');
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'devoluciones') loop
  if r ? 'sucursal_id' then if r->>'sucursal_id' is distinct from b::text then raise exception 'RESOLUTION_SCOPE';end if;
  elsif not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'ventas') s where s->>'id'=r->>'venta_id' and s->>'sucursal_id' is not distinct from b::text) then raise exception 'RESOLUTION_SCOPE';end if;
 end loop;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n) on conflict do nothing;
 -- Never delete a source parent. Alternative sale children are retained in the
 -- immutable before capture; only their chosen document remains operational.
 foreach table_name in array array['venta_detalles','devoluciones','transacciones_fiado','movimientos_stock','gastos','cortes_caja','reparaciones','apartados','seriales','composiciones','ventas','cajas','clientes','productos','sucursales'] loop
  select value into t from pg_catalog.jsonb_array_elements(capture->'tables') where value->>'name'=table_name;
  select pg_catalog.array_agg(x->>'id') into missing_ids from pg_catalog.jsonb_array_elements(t->'rows') x where not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->table_name) y where y->>'id'=x->>'id');
  if coalesce(pg_catalog.cardinality(missing_ids),0)>0 then
   if table_name in('clientes','productos','seriales','composiciones','sucursales') then raise exception 'RESOLUTION_SOURCE_PARENT_MISSING';end if;
   if table_name not in('venta_detalles','transacciones_fiado','movimientos_stock') and exists(select 1 from pg_catalog.unnest(missing_ids) missing where not exists(select 1 from pg_catalog.jsonb_array_elements(recon->'decisions') x where x->>'table'=table_name and x->>'rowId'=missing and x->'archiveOnly'='true'::jsonb and pg_catalog.length(x->>'reason') between 10 and 500)) then raise exception 'RESOLUTION_SOURCE_PARENT_MISSING';end if;
   execute pg_catalog.format('delete from public.%I where negocio_id::text=$1 and id::text=any($2)',table_name) using n::text,missing_ids;
  end if;
 end loop;
 -- Scope and exact amounts are checked independently of the client report.
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'productos') loop
  decoded:=public.native_web_resolution_decode_v1(r);
  for item in select pg_catalog.to_jsonb(name) from pg_catalog.unnest(array['precio_venta','precio_2','precio_3','costo']) name loop
   if decoded->(item#>>'{}')<>'null'::jsonb and ((decoded->>(item#>>'{}'))::numeric<0 or (decoded->>(item#>>'{}'))::numeric*100<>pg_catalog.trunc((decoded->>(item#>>'{}'))::numeric*100)) then raise exception 'RESOLUTION_MONEY_INVALID';end if;
  end loop;
  if decoded->'tasa_itbis'<>'null'::jsonb and ((decoded->>'tasa_itbis')::numeric not between 0 and 1 or (decoded->>'tasa_itbis')::numeric*100<>pg_catalog.trunc((decoded->>'tasa_itbis')::numeric*100)) then raise exception 'RESOLUTION_MONEY_INVALID';end if;
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'ventas') loop
  decoded:=public.native_web_resolution_decode_v1(r);
  if (decoded->>'total')::numeric<0 or (decoded->>'total')::numeric*100<>pg_catalog.trunc((decoded->>'total')::numeric*100) or decoded->>'total' is null or decoded->>'metodo_pago' is null or decoded->>'metodo_pago' not in('efectivo','tarjeta','transferencia','mixto','fiado') then raise exception 'RESOLUTION_MONEY_INVALID';end if;
  if decoded->>'metodo_pago'='mixto' and ((decoded->>'monto_efectivo')::numeric<=0 or (decoded->>'monto_transferencia')::numeric<=0 or (decoded->>'monto_efectivo')::numeric+(decoded->>'monto_transferencia')::numeric is distinct from (decoded->>'total')::numeric) then raise exception 'RESOLUTION_MONEY_INVALID';end if;
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'venta_detalles') loop
  decoded:=public.native_web_resolution_decode_v1(r);
  if not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'ventas') s where s->>'id'=r->>'venta_id') or decoded->>'cantidad' is null or decoded->>'precio_unitario' is null or decoded->>'subtotal' is null or (decoded->>'cantidad')::numeric<=0 or (decoded->>'precio_unitario')::numeric<0 or (decoded->>'precio_unitario')::numeric*100<>pg_catalog.trunc((decoded->>'precio_unitario')::numeric*100) or (decoded->>'subtotal')::numeric*100<>pg_catalog.trunc((decoded->>'subtotal')::numeric*100) or (decoded->>'subtotal')::numeric is distinct from (decoded->>'cantidad')::numeric*(decoded->>'precio_unitario')::numeric then raise exception 'RESOLUTION_MONEY_INVALID';end if;
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'transacciones_fiado') loop
  decoded:=public.native_web_resolution_decode_v1(r);
  if decoded->>'tipo' not in('cargo','abono') or decoded->>'tipo' is null or decoded->>'monto' is null or (decoded->>'monto')::numeric<0 or (decoded->>'monto')::numeric*100<>pg_catalog.trunc((decoded->>'monto')::numeric*100) or not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'clientes') c0 where c0->>'id'=r->>'cliente_id') then raise exception 'RESOLUTION_MONEY_INVALID';end if;
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'cajas') loop if r->>'estado' is distinct from 'cerrada' then raise exception 'CUTOVER_CLOSE_WEB_CASH';end if;end loop;
 for t in select value from pg_catalog.jsonb_array_elements(capture->'tables') where value->>'name'='cajas' loop for r in select value from pg_catalog.jsonb_array_elements(t->'rows') loop if r->>'estado' is distinct from 'cerrada' then raise exception 'CUTOVER_CLOSE_WEB_CASH';end if;end loop;end loop;
 -- A prior QA adoption with no native operation may be replaced, but journals,
 -- registrations, licenses, NCF cursors and identities are never reset.
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n) on conflict do nothing;
 foreach table_name in array array['sucursales','productos','clientes','composiciones','cajas','ventas','venta_detalles','transacciones_fiado','seriales','reparaciones','apartados','gastos','cortes_caja','devoluciones','movimientos_stock'] loop
  for r in select value from pg_catalog.jsonb_array_elements(all_rows->table_name) loop perform public.native_web_resolution_upsert_v1(table_name,r,n,k,b);end loop;
 end loop;
 if pg_catalog.jsonb_array_length(recon->'stockCounts')<>(select count(*) from pg_catalog.jsonb_array_elements(all_rows->'productos') p where p->>'tipo' is distinct from 'combo') or (select count(distinct x->>'productId') from pg_catalog.jsonb_array_elements(recon->'stockCounts') x)<>pg_catalog.jsonb_array_length(recon->'stockCounts') then raise exception 'RESOLUTION_STOCK_COVERAGE';end if;
 for item in select value from pg_catalog.jsonb_array_elements(recon->'stockCounts') loop
  pid:=(item->>'productId')::uuid;quantity:=public.native_sales_int_v1(item->'quantity',2147483647)::bigint;
  if not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'productos') p where p->>'id'=pid::text and p->>'tipo' is distinct from 'combo') then raise exception 'RESOLUTION_STOCK_COVERAGE';end if;
  if k='BRANCH' then
   if exists(select 1 from public.inventario_sucursales s where s.producto_id=pid and s.sucursal_id<>b and s.stock_actual is null) then raise exception 'RESOLUTION_OTHER_BRANCH_STOCK_UNKNOWN';end if;
   insert into public.inventario_sucursales(sucursal_id,producto_id,stock_actual) values(b,pid,quantity::integer) on conflict(sucursal_id,producto_id) do update set stock_actual=excluded.stock_actual;
   update public.productos set stock_actual=(select sum(s.stock_actual) from public.inventario_sucursales s where s.producto_id=pid)::integer where id=pid and negocio_id=n;
  else update public.productos set stock_actual=quantity::integer where id=pid and negocio_id=n;end if;
 end loop;
 if pg_catalog.jsonb_array_length(recon->'debtBalances')<>pg_catalog.jsonb_array_length(all_rows->'clientes') or (select count(distinct x->>'customerId') from pg_catalog.jsonb_array_elements(recon->'debtBalances') x)<>pg_catalog.jsonb_array_length(recon->'debtBalances') then raise exception 'RESOLUTION_DEBT_COVERAGE';end if;
 delete from public.native_sales_mode_v1 where negocio_id=n;delete from public.native_sales_stock_v1 where negocio_id=n;delete from public.native_sales_credit_v1 where negocio_id=n;
 delete from public.native_legacy_services_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b;
 perform public.native_legacy_services_adopt_v1(pg_catalog.jsonb_build_object('tables',recon->'rows'),c,op,(v->'serviceReservationsConfirmed'='true'::jsonb));
 perform public.native_sales_activate_v1(n,i,d,e,k,b,'PRODUCTION_CLOUD_BASELINE_REVIEWED',v->>'freeTax');
 for item in select value from pg_catalog.jsonb_array_elements(recon->'debtBalances') loop
  cid:=(item->>'customerId')::uuid;balance:=public.native_sales_int_v1(item->'balanceCents')::bigint;
  if not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'clientes') c0 where c0->>'id'=cid::text) then raise exception 'RESOLUTION_DEBT_COVERAGE';end if;
  update public.native_sales_credit_v1 set balance_cents=balance where negocio_id=n and cliente_id=cid;
 end loop;
 validation_snapshot:=public.native_sales_effect_id_v1(op,'resolution-validation');
 if exists(select 1 from public.native_sales_snapshots_v1 where negocio_id=n and snapshot_id=validation_snapshot) then raise exception 'CUTOVER_ID_CONFLICT';end if;
 manifest:=public.native_sales_bootstrap_v1(n,i,d,e,k,b,validation_snapshot);
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.web.cutover.receipt.1','status','BASELINE_ADOPTED','cutoverId',op,'planHash',p_hash,'context',c,'runId',v->'runId','revision',v->'revision','backupId',v->'backupId','coverage','RECONCILED_SELECTED_BASELINE','legacyReplay',false);
 insert into public.native_web_resolutions_v1 values(n,op,capture,stock_before,recon->'rows',answer,recon->'history',public.native_sales_hash_v1(public.native_sales_canonical_v1(recon->'history')));
 insert into public.native_web_cutovers_v1(negocio_id,cutover_id,intent,intent_hash,receipt,actor_id) values(n,op,p_intent,p_hash,answer,auth.uid());
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;
 return answer;
end $f$;
create or replace function public.native_web_resolution_history_v1(p_context jsonb,p_cutover_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare c jsonb:=p_context;n uuid:=(c->>'tenantId')::uuid;r text;x public.native_web_resolutions_v1%rowtype;
begin
 if (c->>'actorId')::uuid is distinct from auth.uid() then raise exception 'CUTOVER_CONTEXT';end if;
 r:=public.native_sales_context_v1(n,(c->>'installationId')::uuid,(c->>'deviceId')::uuid,(c->>'writerEpoch')::bigint,c->>'scopeType',(c->>'branchId')::uuid);
 if r not in('owner','admin') then raise exception using errcode='42501',message='CUTOVER_DENIED';end if;
 select * into x from public.native_web_resolutions_v1 where negocio_id=n and cutover_id=p_cutover_id and receipt->'context'->>'scopeType'=c->>'scopeType' and receipt->'context'->>'branchId' is not distinct from c->>'branchId';
 if not found then raise exception 'RESOLUTION_HISTORY_REQUIRED';end if;
 return pg_catalog.jsonb_build_object('protocol','ventard.web.resolution.history.envelope.1','context',c,'history',x.history,'historyHash',x.history_hash,'receipt',x.receipt);
end $f$;
do $bootstrap$ begin
 if pg_catalog.to_regprocedure('public.native_sales_bootstrap_resolution_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid)') is null then alter function public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) rename to native_sales_bootstrap_resolution_base_v1;end if;
end $bootstrap$;
create or replace function public.native_sales_bootstrap_v1(p_negocio_id uuid,p_installation_id uuid,p_device_id uuid,p_writer_epoch bigint,p_scope_kind text,p_sucursal_id uuid,p_snapshot_id uuid) returns jsonb language plpgsql security definer set search_path='' as $f$
declare m jsonb;x public.native_web_resolutions_v1%rowtype;old boolean;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||p_negocio_id::text,0));
 select exists(select 1 from public.native_sales_snapshots_v1 where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id) into old;
 m:=public.native_sales_bootstrap_resolution_base_v1(p_negocio_id,p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,p_snapshot_id);
 if old or public.native_member_role_v1(p_negocio_id) not in('owner','admin') then return m;end if;
 select r.* into x from public.native_web_resolutions_v1 r join public.native_web_cutovers_v1 c on c.negocio_id=r.negocio_id and c.cutover_id=r.cutover_id where r.negocio_id=p_negocio_id and r.receipt->'context'->>'scopeType'=p_scope_kind and r.receipt->'context'->>'branchId' is not distinct from p_sucursal_id::text order by c.created_at desc,c.cutover_id desc limit 1;
 if found then m:=m||pg_catalog.jsonb_build_object('legacyResolutionHistory',pg_catalog.jsonb_build_object('cutoverId',x.cutover_id,'sha256',x.history_hash));update public.native_sales_snapshots_v1 set manifest=m where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;end if;
 return m;
end $f$;
revoke all on function public.native_web_resolution_stock_v1(uuid),public.native_web_resolution_decode_v1(jsonb,integer),public.native_web_resolution_upsert_v1(text,jsonb,uuid,text,uuid),public.native_web_cutover_resolution_base_v1(text,text),public.native_web_resolution_basis_v1(jsonb,uuid),public.native_web_cutover_v1(text,text) from public,anon,authenticated;
grant execute on function public.native_web_resolution_basis_v1(jsonb,uuid),public.native_web_cutover_v1(text,text) to authenticated;
revoke all on function public.native_web_resolution_history_v1(jsonb,uuid),public.native_sales_bootstrap_resolution_base_v1(uuid,uuid,uuid,bigint,text,uuid,uuid),public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.native_web_resolution_history_v1(jsonb,uuid),public.native_sales_bootstrap_v1(uuid,uuid,uuid,bigint,text,uuid,uuid) to authenticated;
revoke all on function public.native_web_resolution_transport_v1(jsonb,uuid,text,integer),public.native_web_resolution_assembled_v1(jsonb,uuid,text,integer,uuid),public.native_web_resolution_finish_v1(jsonb,uuid,text,integer,boolean),public.native_web_resolution_stage_v1(jsonb,uuid,text,integer,integer,text,text),public.native_web_resolution_commit_v1(jsonb,uuid,text,integer),public.native_web_resolution_abandon_v1(jsonb,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.native_web_resolution_stage_v1(jsonb,uuid,text,integer,integer,text,text),public.native_web_resolution_commit_v1(jsonb,uuid,text,integer),public.native_web_resolution_abandon_v1(jsonb,uuid,text,integer) to authenticated;

-- Source: 20261016015201_native_resolution_stock_timestamp_staging_v1.sql SHA256 1e76ac32c67c60bd3ad6d1f4dc8454c13853d4548ece791bc0573054139a919a
-- Fix required branch-stock timestamps during reviewed initial cutover. No data changes at deployment.
-- selected historical documents before the first native financial operation.
-- Original captures/intentions remain evidence; no historical APPLIED receipt.

do $guard$ begin

end $guard$;
create or replace function public.native_web_cutover_v1(p_intent text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;recon jsonb;c jsonb;n uuid;i uuid;d uuid;b uuid;e bigint;k text;op uuid;role_name text;old public.native_web_cutovers_v1%rowtype;
 capture jsonb;stock_before jsonb;t jsonb;r jsonb;decoded jsonb;table_name text;all_rows jsonb:='{}';body jsonb;missing_ids text[];
 item jsonb;pid uuid;cid uuid;quantity bigint;balance bigint;count_n integer;answer jsonb;validation_snapshot uuid;manifest jsonb;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>33554432 then raise exception 'RESOLUTION_TOO_LARGE';end if;
 v:=p_intent::jsonb;
 if not (v ? 'reconciliation') then return public.native_web_cutover_resolution_base_v1(p_intent,p_hash);end if;
 if p_hash is null or public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent)<>p_hash or v->>'protocol' is distinct from 'ventard.web.cutover.1' or v->>'confirmation' is distinct from 'WEB_WRITERS_CLOSED_BALANCES_REVIEWED' then raise exception 'RESOLUTION_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','cutoverId','runId','revision','context','backupId','backupHash','runHash','confirmation','freeTax','sources','tables','reconciliation']);
 if (select count(*) from pg_catalog.jsonb_object_keys(v))<>(13+case when v ? 'serviceReservationsConfirmed' then 1 else 0 end+case when v ? 'legacyCashHistoryConfirmed' then 1 else 0 end) or v->>'freeTax' not in('0','0.18') or v->>'backupHash'!~'^[0-9a-f]{64}$' or v->>'runHash'!~'^[0-9a-f]{64}$' or pg_catalog.jsonb_typeof(v->'revision') is distinct from 'number' then raise exception 'RESOLUTION_INVALID';end if;
 perform (v->>'runId')::uuid;perform (v->>'backupId')::uuid;
 c:=v->'context';n:=(c->>'tenantId')::uuid;i:=(c->>'installationId')::uuid;d:=(c->>'deviceId')::uuid;b:=(c->>'branchId')::uuid;e:=(c->>'writerEpoch')::bigint;k:=c->>'scopeType';op:=(v->>'cutoverId')::uuid;
 if n is null or n not in('864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid,'864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid) or op is null or (c->>'actorId')::uuid is distinct from auth.uid() then raise exception 'CUTOVER_CONTEXT';end if;
 role_name:=public.native_sales_context_v1(n,i,d,e,k,b);if role_name not in('owner','admin') then raise exception using errcode='42501',message='CUTOVER_DENIED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_web_cutovers_v1 where negocio_id=n and cutover_id=op;
 if found then if old.intent<>p_intent or old.intent_hash<>p_hash then raise exception 'CUTOVER_ID_CONFLICT';end if;return old.receipt;end if;
 -- Import is a pre-operation handover, never a rewrite of native trade history.
 if exists(select 1 from public.native_sales_ledger_v1 where negocio_id=n) or exists(select 1 from public.native_sales_turns_v1 where negocio_id=n) then raise exception 'RESOLUTION_NATIVE_ALREADY_STARTED';end if;
 if exists(select 1 from public.native_sales_mode_v1 where negocio_id=n) and exists(select 1 from public.native_installations_v1 where negocio_id=n and installation_id<>i and status='REGISTERED') then raise exception 'RESOLUTION_OTHER_WRITERS_ACTIVE';end if;
 recon:=v->'reconciliation';
 perform public.native_sales_object_v1(recon,array['protocol','reason','basis','rows','stockCounts','debtBalances','decisions','history']);
 if (select count(*) from pg_catalog.jsonb_object_keys(recon))<>8 or recon->>'protocol' is distinct from 'ventard.web.resolution.1' or pg_catalog.length(pg_catalog.btrim(recon->>'reason')) not between 10 and 500 or recon->>'reason' is null or recon->'basis'->'context' is distinct from c or recon->'basis'->>'protocol' is distinct from 'ventard.web.resolution.basis.1' or v->'legacyCashHistoryConfirmed' is distinct from 'true'::jsonb then raise exception 'RESOLUTION_INVALID';end if;
 if pg_catalog.jsonb_typeof(recon->'rows') is distinct from 'array' or pg_catalog.jsonb_typeof(recon->'stockCounts') is distinct from 'array' or pg_catalog.jsonb_typeof(recon->'debtBalances') is distinct from 'array' or pg_catalog.jsonb_typeof(recon->'decisions') is distinct from 'array' then raise exception 'RESOLUTION_INVALID';end if;
 if recon->'history'->>'protocol' is distinct from 'ventard.web.resolution.history.1' or pg_catalog.jsonb_array_length(recon->'history'->'tables')<>15 or pg_catalog.jsonb_typeof(recon->'history'->'tickets') is distinct from 'array' then raise exception 'RESOLUTION_HISTORY_INVALID';end if;
 for t in select value from pg_catalog.jsonb_array_elements(recon->'history'->'tables') loop
  for r in select value from pg_catalog.jsonb_array_elements(t->'rows') loop if r->>'negocio_id' is distinct from n::text then raise exception 'RESOLUTION_SCOPE';end if;end loop;
 end loop;
 foreach table_name in array array['apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','inventario_sucursales','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas'] loop execute pg_catalog.format('lock table public.%I in share row exclusive mode',table_name);end loop;
 if exists(select 1 from pg_catalog.pg_trigger tr join pg_catalog.pg_class cl on cl.oid=tr.tgrelid join pg_catalog.pg_namespace ns on ns.oid=cl.relnamespace join pg_catalog.pg_proc fn on fn.oid=tr.tgfoid where ns.nspname='public' and cl.relname in('apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','inventario_sucursales','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas') and not tr.tgisinternal and tr.tgenabled<>'D' and fn.proname not in('native_sales_fence_v1','normalizar_fecha_actualizacion')) then raise exception 'RESOLUTION_SCHEMA_INCOMPATIBLE';end if;
 capture:=public.native_web_capture_v1(n,i,d,e,k,b,(recon->'basis'->>'captureId')::uuid);stock_before:=public.native_web_resolution_stock_v1(n);
 if public.native_web_cutover_tables_v1(capture) is distinct from v->'tables' or recon->'basis'->'tables' is distinct from v->'tables' or recon->'basis'->>'stockHash' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(stock_before)) or recon->'basis'->'stockBase' is distinct from stock_before then raise exception 'RESOLUTION_SOURCE_CHANGED';end if;
 if pg_catalog.jsonb_array_length(recon->'rows')<>15 or (select count(distinct value->>'name') from pg_catalog.jsonb_array_elements(recon->'rows'))<>15 then raise exception 'RESOLUTION_INVALID';end if;
 for t in select value from pg_catalog.jsonb_array_elements(recon->'rows') loop
  table_name:=t->>'name';if table_name not in('apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas') or pg_catalog.jsonb_typeof(t->'rows') is distinct from 'array' or pg_catalog.jsonb_array_length(t->'rows')>200000 then raise exception 'RESOLUTION_INVALID';end if;
  if (select count(distinct x->>'id') from pg_catalog.jsonb_array_elements(t->'rows') x)<>pg_catalog.jsonb_array_length(t->'rows') then raise exception 'RESOLUTION_INVALID';end if;
  for r in select value from pg_catalog.jsonb_array_elements(t->'rows') loop
   if r->>'negocio_id' is distinct from n::text or r->>'id' is null then raise exception 'RESOLUTION_SCOPE';end if;
   if table_name in('apartados','cajas','cortes_caja','gastos','movimientos_stock','reparaciones','transacciones_fiado','venta_detalles','ventas') and (not (r ? 'sucursal_id') or r->>'sucursal_id' is distinct from b::text) then raise exception 'RESOLUTION_SCOPE';end if;
  end loop;
  all_rows:=all_rows||pg_catalog.jsonb_build_object(table_name,t->'rows');
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'devoluciones') loop
  if r ? 'sucursal_id' then if r->>'sucursal_id' is distinct from b::text then raise exception 'RESOLUTION_SCOPE';end if;
  elsif not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'ventas') s where s->>'id'=r->>'venta_id' and s->>'sucursal_id' is not distinct from b::text) then raise exception 'RESOLUTION_SCOPE';end if;
 end loop;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n) on conflict do nothing;
 -- Never delete a source parent. Alternative sale children are retained in the
 -- immutable before capture; only their chosen document remains operational.
 foreach table_name in array array['venta_detalles','devoluciones','transacciones_fiado','movimientos_stock','gastos','cortes_caja','reparaciones','apartados','seriales','composiciones','ventas','cajas','clientes','productos','sucursales'] loop
  select value into t from pg_catalog.jsonb_array_elements(capture->'tables') where value->>'name'=table_name;
  select pg_catalog.array_agg(x->>'id') into missing_ids from pg_catalog.jsonb_array_elements(t->'rows') x where not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->table_name) y where y->>'id'=x->>'id');
  if coalesce(pg_catalog.cardinality(missing_ids),0)>0 then
   if table_name in('clientes','productos','seriales','composiciones','sucursales') then raise exception 'RESOLUTION_SOURCE_PARENT_MISSING';end if;
   if table_name not in('venta_detalles','transacciones_fiado','movimientos_stock') and exists(select 1 from pg_catalog.unnest(missing_ids) missing where not exists(select 1 from pg_catalog.jsonb_array_elements(recon->'decisions') x where x->>'table'=table_name and x->>'rowId'=missing and x->'archiveOnly'='true'::jsonb and pg_catalog.length(x->>'reason') between 10 and 500)) then raise exception 'RESOLUTION_SOURCE_PARENT_MISSING';end if;
   execute pg_catalog.format('delete from public.%I where negocio_id::text=$1 and id::text=any($2)',table_name) using n::text,missing_ids;
  end if;
 end loop;
 -- Scope and exact amounts are checked independently of the client report.
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'productos') loop
  decoded:=public.native_web_resolution_decode_v1(r);
  for item in select pg_catalog.to_jsonb(name) from pg_catalog.unnest(array['precio_venta','precio_2','precio_3','costo']) name loop
   if decoded->(item#>>'{}')<>'null'::jsonb and ((decoded->>(item#>>'{}'))::numeric<0 or (decoded->>(item#>>'{}'))::numeric*100<>pg_catalog.trunc((decoded->>(item#>>'{}'))::numeric*100)) then raise exception 'RESOLUTION_MONEY_INVALID';end if;
  end loop;
  if decoded->'tasa_itbis'<>'null'::jsonb and ((decoded->>'tasa_itbis')::numeric not between 0 and 1 or (decoded->>'tasa_itbis')::numeric*100<>pg_catalog.trunc((decoded->>'tasa_itbis')::numeric*100)) then raise exception 'RESOLUTION_MONEY_INVALID';end if;
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'ventas') loop
  decoded:=public.native_web_resolution_decode_v1(r);
  if (decoded->>'total')::numeric<0 or (decoded->>'total')::numeric*100<>pg_catalog.trunc((decoded->>'total')::numeric*100) or decoded->>'total' is null or decoded->>'metodo_pago' is null or decoded->>'metodo_pago' not in('efectivo','tarjeta','transferencia','mixto','fiado') then raise exception 'RESOLUTION_MONEY_INVALID';end if;
  if decoded->>'metodo_pago'='mixto' and ((decoded->>'monto_efectivo')::numeric<=0 or (decoded->>'monto_transferencia')::numeric<=0 or (decoded->>'monto_efectivo')::numeric+(decoded->>'monto_transferencia')::numeric is distinct from (decoded->>'total')::numeric) then raise exception 'RESOLUTION_MONEY_INVALID';end if;
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'venta_detalles') loop
  decoded:=public.native_web_resolution_decode_v1(r);
  if not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'ventas') s where s->>'id'=r->>'venta_id') or decoded->>'cantidad' is null or decoded->>'precio_unitario' is null or decoded->>'subtotal' is null or (decoded->>'cantidad')::numeric<=0 or (decoded->>'precio_unitario')::numeric<0 or (decoded->>'precio_unitario')::numeric*100<>pg_catalog.trunc((decoded->>'precio_unitario')::numeric*100) or (decoded->>'subtotal')::numeric*100<>pg_catalog.trunc((decoded->>'subtotal')::numeric*100) or (decoded->>'subtotal')::numeric is distinct from (decoded->>'cantidad')::numeric*(decoded->>'precio_unitario')::numeric then raise exception 'RESOLUTION_MONEY_INVALID';end if;
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'transacciones_fiado') loop
  decoded:=public.native_web_resolution_decode_v1(r);
  if decoded->>'tipo' not in('cargo','abono') or decoded->>'tipo' is null or decoded->>'monto' is null or (decoded->>'monto')::numeric<0 or (decoded->>'monto')::numeric*100<>pg_catalog.trunc((decoded->>'monto')::numeric*100) or not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'clientes') c0 where c0->>'id'=r->>'cliente_id') then raise exception 'RESOLUTION_MONEY_INVALID';end if;
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'cajas') loop if r->>'estado' is distinct from 'cerrada' then raise exception 'CUTOVER_CLOSE_WEB_CASH';end if;end loop;
 for t in select value from pg_catalog.jsonb_array_elements(capture->'tables') where value->>'name'='cajas' loop for r in select value from pg_catalog.jsonb_array_elements(t->'rows') loop if r->>'estado' is distinct from 'cerrada' then raise exception 'CUTOVER_CLOSE_WEB_CASH';end if;end loop;end loop;
 -- A prior QA adoption with no native operation may be replaced, but journals,
 -- registrations, licenses, NCF cursors and identities are never reset.
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n) on conflict do nothing;
 foreach table_name in array array['sucursales','productos','clientes','composiciones','cajas','ventas','venta_detalles','transacciones_fiado','seriales','reparaciones','apartados','gastos','cortes_caja','devoluciones','movimientos_stock'] loop
  for r in select value from pg_catalog.jsonb_array_elements(all_rows->table_name) loop perform public.native_web_resolution_upsert_v1(table_name,r,n,k,b);end loop;
 end loop;
 if pg_catalog.jsonb_array_length(recon->'stockCounts')<>(select count(*) from pg_catalog.jsonb_array_elements(all_rows->'productos') p where p->>'tipo' is distinct from 'combo') or (select count(distinct x->>'productId') from pg_catalog.jsonb_array_elements(recon->'stockCounts') x)<>pg_catalog.jsonb_array_length(recon->'stockCounts') then raise exception 'RESOLUTION_STOCK_COVERAGE';end if;
 for item in select value from pg_catalog.jsonb_array_elements(recon->'stockCounts') loop
  pid:=(item->>'productId')::uuid;quantity:=public.native_sales_int_v1(item->'quantity',2147483647)::bigint;
  if not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'productos') p where p->>'id'=pid::text and p->>'tipo' is distinct from 'combo') then raise exception 'RESOLUTION_STOCK_COVERAGE';end if;
  if k='BRANCH' then
   if exists(select 1 from public.inventario_sucursales s where s.producto_id=pid and s.sucursal_id<>b and s.stock_actual is null) then raise exception 'RESOLUTION_OTHER_BRANCH_STOCK_UNKNOWN';end if;
   insert into public.inventario_sucursales(sucursal_id,producto_id,stock_actual,fecha_actualizacion) values(b,pid,quantity::integer,(extract(epoch from pg_catalog.transaction_timestamp())*1000)::bigint) on conflict(sucursal_id,producto_id) do update set stock_actual=excluded.stock_actual,fecha_actualizacion=excluded.fecha_actualizacion;
   update public.productos set stock_actual=(select sum(s.stock_actual) from public.inventario_sucursales s where s.producto_id=pid)::integer where id=pid and negocio_id=n;
  else update public.productos set stock_actual=quantity::integer where id=pid and negocio_id=n;end if;
 end loop;
 if pg_catalog.jsonb_array_length(recon->'debtBalances')<>pg_catalog.jsonb_array_length(all_rows->'clientes') or (select count(distinct x->>'customerId') from pg_catalog.jsonb_array_elements(recon->'debtBalances') x)<>pg_catalog.jsonb_array_length(recon->'debtBalances') then raise exception 'RESOLUTION_DEBT_COVERAGE';end if;
 delete from public.native_sales_mode_v1 where negocio_id=n;delete from public.native_sales_stock_v1 where negocio_id=n;delete from public.native_sales_credit_v1 where negocio_id=n;
 delete from public.native_legacy_services_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b;
 perform public.native_legacy_services_adopt_v1(pg_catalog.jsonb_build_object('tables',recon->'rows'),c,op,(v->'serviceReservationsConfirmed'='true'::jsonb));
 perform public.native_sales_activate_v1(n,i,d,e,k,b,'PRODUCTION_CLOUD_BASELINE_REVIEWED',v->>'freeTax');
 for item in select value from pg_catalog.jsonb_array_elements(recon->'debtBalances') loop
  cid:=(item->>'customerId')::uuid;balance:=public.native_sales_int_v1(item->'balanceCents')::bigint;
  if not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'clientes') c0 where c0->>'id'=cid::text) then raise exception 'RESOLUTION_DEBT_COVERAGE';end if;
  update public.native_sales_credit_v1 set balance_cents=balance where negocio_id=n and cliente_id=cid;
 end loop;
 validation_snapshot:=public.native_sales_effect_id_v1(op,'resolution-validation');
 if exists(select 1 from public.native_sales_snapshots_v1 where negocio_id=n and snapshot_id=validation_snapshot) then raise exception 'CUTOVER_ID_CONFLICT';end if;
 manifest:=public.native_sales_bootstrap_v1(n,i,d,e,k,b,validation_snapshot);
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.web.cutover.receipt.1','status','BASELINE_ADOPTED','cutoverId',op,'planHash',p_hash,'context',c,'runId',v->'runId','revision',v->'revision','backupId',v->'backupId','coverage','RECONCILED_SELECTED_BASELINE','legacyReplay',false);
 insert into public.native_web_resolutions_v1 values(n,op,capture,stock_before,recon->'rows',answer,recon->'history',public.native_sales_hash_v1(public.native_sales_canonical_v1(recon->'history')));
 insert into public.native_web_cutovers_v1(negocio_id,cutover_id,intent,intent_hash,receipt,actor_id) values(n,op,p_intent,p_hash,answer,auth.uid());
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;
 return answer;
end $f$;
revoke all on function public.native_web_cutover_v1(text,text) from public,anon;
grant execute on function public.native_web_cutover_v1(text,text) to authenticated;

-- Source: 20261016165440_native_web_shared_journal_staging_v1.sql SHA256 e17a3af39ec45560f571a53d01f5b0a5521e310bddf85203dfa9f6af1b2591cf
do $guard$ begin

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
 if role_name not in('owner','admin') or not exists(select 1 from public.native_entitlements_v1 where negocio_id=(p_context->>'tenantId')::uuid and plan_tier='pro') then raise exception using errcode='42501',message='NATIVE_PRO_REQUIRED';end if;
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
-- Restore production authorization after source-compatible role extensions.
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




-- No native fiscal operation may run in this pilot. Existing legacy NCF intact.
create or replace function public.native_sales_fiscal_allocate_v1(p_request jsonb,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $no_fiscal$
begin raise exception using errcode='42501',message='NATIVE_FISCAL_DISABLED';end $no_fiscal$;
revoke all on function public.native_sales_fiscal_allocate_v1(jsonb,text) from public,anon,authenticated;
-- Copy the final shared-journal implementation, keeping its exact body/ACL.
do $copy_submit$ declare definition text;begin
 definition:=pg_catalog.pg_get_functiondef('public.native_sales_submit_v1(text,text,text,text)'::regprocedure);
 if pg_catalog.strpos(definition,'native_production_submit_base_v1')>0 then raise exception 'NATIVE_PRODUCTION_SUBMIT_SOURCE_INVALID';end if;
 execute pg_catalog.replace(definition,'FUNCTION public.native_sales_submit_v1(', 'FUNCTION public.native_production_submit_base_v1(');
end $copy_submit$;
revoke all on function public.native_production_submit_base_v1(text,text,text,text) from public,anon,authenticated;
create or replace function public.native_sales_submit_v1(p_intent text,p_hash text,p_snapshot text,p_snapshot_hash text) returns jsonb language plpgsql security definer set search_path='' as $production_submit$
begin
 if coalesce(p_intent::jsonb->'payload'->'sale'->'fiscal','null'::jsonb)<>'null'::jsonb or coalesce(p_snapshot::jsonb->'ncf','null'::jsonb)<>'null'::jsonb then raise exception using errcode='42501',message='NATIVE_FISCAL_DISABLED';end if;
 return public.native_production_submit_base_v1(p_intent,p_hash,p_snapshot,p_snapshot_hash);
end $production_submit$;
revoke all on function public.native_sales_submit_v1(text,text,text,text) from public,anon;
grant execute on function public.native_sales_submit_v1(text,text,text,text) to authenticated;
-- Cloud activation is reachable only through the reviewed, recoverable cutover.
revoke all on function public.native_sales_activate_v1(uuid,uuid,uuid,bigint,text,uuid,text,text) from public,anon,authenticated;
commit;
