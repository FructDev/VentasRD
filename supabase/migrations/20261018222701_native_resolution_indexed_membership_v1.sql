-- Compare parent membership once per table. Preserve every prior decision,
-- null/duplicate rule, source order, exact ID, scope check and archive rule.
-- No cutover is executed by deploying this migration.
begin;
create or replace function public.native_web_resolution_missing_ids_v1(source_rows jsonb,selected_rows jsonb)
returns text[] language sql immutable set search_path='' as $f$
 with selected_ids as materialized (
  select distinct value->>'id' row_id from pg_catalog.jsonb_array_elements(selected_rows)
 ), originals as (
  select value->>'id' row_id,ordinal from pg_catalog.jsonb_array_elements(source_rows) with ordinality a(value,ordinal)
 )
 select pg_catalog.array_agg(o.row_id order by o.ordinal)
 from originals o left join selected_ids s on s.row_id=o.row_id
 where s.row_id is null;
$f$;
revoke all on function public.native_web_resolution_missing_ids_v1(jsonb,jsonb) from public,anon,authenticated;
do $membership$
declare source text;needle text:='select pg_catalog.array_agg(x->>''id'') into missing_ids from pg_catalog.jsonb_array_elements(t->''rows'') x where not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->table_name) y where y->>''id''=x->>''id'');';
begin
 source:=pg_catalog.pg_get_functiondef('public.native_web_cutover_validated_v1(text,text,boolean)'::regprocedure);
 if pg_catalog.strpos(source,needle)>0 then
  execute pg_catalog.replace(source,needle,'missing_ids:=public.native_web_resolution_missing_ids_v1(t->''rows'',all_rows->table_name);');
 elsif pg_catalog.strpos(source,'missing_ids:=public.native_web_resolution_missing_ids_v1(t->''rows'',all_rows->table_name);')=0 then
  raise exception 'RESOLUTION_MEMBERSHIP_PARENT_INCOMPATIBLE';
 end if;
end $membership$;
notify pgrst,'reload schema';
commit;
