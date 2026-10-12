-- STAGING ONLY: align immutable turn context with the existing local payment plan.
-- No rewrite of an operation/hash, no table/data repair, no extra cash effect.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 or pg_catalog.to_regclass('public.native_sales_ledger_v1') is null then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
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
commit;
