-- Prepared Staging QA extension. Applying it does not activate any business.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 or pg_catalog.to_regprocedure('public.native_inventory_submit_v1(text,text,text,text)') is null then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
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
commit;
