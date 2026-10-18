-- Bulk migration processing only. The ordinary sales canonicalizer and API
-- limits remain unchanged. No activation, commercial data or fiscal writes.
begin;
do $dependency$ begin
 if pg_catalog.to_regprocedure('public.native_web_cutover_canonical_v1(jsonb,integer)') is null then raise exception 'RESOLUTION_BULK_PARENT_INCOMPATIBLE';end if;
end $dependency$;
-- Preserve complete legacy inventory rows whose product belongs to the
-- reviewed business but whose branch is absent or belongs to another one.
-- Only the Pica selected cutover can move these invalid associations; their
-- quantities are never added to the reviewed Principal count or replayed.
create table if not exists public.native_web_legacy_branch_stock_v1(
 negocio_id uuid not null,cutover_id uuid not null,sucursal_id uuid not null,producto_id uuid not null,
 source_row jsonb not null,source_hash text not null,hash_algorithm text not null default 'SHA256_JSONB_TEXT_V1',
 reason text not null,archived_at timestamptz not null default now(),
 primary key(negocio_id,cutover_id,sucursal_id,producto_id)
);
alter table public.native_web_legacy_branch_stock_v1 enable row level security;
revoke all on public.native_web_legacy_branch_stock_v1 from public,anon,authenticated;
create table if not exists public.native_web_legacy_catalogue_rows_v1(
 negocio_id uuid not null,cutover_id uuid not null,table_name text not null check(table_name='seriales'),row_id text not null,
 source_row jsonb not null,source_hash text not null,hash_algorithm text not null default 'SHA256_JSONB_TEXT_V1',
 reason text not null,archived_at timestamptz not null default now(),primary key(negocio_id,cutover_id,table_name,row_id)
);
alter table public.native_web_legacy_catalogue_rows_v1 enable row level security;
revoke all on public.native_web_legacy_catalogue_rows_v1 from public,anon,authenticated;
create or replace function public.native_web_resolution_canonical_v1(v jsonb,depth integer default 0)
returns text language plpgsql immutable set search_path='' as $f$
declare t text:=pg_catalog.jsonb_typeof(v);answer text;
begin
 if v is null then raise exception 'NATIVE_CANON_INVALID';end if;
 if depth>64 then raise exception 'NATIVE_CANON_DEPTH';end if;
 if t in('object','array') and depth=64 and v not in('{}'::jsonb,'[]'::jsonb) then raise exception 'NATIVE_CANON_DEPTH';end if;
 -- Tagged scalar fields dominate legacy history. Preserve their exact text
 -- without running two aggregate queries for each one-key object.
 if t='object' and v ? '$number' and v-'$number'='{}'::jsonb then
  return '{"$number":'||case when pg_catalog.jsonb_typeof(v->'$number')='string' then pg_catalog.to_json(v->>'$number')::text else public.native_sales_canonical_v1(v->'$number',depth+1) end||'}';
 elsif t='object' and v ? '$milliseconds' and v-'$milliseconds'='{}'::jsonb then
  return '{"$milliseconds":'||case when pg_catalog.jsonb_typeof(v->'$milliseconds')='string' then pg_catalog.to_json(v->>'$milliseconds')::text else public.native_sales_canonical_v1(v->'$milliseconds',depth+1) end||'}';
 end if;
 if t='object' then
  if exists(select 1 from pg_catalog.jsonb_object_keys(v) k where k~'[^\x00-\x7F]') then raise exception 'NATIVE_CANON_KEY';end if;
  select '{'||coalesce(pg_catalog.string_agg(pg_catalog.to_json(key)::text||':'||
   case pg_catalog.jsonb_typeof(value)
    when 'object' then public.native_web_resolution_canonical_v1(value,depth+1)
    when 'array' then public.native_web_resolution_canonical_v1(value,depth+1)
    when 'string' then pg_catalog.to_json(value#>>'{}')::text
    when 'number' then public.native_sales_canonical_v1(value,depth+1)
    else value::text end,',' order by key collate "C"),'')||'}' into answer from pg_catalog.jsonb_each(v);
  return answer;
 elsif t='array' then
  select '['||coalesce(pg_catalog.string_agg(
   case pg_catalog.jsonb_typeof(value)
    when 'object' then public.native_web_resolution_canonical_v1(value,depth+1)
    when 'array' then public.native_web_resolution_canonical_v1(value,depth+1)
    when 'string' then pg_catalog.to_json(value#>>'{}')::text
    when 'number' then public.native_sales_canonical_v1(value,depth+1)
    else value::text end,',' order by ordinal),'')||']' into answer from pg_catalog.jsonb_array_elements(v) with ordinality a(value,ordinal);
  return answer;
 else return public.native_sales_canonical_v1(v,depth);end if;
end $f$;
revoke all on function public.native_web_resolution_canonical_v1(jsonb,integer) from public,anon,authenticated;
create or replace function public.native_web_resolution_bulk_decode_v1(v jsonb,depth integer default 0)
returns jsonb language plpgsql immutable set search_path='' as $f$
declare t text:=pg_catalog.jsonb_typeof(v);answer jsonb;
begin
 if depth>64 then raise exception 'RESOLUTION_INVALID';end if;
 if t='object' and (v ? '$number' or v ? '$milliseconds') then
  if (select count(*) from pg_catalog.jsonb_object_keys(v))<>1 then raise exception 'RESOLUTION_INVALID';end if;
  return pg_catalog.to_jsonb(coalesce(v->>'$number',v->>'$milliseconds')::numeric);
 elsif t='object' then
  if depth=64 and v<>'{}'::jsonb then raise exception 'RESOLUTION_INVALID';end if;
  select coalesce(pg_catalog.jsonb_object_agg(key,case when pg_catalog.jsonb_typeof(value) in('object','array') then public.native_web_resolution_bulk_decode_v1(value,depth+1) else value end),'{}'::jsonb) into answer from pg_catalog.jsonb_each(v);return answer;
 elsif t='array' then
  if depth=64 and v<>'[]'::jsonb then raise exception 'RESOLUTION_INVALID';end if;
  select coalesce(pg_catalog.jsonb_agg(case when pg_catalog.jsonb_typeof(value) in('object','array') then public.native_web_resolution_bulk_decode_v1(value,depth+1) else value end order by ordinal),'[]'::jsonb) into answer from pg_catalog.jsonb_array_elements(v) with ordinality a(value,ordinal);return answer;
 else return v;end if;
end $f$;
revoke all on function public.native_web_resolution_bulk_decode_v1(jsonb,integer) from public,anon,authenticated;

do $bulk$
declare source text;original text;target regprocedure;needle text;apply_target regprocedure;
begin
 apply_target:=pg_catalog.to_regprocedure('public.native_web_cutover_validated_v1(text,text,boolean)');
 if apply_target is not null and pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.native_web_cutover_v1(text,text)'::regprocedure),'native_web_cutover_validated_v1')=0 then raise exception 'RESOLUTION_BULK_PARENT_INCOMPATIBLE';end if;
 apply_target:=coalesce(apply_target,'public.native_web_cutover_v1(text,text)'::regprocedure);
 foreach target in array array['public.native_web_resolution_assembled_v1(jsonb,uuid,text,integer,uuid)'::regprocedure,'public.native_web_cutover_abandon_v1(text,text)'::regprocedure,apply_target] loop
  source:=pg_catalog.pg_get_functiondef(target);original:=source;
  source:=pg_catalog.replace(source,'public.native_sales_canonical_v1(','public.native_web_resolution_canonical_v1(');
  if target=apply_target then source:=pg_catalog.replace(source,'decoded:=public.native_web_resolution_decode_v1(r);','decoded:=public.native_web_resolution_bulk_decode_v1(r);');end if;
  if target=apply_target and pg_catalog.strpos(source,'sale_index jsonb;')=0 then
   needle:='validation_snapshot uuid;manifest jsonb;';
   if pg_catalog.strpos(source,needle)=0 then raise exception 'RESOLUTION_BULK_PARENT_INCOMPATIBLE';end if;
   source:=pg_catalog.replace(source,needle,needle||'sale_index jsonb;selected_tables jsonb;');
   needle:='for r in select value from pg_catalog.jsonb_array_elements(all_rows->''devoluciones'') loop';
   if pg_catalog.strpos(source,needle)=0 then raise exception 'RESOLUTION_BULK_PARENT_INCOMPATIBLE';end if;
   source:=pg_catalog.replace(source,needle,'select coalesce(pg_catalog.jsonb_object_agg(x->>''id'',x->''sucursal_id''),''{}''::jsonb) into sale_index from pg_catalog.jsonb_array_elements(all_rows->''ventas'') x;'||chr(10)||needle);
   needle:='not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->''ventas'') s where s->>''id''=r->>''venta_id'' and s->>''sucursal_id'' is not distinct from b::text)';
   if pg_catalog.strpos(source,needle)=0 then raise exception 'RESOLUTION_BULK_PARENT_INCOMPATIBLE';end if;
   source:=pg_catalog.replace(source,needle,'sale_index->(r->>''venta_id'') is distinct from coalesce(pg_catalog.to_jsonb(b::text),''null''::jsonb)');
   needle:='not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->''ventas'') s where s->>''id''=r->>''venta_id'')';
   if pg_catalog.strpos(source,needle)=0 then raise exception 'RESOLUTION_BULK_PARENT_INCOMPATIBLE';end if;
   source:=pg_catalog.replace(source,needle,'not coalesce(sale_index ? (r->>''venta_id''),false)');
   needle:='-- Never delete a source parent. Alternative sale children are retained in the';
   if pg_catalog.strpos(source,needle)=0 then raise exception 'RESOLUTION_BULK_PARENT_INCOMPATIBLE';end if;
   source:=pg_catalog.replace(source,needle,$archive$
 -- Explicit Pica one-branch review: archive invalid branch associations before
 -- deriving the operational projection. No other business product is touched.
 if n='864d08e5-2975-4b2d-a1e2-ba5a14f3d677'::uuid then
  -- A series whose product no longer exists stays physically intact and in
  -- the full original history. It cannot become an available operative item.
  insert into public.native_web_legacy_catalogue_rows_v1(negocio_id,cutover_id,table_name,row_id,source_row,source_hash,reason)
  select n,op,'seriales',s.id::text,pg_catalog.to_jsonb(s),public.native_sales_hash_v1(pg_catalog.to_jsonb(s)::text),'MISSING_PRODUCT_HISTORY_ONLY'
  from public.seriales s where s.negocio_id=n and not exists(select 1 from public.productos p where p.id=s.producto_id and p.negocio_id=n);
  insert into public.native_web_legacy_branch_stock_v1(negocio_id,cutover_id,sucursal_id,producto_id,source_row,source_hash,reason)
  select n,op,z.sucursal_id,z.producto_id,pg_catalog.to_jsonb(z),public.native_sales_hash_v1(pg_catalog.to_jsonb(z)::text),'REVIEWED_PRINCIPAL_BASELINE_SUPERSEDES_INVALID_BRANCH_REFERENCE'
  from public.inventario_sucursales z join public.productos p on p.id=z.producto_id and p.negocio_id=n
  where not exists(select 1 from public.sucursales s where s.id=z.sucursal_id and s.negocio_id=n);
  delete from public.inventario_sucursales z using public.native_web_legacy_branch_stock_v1 a
  where a.negocio_id=n and a.cutover_id=op and a.sucursal_id=z.sucursal_id and a.producto_id=z.producto_id and a.source_row=pg_catalog.to_jsonb(z)
   and exists(select 1 from public.productos p where p.id=z.producto_id and p.negocio_id=n)
   and not exists(select 1 from public.sucursales s where s.id=z.sucursal_id and s.negocio_id=n);
 end if;
$archive$||needle);
   -- Unchanged rows are already protected by the complete source fingerprint,
   -- scope checks and table locks above. Avoid rewriting their original fields
   -- or invoking timestamp triggers; changed/new rows still use the same upsert.
   needle:='for r in select value from pg_catalog.jsonb_array_elements(all_rows->table_name) loop perform public.native_web_resolution_upsert_v1(table_name,r,n,k,b);end loop;';
   if pg_catalog.strpos(source,needle)=0 then raise exception 'RESOLUTION_BULK_PARENT_INCOMPATIBLE';end if;
   source:=pg_catalog.replace(source,needle,$rows$
  if selected_tables is null then selected_tables:=public.native_web_cutover_tables_v1(pg_catalog.jsonb_build_object('tables',recon->'rows'));end if;
  if (select x from pg_catalog.jsonb_array_elements(selected_tables) x where x->>'name'=table_name)=(select x from pg_catalog.jsonb_array_elements(v->'tables') x where x->>'name'=table_name) then continue;end if;
  for r in
   with prior as materialized (
    select x->>'id' row_id,public.native_web_cutover_canonical_v1(x) bytes
    from pg_catalog.jsonb_array_elements(coalesce((select captured_table->'rows' from pg_catalog.jsonb_array_elements(capture->'tables') captured_table where captured_table->>'name'=table_name),'[]'::jsonb)) x
   )
   select x from pg_catalog.jsonb_array_elements(all_rows->table_name) x left join prior p on p.row_id=x->>'id'
   where p.bytes is distinct from public.native_web_cutover_canonical_v1(x)
  loop perform public.native_web_resolution_upsert_v1(table_name,r,n,k,b);end loop;
$rows$);
  end if;
  if source<>original then execute source;end if;
 end loop;
end $bulk$;

-- The production ventas owner column is text; staging also supports UUID.
do $types$
declare source text;needle text:='s.negocio_id=n and s.sucursal_id is not distinct from b';
begin
 source:=pg_catalog.pg_get_functiondef('public.native_web_resolution_upsert_v1(text,jsonb,uuid,text,uuid)'::regprocedure);
 if pg_catalog.strpos(source,needle)>0 then execute pg_catalog.replace(source,needle,'s.negocio_id::text=n::text and s.sucursal_id is not distinct from b');
 elsif pg_catalog.strpos(source,'s.negocio_id::text=n::text and s.sucursal_id is not distinct from b')=0 then raise exception 'RESOLUTION_BULK_PARENT_INCOMPATIBLE';end if;
end $types$;

-- Project only reviewed orphan series as history-only. Unknown/changed rows
-- still fail closed. Reintroducing the actual product makes the original
-- series eligible for normal validation again; the physical row is untouched.
do $serial_projection$
declare fn record;source text;needle text:='from public.seriales s where s.negocio_id=p_negocio_id';
begin
 for fn in select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname like 'native_sales_bootstrap%' and p.pronargs=7 loop
  source:=pg_catalog.pg_get_functiondef(fn.oid);
  if pg_catalog.strpos(source,needle)>0 and pg_catalog.strpos(source,'native_web_legacy_catalogue_rows_v1')=0 then
   execute pg_catalog.replace(source,needle,needle||' and not exists(select 1 from public.native_web_legacy_catalogue_rows_v1 archived_series where archived_series.negocio_id=p_negocio_id and archived_series.table_name=''seriales'' and archived_series.row_id=s.id::text and archived_series.source_row=pg_catalog.to_jsonb(s) and not exists(select 1 from public.productos own_product where own_product.id=s.producto_id and own_product.negocio_id=p_negocio_id))');
  end if;
 end loop;
end $serial_projection$;

-- Transport validates the complete immutable canonical bytes once. Only its
-- private finish function may reuse that proof; direct authenticated calls
-- retain the full canonical check and cannot pass a trusted flag.
do $validated$
declare source text;original text;needle text;
begin
 if pg_catalog.to_regprocedure('public.native_web_cutover_validated_v1(text,text,boolean)') is null then
  source:=pg_catalog.pg_get_functiondef('public.native_web_cutover_v1(text,text)'::regprocedure);original:=source;
  source:=pg_catalog.replace(source,'FUNCTION public.native_web_cutover_v1(p_intent text, p_hash text)','FUNCTION public.native_web_cutover_validated_v1(p_intent text, p_hash text, p_validated boolean)');
  needle:='public.native_web_resolution_canonical_v1(v)<>p_intent';
  if source=original or pg_catalog.strpos(source,needle)=0 then raise exception 'RESOLUTION_BULK_PARENT_INCOMPATIBLE';end if;
  source:=pg_catalog.replace(source,needle,'(not p_validated and public.native_web_resolution_canonical_v1(v)<>p_intent)');execute source;
 end if;
 source:=pg_catalog.pg_get_functiondef('public.native_web_resolution_finish_v1(jsonb,uuid,text,integer,boolean)'::regprocedure);
 needle:='public.native_web_cutover_v1(raw,h)';
 if pg_catalog.strpos(source,needle)>0 then execute pg_catalog.replace(source,needle,'public.native_web_cutover_validated_v1(raw,h,true)');
 elsif pg_catalog.strpos(source,'public.native_web_cutover_validated_v1(raw,h,true)')=0 then raise exception 'RESOLUTION_BULK_PARENT_INCOMPATIBLE';end if;
end $validated$;
revoke all on function public.native_web_cutover_validated_v1(text,text,boolean) from public,anon,authenticated;
create or replace function public.native_web_cutover_v1(p_intent text,p_hash text)
returns jsonb language sql security definer set search_path='' as $f$
 select public.native_web_cutover_validated_v1(p_intent,p_hash,false);
$f$;
-- The one-time 32 MiB handover has a separate, bounded API budget. This does
-- not raise role/database timeouts or change ordinary sale/stock RPCs.
alter function public.native_web_resolution_commit_v1(jsonb,uuid,text,integer) set statement_timeout='60s';
alter function public.native_web_resolution_abandon_v1(jsonb,uuid,text,integer) set statement_timeout='60s';
revoke all on function public.native_web_resolution_assembled_v1(jsonb,uuid,text,integer,uuid) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
