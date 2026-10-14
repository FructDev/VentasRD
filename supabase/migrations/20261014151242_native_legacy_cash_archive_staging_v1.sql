-- Explicit archival consent for historical sales with an unknown cash link.
-- No source row, cash/debt/stock amount, old flag, ticket or identity is changed.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 or pg_catalog.to_regprocedure('public.native_web_cutover_v1(text,text)') is null then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
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
commit;
