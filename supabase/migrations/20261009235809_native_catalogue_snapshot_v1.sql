-- STAGING ONLY blzzinivvzadqjbnpsre. Read-only commercial source; technical
-- snapshot writes only. NOT a convergence feed, saleable base or sync receipt.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001'::uuid and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002'::uuid and nombre='PRO00 QA B - SINTETICO'))<>2
 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
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
commit;
