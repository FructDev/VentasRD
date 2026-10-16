-- Fix required branch-stock timestamps during reviewed initial cutover. No data changes at deployment.
-- Synthetic Staging only. Explicit reconciliation of present balances and
-- selected historical documents before the first native financial operation.
-- Original captures/intentions remain evidence; no historical APPLIED receipt.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;
create or replace function public.native_web_cutover_v1(p_intent text,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v jsonb;recon jsonb;c jsonb;n uuid;i uuid;d uuid;b uuid;e bigint;k text;op uuid;role_name text;old public.native_web_cutovers_v1%rowtype;
 capture jsonb;stock_before jsonb;t jsonb;r jsonb;decoded jsonb;table_name text;all_rows jsonb:='{}';body jsonb;missing_ids text[];
 item jsonb;pid uuid;cid uuid;quantity bigint;balance bigint;count_n integer;answer jsonb;validation_snapshot uuid;manifest jsonb;
begin
 if p_intent is null or pg_catalog.octet_length(p_intent)>33554432 then raise exception 'RESOLUTION_TOO_LARGE';end if;
 v:=p_intent::jsonb;
 if not (v ? 'reconciliation') then return public.native_web_cutover_resolution_base_v1(p_intent,p_hash);end if;
 if p_hash is null or public.native_sales_canonical_v1(v)<>p_intent or public.native_sales_hash_v1(p_intent)<>p_hash or v->>'protocol' is distinct from 'ventard.web.cutover.1' or v->>'confirmation' is distinct from 'WEB_WRITERS_CLOSED_BALANCES_REVIEWED' then raise exception 'RESOLUTION_INVALID';end if;
 perform public.native_sales_object_v1(v,array['protocol','cutoverId','runId','revision','context','backupId','backupHash','runHash','confirmation','freeTax','sources','tables','reconciliation']);
 if (select count(*) from pg_catalog.jsonb_object_keys(v))<>(13+case when v ? 'serviceReservationsConfirmed' then 1 else 0 end+case when v ? 'legacyCashHistoryConfirmed' then 1 else 0 end) or v->>'freeTax' not in('0','0.18') or v->>'backupHash'!~'^[0-9a-f]{64}$' or v->>'runHash'!~'^[0-9a-f]{64}$' or pg_catalog.jsonb_typeof(v->'revision') is distinct from 'number' then raise exception 'RESOLUTION_INVALID';end if;
 perform (v->>'runId')::uuid;perform (v->>'backupId')::uuid;
 c:=v->'context';n:=(c->>'tenantId')::uuid;i:=(c->>'installationId')::uuid;d:=(c->>'deviceId')::uuid;b:=(c->>'branchId')::uuid;e:=(c->>'writerEpoch')::bigint;k:=c->>'scopeType';op:=(v->>'cutoverId')::uuid;
 if n is null or n not in('96000000-0000-4000-8000-000000000001'::uuid,'96000000-0000-4000-8000-000000000002'::uuid) or op is null or (c->>'actorId')::uuid is distinct from auth.uid() then raise exception 'CUTOVER_CONTEXT';end if;
 role_name:=public.native_sales_context_v1(n,i,d,e,k,b);if role_name not in('owner','admin') then raise exception using errcode='42501',message='CUTOVER_DENIED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-sales:'||n::text,0));
 select * into old from public.native_web_cutovers_v1 where negocio_id=n and cutover_id=op;
 if found then if old.intent<>p_intent or old.intent_hash<>p_hash then raise exception 'CUTOVER_ID_CONFLICT';end if;return old.receipt;end if;
 -- Import is a pre-operation handover, never a rewrite of native trade history.
 if exists(select 1 from public.native_sales_ledger_v1 where negocio_id=n) or exists(select 1 from public.native_sales_turns_v1 where negocio_id=n) then raise exception 'RESOLUTION_NATIVE_ALREADY_STARTED';end if;
 if exists(select 1 from public.native_sales_mode_v1 where negocio_id=n) and exists(select 1 from public.native_installations_v1 where negocio_id=n and installation_id<>i and status='REGISTERED') then raise exception 'RESOLUTION_OTHER_WRITERS_ACTIVE';end if;
 recon:=v->'reconciliation';
 perform public.native_sales_object_v1(recon,array['protocol','reason','basis','rows','stockCounts','debtBalances','decisions','history']);
 if (select count(*) from pg_catalog.jsonb_object_keys(recon))<>8 or recon->>'protocol' is distinct from 'ventard.web.resolution.1' or pg_catalog.length(pg_catalog.btrim(recon->>'reason')) not between 10 and 500 or recon->>'reason' is null or recon->'basis'->'context' is distinct from c or recon->'basis'->>'protocol' is distinct from 'ventard.web.resolution.basis.1' or v->'legacyCashHistoryConfirmed' is distinct from 'true'::jsonb then raise exception 'RESOLUTION_INVALID';end if;
 if pg_catalog.jsonb_typeof(recon->'rows') is distinct from 'array' or pg_catalog.jsonb_typeof(recon->'stockCounts') is distinct from 'array' or pg_catalog.jsonb_typeof(recon->'debtBalances') is distinct from 'array' or pg_catalog.jsonb_typeof(recon->'decisions') is distinct from 'array' then raise exception 'RESOLUTION_INVALID';end if;
 if recon->'history'->>'protocol' is distinct from 'ventard.web.resolution.history.1' or pg_catalog.jsonb_array_length(recon->'history'->'tables')<>15 or pg_catalog.jsonb_typeof(recon->'history'->'tickets') is distinct from 'array' then raise exception 'RESOLUTION_HISTORY_INVALID';end if;
 for t in select value from pg_catalog.jsonb_array_elements(recon->'history'->'tables') loop
  for r in select value from pg_catalog.jsonb_array_elements(t->'rows') loop if r->>'negocio_id' is distinct from n::text then raise exception 'RESOLUTION_SCOPE';end if;end loop;
 end loop;
 foreach table_name in array array['apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','inventario_sucursales','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas'] loop execute pg_catalog.format('lock table public.%I in share row exclusive mode',table_name);end loop;
 if exists(select 1 from pg_catalog.pg_trigger tr join pg_catalog.pg_class cl on cl.oid=tr.tgrelid join pg_catalog.pg_namespace ns on ns.oid=cl.relnamespace join pg_catalog.pg_proc fn on fn.oid=tr.tgfoid where ns.nspname='public' and cl.relname in('apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','inventario_sucursales','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas') and not tr.tgisinternal and tr.tgenabled<>'D' and fn.proname not in('native_sales_fence_v1','normalizar_fecha_actualizacion')) then raise exception 'RESOLUTION_SCHEMA_INCOMPATIBLE';end if;
 capture:=public.native_web_capture_v1(n,i,d,e,k,b,(recon->'basis'->>'captureId')::uuid);stock_before:=public.native_web_resolution_stock_v1(n);
 if public.native_web_cutover_tables_v1(capture) is distinct from v->'tables' or recon->'basis'->'tables' is distinct from v->'tables' or recon->'basis'->>'stockHash' is distinct from public.native_sales_hash_v1(public.native_sales_canonical_v1(stock_before)) or recon->'basis'->'stockBase' is distinct from stock_before then raise exception 'RESOLUTION_SOURCE_CHANGED';end if;
 if pg_catalog.jsonb_array_length(recon->'rows')<>15 or (select count(distinct value->>'name') from pg_catalog.jsonb_array_elements(recon->'rows'))<>15 then raise exception 'RESOLUTION_INVALID';end if;
 for t in select value from pg_catalog.jsonb_array_elements(recon->'rows') loop
  table_name:=t->>'name';if table_name not in('apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas') or pg_catalog.jsonb_typeof(t->'rows') is distinct from 'array' or pg_catalog.jsonb_array_length(t->'rows')>200000 then raise exception 'RESOLUTION_INVALID';end if;
  if (select count(distinct x->>'id') from pg_catalog.jsonb_array_elements(t->'rows') x)<>pg_catalog.jsonb_array_length(t->'rows') then raise exception 'RESOLUTION_INVALID';end if;
  for r in select value from pg_catalog.jsonb_array_elements(t->'rows') loop
   if r->>'negocio_id' is distinct from n::text or r->>'id' is null then raise exception 'RESOLUTION_SCOPE';end if;
   if table_name in('apartados','cajas','cortes_caja','gastos','movimientos_stock','reparaciones','transacciones_fiado','venta_detalles','ventas') and (not (r ? 'sucursal_id') or r->>'sucursal_id' is distinct from b::text) then raise exception 'RESOLUTION_SCOPE';end if;
  end loop;
  all_rows:=all_rows||pg_catalog.jsonb_build_object(table_name,t->'rows');
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'devoluciones') loop
  if r ? 'sucursal_id' then if r->>'sucursal_id' is distinct from b::text then raise exception 'RESOLUTION_SCOPE';end if;
  elsif not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'ventas') s where s->>'id'=r->>'venta_id' and s->>'sucursal_id' is not distinct from b::text) then raise exception 'RESOLUTION_SCOPE';end if;
 end loop;
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n) on conflict do nothing;
 -- Never delete a source parent. Alternative sale children are retained in the
 -- immutable before capture; only their chosen document remains operational.
 foreach table_name in array array['venta_detalles','devoluciones','transacciones_fiado','movimientos_stock','gastos','cortes_caja','reparaciones','apartados','seriales','composiciones','ventas','cajas','clientes','productos','sucursales'] loop
  select value into t from pg_catalog.jsonb_array_elements(capture->'tables') where value->>'name'=table_name;
  select pg_catalog.array_agg(x->>'id') into missing_ids from pg_catalog.jsonb_array_elements(t->'rows') x where not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->table_name) y where y->>'id'=x->>'id');
  if coalesce(pg_catalog.cardinality(missing_ids),0)>0 then
   if table_name in('clientes','productos','seriales','composiciones','sucursales') then raise exception 'RESOLUTION_SOURCE_PARENT_MISSING';end if;
   if table_name not in('venta_detalles','transacciones_fiado','movimientos_stock') and exists(select 1 from pg_catalog.unnest(missing_ids) missing where not exists(select 1 from pg_catalog.jsonb_array_elements(recon->'decisions') x where x->>'table'=table_name and x->>'rowId'=missing and x->'archiveOnly'='true'::jsonb and pg_catalog.length(x->>'reason') between 10 and 500)) then raise exception 'RESOLUTION_SOURCE_PARENT_MISSING';end if;
   execute pg_catalog.format('delete from public.%I where negocio_id::text=$1 and id::text=any($2)',table_name) using n::text,missing_ids;
  end if;
 end loop;
 -- Scope and exact amounts are checked independently of the client report.
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'productos') loop
  decoded:=public.native_web_resolution_decode_v1(r);
  for item in select pg_catalog.to_jsonb(name) from pg_catalog.unnest(array['precio_venta','precio_2','precio_3','costo']) name loop
   if decoded->(item#>>'{}')<>'null'::jsonb and ((decoded->>(item#>>'{}'))::numeric<0 or (decoded->>(item#>>'{}'))::numeric*100<>pg_catalog.trunc((decoded->>(item#>>'{}'))::numeric*100)) then raise exception 'RESOLUTION_MONEY_INVALID';end if;
  end loop;
  if decoded->'tasa_itbis'<>'null'::jsonb and ((decoded->>'tasa_itbis')::numeric not between 0 and 1 or (decoded->>'tasa_itbis')::numeric*100<>pg_catalog.trunc((decoded->>'tasa_itbis')::numeric*100)) then raise exception 'RESOLUTION_MONEY_INVALID';end if;
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'ventas') loop
  decoded:=public.native_web_resolution_decode_v1(r);
  if (decoded->>'total')::numeric<0 or (decoded->>'total')::numeric*100<>pg_catalog.trunc((decoded->>'total')::numeric*100) or decoded->>'total' is null or decoded->>'metodo_pago' is null or decoded->>'metodo_pago' not in('efectivo','tarjeta','transferencia','mixto','fiado') then raise exception 'RESOLUTION_MONEY_INVALID';end if;
  if decoded->>'metodo_pago'='mixto' and ((decoded->>'monto_efectivo')::numeric<=0 or (decoded->>'monto_transferencia')::numeric<=0 or (decoded->>'monto_efectivo')::numeric+(decoded->>'monto_transferencia')::numeric is distinct from (decoded->>'total')::numeric) then raise exception 'RESOLUTION_MONEY_INVALID';end if;
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'venta_detalles') loop
  decoded:=public.native_web_resolution_decode_v1(r);
  if not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'ventas') s where s->>'id'=r->>'venta_id') or decoded->>'cantidad' is null or decoded->>'precio_unitario' is null or decoded->>'subtotal' is null or (decoded->>'cantidad')::numeric<=0 or (decoded->>'precio_unitario')::numeric<0 or (decoded->>'precio_unitario')::numeric*100<>pg_catalog.trunc((decoded->>'precio_unitario')::numeric*100) or (decoded->>'subtotal')::numeric*100<>pg_catalog.trunc((decoded->>'subtotal')::numeric*100) or (decoded->>'subtotal')::numeric is distinct from (decoded->>'cantidad')::numeric*(decoded->>'precio_unitario')::numeric then raise exception 'RESOLUTION_MONEY_INVALID';end if;
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'transacciones_fiado') loop
  decoded:=public.native_web_resolution_decode_v1(r);
  if decoded->>'tipo' not in('cargo','abono') or decoded->>'tipo' is null or decoded->>'monto' is null or (decoded->>'monto')::numeric<0 or (decoded->>'monto')::numeric*100<>pg_catalog.trunc((decoded->>'monto')::numeric*100) or not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'clientes') c0 where c0->>'id'=r->>'cliente_id') then raise exception 'RESOLUTION_MONEY_INVALID';end if;
 end loop;
 for r in select value from pg_catalog.jsonb_array_elements(all_rows->'cajas') loop if r->>'estado' is distinct from 'cerrada' then raise exception 'CUTOVER_CLOSE_WEB_CASH';end if;end loop;
 for t in select value from pg_catalog.jsonb_array_elements(capture->'tables') where value->>'name'='cajas' loop for r in select value from pg_catalog.jsonb_array_elements(t->'rows') loop if r->>'estado' is distinct from 'cerrada' then raise exception 'CUTOVER_CLOSE_WEB_CASH';end if;end loop;end loop;
 -- A prior QA adoption with no native operation may be replaced, but journals,
 -- registrations, licenses, NCF cursors and identities are never reset.
 insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n) on conflict do nothing;
 foreach table_name in array array['sucursales','productos','clientes','composiciones','cajas','ventas','venta_detalles','transacciones_fiado','seriales','reparaciones','apartados','gastos','cortes_caja','devoluciones','movimientos_stock'] loop
  for r in select value from pg_catalog.jsonb_array_elements(all_rows->table_name) loop perform public.native_web_resolution_upsert_v1(table_name,r,n,k,b);end loop;
 end loop;
 if pg_catalog.jsonb_array_length(recon->'stockCounts')<>(select count(*) from pg_catalog.jsonb_array_elements(all_rows->'productos') p where p->>'tipo' is distinct from 'combo') or (select count(distinct x->>'productId') from pg_catalog.jsonb_array_elements(recon->'stockCounts') x)<>pg_catalog.jsonb_array_length(recon->'stockCounts') then raise exception 'RESOLUTION_STOCK_COVERAGE';end if;
 for item in select value from pg_catalog.jsonb_array_elements(recon->'stockCounts') loop
  pid:=(item->>'productId')::uuid;quantity:=public.native_sales_int_v1(item->'quantity',2147483647)::bigint;
  if not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'productos') p where p->>'id'=pid::text and p->>'tipo' is distinct from 'combo') then raise exception 'RESOLUTION_STOCK_COVERAGE';end if;
  if k='BRANCH' then
   if exists(select 1 from public.inventario_sucursales s where s.producto_id=pid and s.sucursal_id<>b and s.stock_actual is null) then raise exception 'RESOLUTION_OTHER_BRANCH_STOCK_UNKNOWN';end if;
   insert into public.inventario_sucursales(sucursal_id,producto_id,stock_actual,fecha_actualizacion) values(b,pid,quantity::integer,(extract(epoch from pg_catalog.transaction_timestamp())*1000)::bigint) on conflict(sucursal_id,producto_id) do update set stock_actual=excluded.stock_actual,fecha_actualizacion=excluded.fecha_actualizacion;
   update public.productos set stock_actual=(select sum(s.stock_actual) from public.inventario_sucursales s where s.producto_id=pid)::integer where id=pid and negocio_id=n;
  else update public.productos set stock_actual=quantity::integer where id=pid and negocio_id=n;end if;
 end loop;
 if pg_catalog.jsonb_array_length(recon->'debtBalances')<>pg_catalog.jsonb_array_length(all_rows->'clientes') or (select count(distinct x->>'customerId') from pg_catalog.jsonb_array_elements(recon->'debtBalances') x)<>pg_catalog.jsonb_array_length(recon->'debtBalances') then raise exception 'RESOLUTION_DEBT_COVERAGE';end if;
 delete from public.native_sales_mode_v1 where negocio_id=n;delete from public.native_sales_stock_v1 where negocio_id=n;delete from public.native_sales_credit_v1 where negocio_id=n;
 delete from public.native_legacy_services_v1 where negocio_id=n and scope_kind=k and sucursal_id is not distinct from b;
 perform public.native_legacy_services_adopt_v1(pg_catalog.jsonb_build_object('tables',recon->'rows'),c,op,(v->'serviceReservationsConfirmed'='true'::jsonb));
 perform public.native_sales_activate_v1(n,i,d,e,k,b,'QA_SYNTHETIC_QUIESCED',v->>'freeTax');
 for item in select value from pg_catalog.jsonb_array_elements(recon->'debtBalances') loop
  cid:=(item->>'customerId')::uuid;balance:=public.native_sales_int_v1(item->'balanceCents')::bigint;
  if not exists(select 1 from pg_catalog.jsonb_array_elements(all_rows->'clientes') c0 where c0->>'id'=cid::text) then raise exception 'RESOLUTION_DEBT_COVERAGE';end if;
  update public.native_sales_credit_v1 set balance_cents=balance where negocio_id=n and cliente_id=cid;
 end loop;
 validation_snapshot:=public.native_sales_effect_id_v1(op,'resolution-validation');
 if exists(select 1 from public.native_sales_snapshots_v1 where negocio_id=n and snapshot_id=validation_snapshot) then raise exception 'CUTOVER_ID_CONFLICT';end if;
 manifest:=public.native_sales_bootstrap_v1(n,i,d,e,k,b,validation_snapshot);
 answer:=pg_catalog.jsonb_build_object('protocol','ventard.web.cutover.receipt.1','status','BASELINE_ADOPTED','cutoverId',op,'planHash',p_hash,'context',c,'runId',v->'runId','revision',v->'revision','backupId',v->'backupId','coverage','RECONCILED_SELECTED_BASELINE','legacyReplay',false);
 insert into public.native_web_resolutions_v1 values(n,op,capture,stock_before,recon->'rows',answer,recon->'history',public.native_sales_hash_v1(public.native_sales_canonical_v1(recon->'history')));
 insert into public.native_web_cutovers_v1(negocio_id,cutover_id,intent,intent_hash,receipt,actor_id) values(n,op,p_intent,p_hash,answer,auth.uid());
 delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;
 return answer;
end $f$;
revoke all on function public.native_web_cutover_v1(text,text) from public,anon;
grant execute on function public.native_web_cutover_v1(text,text) to authenticated;
commit;
