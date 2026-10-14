-- Synthetic Staging only. Present service baselines; never replay old effects.
begin;
do $guard$ begin if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;end $guard$;
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
commit;
