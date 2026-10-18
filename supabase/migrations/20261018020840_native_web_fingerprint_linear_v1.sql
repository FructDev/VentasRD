-- Same normalized C-N1 bytes and 100-row block boundaries as the original
-- cutover. Fuse normalization/serialization and hash each row once rather
-- than building and repeatedly scanning the full normalized table.
-- No data, authorization, fiscal settings or API timeouts are changed.
begin;
create or replace function public.native_web_cutover_canonical_v1(v jsonb,depth integer default 0)
returns text language plpgsql immutable set search_path='' as $f$
declare k text;x jsonb;s text;n numeric;pieces text[]:=array[]::text[];t text:=pg_catalog.jsonb_typeof(v);
begin
 if depth>64 then raise exception 'CUTOVER_INVALID';end if;
 if t='object' and (v ? '$number' or v ? '$milliseconds') then
  if (select count(*) from pg_catalog.jsonb_object_keys(v))<>1 then raise exception 'CUTOVER_INVALID';end if;
  s:=coalesce(v->>'$number',v->>'$milliseconds');n:=s::numeric;s:=n::text;
  if n=0 then s:='0';elsif pg_catalog.strpos(s,'.')>0 then s:=pg_catalog.rtrim(pg_catalog.rtrim(s,'0'),'.');end if;
  -- Preserve the old canonical serializer's extra child-depth check.
  if depth=64 then raise exception 'NATIVE_CANON_DEPTH';end if;
  return '{"$number":'||coalesce(pg_catalog.to_json(s)::text,'null')||'}';
 elsif t='object' then
  for k,x in select key,value from pg_catalog.jsonb_each(v) order by key collate "C" loop
   if k='estado_sincronizacion' or pg_catalog.starts_with(k,'inventory_') or pg_catalog.starts_with(k,'sync_') or k=any(array['remote_receipt','payload_hash','attempt_count','last_attempt_at','next_attempt_at','last_outcome_code','error_class','claim_id','lease_until','conflict','origin_device_id','expected_remote_sequence']) then continue;end if;
   if k~'[^\x00-\x7F]' then raise exception 'NATIVE_CANON_KEY';end if;
   pieces:=pg_catalog.array_append(pieces,pg_catalog.to_json(k)::text||':'||public.native_web_cutover_canonical_v1(x,depth+1));
  end loop;return '{'||pg_catalog.array_to_string(pieces,',')||'}';
 elsif t='array' then
  for x in select value from pg_catalog.jsonb_array_elements(v) loop pieces:=pg_catalog.array_append(pieces,public.native_web_cutover_canonical_v1(x,depth+1));end loop;
  return '['||pg_catalog.array_to_string(pieces,',')||']';
 elsif t='number' then raise exception 'CUTOVER_INVALID';
 elsif t='string' then return pg_catalog.to_json(v#>>'{}')::text;
 else return v::text;end if;
end $f$;
revoke all on function public.native_web_cutover_canonical_v1(jsonb,integer) from public,anon,authenticated;

create or replace function public.native_web_cutover_tables_v1(capture jsonb)
returns jsonb language plpgsql immutable set search_path='' as $f$
declare t jsonb;blocks jsonb;row_count integer;result jsonb:='[]';
begin
 for t in select value from pg_catalog.jsonb_array_elements(capture->'tables') order by value->>'name' collate "C" loop
  with encoded as materialized (
   select pg_catalog.row_number() over(order by value->>'id' collate "C") as ordinal,
    public.native_web_cutover_canonical_v1(value,1) as bytes
   from pg_catalog.jsonb_array_elements(t->'rows')
  ), grouped as (
   select (ordinal-1)/100 as block_index,count(*) as size,
    public.native_sales_hash_v1('['||pg_catalog.string_agg(bytes,',' order by ordinal)||']') as hash
   from encoded group by (ordinal-1)/100
  )
  select coalesce(pg_catalog.jsonb_agg(hash order by block_index),'[]'::jsonb),coalesce(sum(size),0)::integer
   into blocks,row_count from grouped;
  result:=result||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('name',t->>'name','count',row_count,'blocks',blocks));
 end loop;return result;
end $f$;
revoke all on function public.native_web_cutover_tables_v1(jsonb) from public,anon,authenticated;
commit;
