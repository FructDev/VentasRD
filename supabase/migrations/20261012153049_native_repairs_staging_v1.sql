-- STAGING QA only; no remote application or Pro upgrade is performed here.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001'::uuid and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002'::uuid and nombre='PRO00 QA B - SINTETICO'))<>2
 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
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
 perform 1 from public.native_staging_licenses_v1 where negocio_id=n and plan_tier='pro' for share;if not found then raise exception using errcode='42501',message='NATIVE_PRO_REQUIRED';end if;
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
 header:=pg_catalog.jsonb_build_object('version','ventard.native.operational.1','namespace','NATIVE1','snapshotId',p_snapshot_id,'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'deviceId',p_device_id,'installationId',p_installation_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),'capturedAtMs',at_ms::text,'expiresAtMs',(at_ms+86400000)::text,'coverage','QA_SYNTHETIC_ADOPTED','watermark',watermark::text,'totalCount',cnt,'ticketPrefix','N'||pg_catalog.replace(p_installation_id::text,'-',''),'lastTicket',last_ticket::text,'freeTax',pg_catalog.jsonb_build_object('numerator',(m.free_tax*100)::bigint::text,'denominator','100'),'turn',turn_event,'business',(select pg_catalog.jsonb_build_object('name',g.nombre,'rnc',pg_catalog.to_jsonb(g)->>'rnc','address',pg_catalog.to_jsonb(g)->>'direccion','phone',pg_catalog.to_jsonb(g)->>'telefono','footer',pg_catalog.to_jsonb(g)->>'mensaje_ticket') from public.negocios g where g.id=p_negocio_id),'cashBase',public.native_cash_base_v1(p_negocio_id,p_scope_kind,p_sucursal_id,watermark),'pages','[]'::jsonb);
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
 if role not in('owner','admin') or (v->>'actorId')::uuid is distinct from auth.uid() or not exists(select 1 from public.native_staging_licenses_v1 where negocio_id=n and plan_tier='pro') then raise exception using errcode='42501',message='NATIVE_PRIVATE_DENIED';end if;
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
commit;
