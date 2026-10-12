-- STAGING QA only; local prepared migration, never an implicit deployment.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 or pg_catalog.to_regclass('public.native_management_records_v1') is null then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
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
 header:=pg_catalog.jsonb_build_object('version','ventard.native.operational.1','namespace','NATIVE1','snapshotId',p_snapshot_id,'context',pg_catalog.jsonb_build_object('tenantId',p_negocio_id,'actorId',auth.uid(),'deviceId',p_device_id,'installationId',p_installation_id,'writerEpoch',p_writer_epoch::text,'scopeType',p_scope_kind,'branchId',p_sucursal_id),'capturedAtMs',at_ms::text,'expiresAtMs',(at_ms+86400000)::text,'coverage','QA_SYNTHETIC_ADOPTED','watermark',watermark::text,'totalCount',cnt,'ticketPrefix','N'||pg_catalog.replace(p_installation_id::text,'-',''),'lastTicket',last_ticket::text,'freeTax',pg_catalog.jsonb_build_object('numerator',(m.free_tax*100)::bigint::text,'denominator','100'),'turn',turn_event,'business',(select pg_catalog.jsonb_build_object('name',g.nombre,'rnc',pg_catalog.to_jsonb(g)->>'rnc','address',pg_catalog.to_jsonb(g)->>'direccion','phone',pg_catalog.to_jsonb(g)->>'telefono','footer',pg_catalog.to_jsonb(g)->>'mensaje_ticket') from public.negocios g where g.id=p_negocio_id),'cashBase',public.native_cash_base_v1(p_negocio_id,p_scope_kind,p_sucursal_id,watermark),'pages','[]'::jsonb);
 insert into public.native_sales_snapshots_v1 values(p_negocio_id,p_snapshot_id,auth.uid(),p_installation_id,p_device_id,p_writer_epoch,p_scope_kind,p_sucursal_id,header,at_ms+86400000);
 for batch in select pg_catalog.jsonb_agg(value order by ordinality) from pg_catalog.jsonb_array_elements(rows) with ordinality group by ((ordinality-1)/200) order by ((ordinality-1)/200) loop
  payload:=public.native_sales_canonical_v1(batch);if pg_catalog.octet_length(payload)>1048576 then raise exception 'NATIVE_BOOTSTRAP_PAGE_SIZE';end if;
  pages:=pages||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('index',idx,'count',pg_catalog.jsonb_array_length(batch),'byteLength',pg_catalog.octet_length(payload),'sha256',public.native_sales_hash_v1(payload)));
  insert into public.native_sales_pages_v1 values(p_negocio_id,p_snapshot_id,idx,payload);idx:=idx+1;
 end loop;
 header:=pg_catalog.jsonb_set(header,'{pages}',pages);update public.native_sales_snapshots_v1 set manifest=header where negocio_id=p_negocio_id and snapshot_id=p_snapshot_id;return header;
end $f$;
commit;
