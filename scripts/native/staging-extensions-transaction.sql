-- Explicitly authorized Staging QA A/B, 2026-10-12.
-- Integration fixture: real PostgreSQL/authenticated DB role + synthetic JWT sub.
-- Does NOT demonstrate an end-user login, Tauri broker or physical two-PC sync.
-- Every test operation is rolled back; no credentials or private values are output.
begin;
do $$begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2
 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
 if exists(select 1 from public.productos where id='96900000-0000-4000-8000-000000000020')
 then raise exception 'QA_TEST_ID_ALREADY_EXISTS';end if;
end $$;
select set_config('request.jwt.claim.sub','4e500fbf-a8a4-4a41-8928-06d222962a5c',true);
set local role authenticated;
select public.native_registrar_instalacion_v1('96900000-0000-4000-8000-000000000009','96000000-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000003','96900000-0000-4000-8000-000000000002','BRANCH','96000002-0000-4000-8000-000000000001');
select public.native_registrar_instalacion_v1('96900000-0000-4000-8000-000000000019','96000000-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000013','96900000-0000-4000-8000-000000000012','BRANCH','96000002-0000-4000-8000-000000000001');
reset role;
create temporary table qa_proof(key text primary key,value jsonb);
insert into qa_proof values('cash',public.native_sales_feed_v1('96000000-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000003','96900000-0000-4000-8000-000000000002',1,'BRANCH','96000002-0000-4000-8000-000000000001','0')->'cashBase'->'netCents');
create function pg_temp.apply(kind text,req jsonb,doc jsonb) returns jsonb language plpgsql as $apply$
declare v jsonb;t text;h text;r jsonb;replay jsonb;bad text;denied boolean:=false;
begin
 v:=jsonb_build_object('protocol','ventard.native.v1','kind',kind,'contractVersion',1,'canonicalizationVersion','C-N1','operationId',req->>'operationId','negocioId','96000000-0000-4000-8000-000000000001','scope',jsonb_build_object('type','BRANCH','sucursalId','96000002-0000-4000-8000-000000000001'),'originDeviceId','96900000-0000-4000-8000-000000000002','installationId','96900000-0000-4000-8000-000000000003','writerEpoch','1','actorId','4e500fbf-a8a4-4a41-8928-06d222962a5c','permissionGrantId','96900000-0000-4000-8000-000000000009','originalTurnId',null,'originAtUtcMs','1791842400000','expectedVersions','{}'::jsonb,'dependencies','[]'::jsonb,'payload',jsonb_build_object('request',req,'document',doc));
 t:=public.native_sales_canonical_v1(v);h:=public.native_sales_hash_v1(t);
 bad:=public.native_sales_canonical_v1(jsonb_set(v,'{payload,document,fixtureUnexpected}','true'));
 execute 'set local role authenticated';
 begin perform public.native_sales_submit_v1(bad,encode(sha256(convert_to(bad,'UTF8')),'hex'),null,null);
 exception when others then denied:=true;end;
 if not denied then raise exception 'QA_DOCUMENT_TAMPER_ACCEPTED';end if;
 r:=public.native_sales_submit_v1(t,h,null,null);
 replay:=public.native_sales_submit_v1(t,h,null,null);
 execute 'reset role';
 if r is distinct from replay then raise exception 'QA_REPLAY_CHANGED';end if;
 if (select count(*) from public.native_sales_ledger_v1 where negocio_id='96000000-0000-4000-8000-000000000001' and operation_id=(req->>'operationId')::uuid)<>1 then raise exception 'QA_DUPLICATE_LEDGER';end if;
 insert into qa_proof values(req->>'operationId',r);
 return r;
exception when others then execute 'reset role';raise;
end $apply$;
do $run$
declare req jsonb;doc jsonb;r jsonb;previous jsonb;proof jsonb;seq text;w jsonb;private jsonb;t text;h text;rows jsonb;m jsonb;page jsonb;descriptor jsonb;denied boolean:=false;
begin
 -- Create a new serial product through the real command; original catalogue untouched.
 req:='{"kind":"PRODUCT_SAVE","operationId":"96900000-0000-4000-8000-000000000100","productId":"96900000-0000-4000-8000-000000000020","expectedRevision":"0","definition":{"name":"QA rollback serial","code":"","priceCents":"1234","tier2Cents":null,"tier3Cents":null,"costCents":"700","taxPercent":"0","productType":"simple","location":"","minimum":"0","serialRequired":true,"recipe":[]}}';
 doc:='{"product":{"id":"96900000-0000-4000-8000-000000000020","name":"QA rollback serial","code":"","revision":"1","deleted":false,"priceTiers":{"retailCents":"1234","tier2Cents":null,"tier3Cents":null},"metadata":{"costCents":"700","taxRate":{"numerator":"0","denominator":"1"},"serialRequired":true,"recipe":[],"productType":"simple","recipeCostPolicy":"DECLARED","location":"","minimum":"0"}}}';
 r:=pg_temp.apply('PRODUCT_CREATE',req,doc);
 seq:=r->>'remoteSequence';
 proof:=jsonb_build_object('productId','96900000-0000-4000-8000-000000000020','remoteBaseQty','0','remoteSequence',seq,'pending','[]'::jsonb,'effectiveQty','0');
 req:=jsonb_build_object('kind','INVENTORY_CHANGE','operationId','96900000-0000-4000-8000-000000000101','productId','96900000-0000-4000-8000-000000000020','expectedStockRevision',public.native_sales_hash_v1(public.native_sales_canonical_v1(jsonb_build_object('quantity','0','remoteSequence',seq,'pending','[]'::jsonb))),'mode','IN','quantity','1','reason','QA rollback','serials',jsonb_build_array('QA-ROLLBACK-IMEI-01'));
 doc:=jsonb_build_object('productId',req->>'productId','productRevision','1','delta','1','before','0','after','1','mode','IN','reason','QA rollback','serials',req->'serials','stockEvidence',proof);
 r:=pg_temp.apply('INVENTORY_DELTA',req,doc);
 -- Deposit and new customer are atomic; fecha_actualizacion is required by Staging.
 req:='{"kind":"REPAIR_SAVE","operationId":"96900000-0000-4000-8000-000000000102","repairId":"96900000-0000-4000-8000-000000000030","expectedRevision":"0","quote":false,"definition":{"customerId":"96900000-0000-4000-8000-000000000031","customerName":"QA rollback customer","phone":"8095550100","brand":"Samsung","model":"A14","imei":"QA-REPAIR-ROLLBACK","color":"Negro","conditionChecks":["Enciende"],"conditionNotes":"","accessories":"","problem":"Pantalla","diagnosis":"","notes":"","technician":"QA","labourCents":"400","partsChargeSeparate":true,"parts":[]},"initialPaymentCents":"100","method":"TARJETA","turnId":null,"createCustomer":true}';
 doc:=public.native_repair_plan_v1(req,null,'1791842400000','4e500fbf-a8a4-4a41-8928-06d222962a5c','REP-N96900000000040008000000000000003-001','1')||jsonb_build_object('stock','[]'::jsonb,'business',null,'customer',jsonb_build_object('id',req->'definition'->>'customerId','name','QA rollback customer','phone','8095550100','limitCents','0','priceTier',1,'wholesale',false,'active',true,'revision','1'));
 r:=pg_temp.apply('REPAIR_CREATE',req,doc);
 if r->'effects'->0->'payload'->'repair'->>'paidCents'<>'100' or (select fecha_actualizacion from public.clientes where id='96900000-0000-4000-8000-000000000031')<>1791842400000 then raise exception 'QA_REPAIR_CUSTOMER_FAILED';end if;
 private:=jsonb_build_object('protocol','ventard.repair.private.1','operationId',req->>'operationId','tenantId','96000000-0000-4000-8000-000000000001','scope',jsonb_build_object('type','BRANCH','branchId','96000002-0000-4000-8000-000000000001'),'actorId','4e500fbf-a8a4-4a41-8928-06d222962a5c','installationId','96900000-0000-4000-8000-000000000003','deviceId','96900000-0000-4000-8000-000000000002','writerEpoch','1','repairId',req->>'repairId','repairRevision','1','baseOperationId',req->>'operationId','value','SYNTHETIC_ROLLBACK_ONLY');
 t:=public.native_sales_canonical_v1(private);h:=public.native_sales_hash_v1(t);
 execute 'set local role authenticated';
 perform public.native_repairs_private_submit_v1(t,h);
 perform public.native_repairs_private_submit_v1(t,h);
 rows:=public.native_repairs_private_read_v1('96000000-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000003','96900000-0000-4000-8000-000000000002',1,'BRANCH','96000002-0000-4000-8000-000000000001');
 execute 'reset role';
 if not exists(select 1 from jsonb_array_elements(rows->'rows') x where x->>'repairId'=req->>'repairId' and x->>'value'='SYNTHETIC_ROLLBACK_ONLY') then raise exception 'QA_PRIVATE_READ_FAILED';end if;
 -- Reserve and deliver the same serial without altering cash.
 select revision::text into seq from public.native_sales_stock_v1 where negocio_id='96000000-0000-4000-8000-000000000001' and producto_id='96900000-0000-4000-8000-000000000020';
 proof:=jsonb_build_object('productId','96900000-0000-4000-8000-000000000020','remoteBaseQty','1','remoteSequence',seq,'pending','[]'::jsonb,'effectiveQty','1');
 req:='{"kind":"LAYAWAY_CREATE","operationId":"96900000-0000-4000-8000-000000000103","layawayId":"96900000-0000-4000-8000-000000000040","definition":{"customerId":null,"customerName":"QA rollback customer","phone":"8095550100","notes":"QA rollback","items":[{"productId":"96900000-0000-4000-8000-000000000020","name":"QA rollback serial","quantity":"1","priceCents":"1234","serial":"QA-ROLLBACK-IMEI-01"}]},"initialPaymentCents":"100","method":"TARJETA","turnId":null}';
 doc:=public.native_layaway_plan_v1(req,null,'1791842400000','4e500fbf-a8a4-4a41-8928-06d222962a5c','AP-N96900000000040008000000000000003-001','1')||jsonb_build_object('business',null,'stock',jsonb_build_array(jsonb_build_object('productId',proof->>'productId','delta','-1','before','1','after','0','expectedRevision',public.native_sales_hash_v1(public.native_sales_canonical_v1(jsonb_build_object('quantity','1','remoteSequence',seq,'pending','[]'::jsonb))),'stockEvidence',proof)),'serials',jsonb_build_array(jsonb_build_object('productId',proof->>'productId','text','QA-ROLLBACK-IMEI-01','expectedRevision','1','before','AVAILABLE','after','RESERVED')));
 r:=pg_temp.apply('LAYAWAY_CREATE',req,doc);previous:=doc->'layaway';
 if (select estado from public.seriales where producto_id='96900000-0000-4000-8000-000000000020')<>'apartado' then raise exception 'QA_RESERVATION_FAILED';end if;
 req:='{"kind":"LAYAWAY_ACTION","operationId":"96900000-0000-4000-8000-000000000104","layawayId":"96900000-0000-4000-8000-000000000040","expectedRevision":"1","action":"COMPLETE","amountCents":"0","method":"TARJETA","turnId":null,"warrantyDays":"30"}';
 doc:=public.native_layaway_plan_v1(req,previous,'1791842400000','4e500fbf-a8a4-4a41-8928-06d222962a5c',previous->>'folio','1')||jsonb_build_object('business',null,'stock','[]'::jsonb,'serials',jsonb_build_array(jsonb_build_object('productId','96900000-0000-4000-8000-000000000020','text','QA-ROLLBACK-IMEI-01','expectedRevision','1','before','RESERVED','after','SOLD')));
 r:=pg_temp.apply('LAYAWAY_COMPLETE',req,doc);
 if doc->'layaway'->>'paidCents'<>'1234' or doc->>'amountCents'<>'1134' or (select stock_actual from public.inventario_sucursales where sucursal_id='96000002-0000-4000-8000-000000000001' and producto_id='96900000-0000-4000-8000-000000000020')<>0 then raise exception 'QA_DELIVERY_FAILED';end if;
 w:=public.native_warranty_current_v1('96000000-0000-4000-8000-000000000001','BRANCH','96000002-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000020','QA-ROLLBACK-IMEI-01');
 req:=jsonb_build_object('kind','WARRANTY_SAVE','operationId','96900000-0000-4000-8000-000000000105','productId','96900000-0000-4000-8000-000000000020','serial','QA-ROLLBACK-IMEI-01','expectedRevision',w->>'revision','action','ADJUST','days','60');
 w:=(w-'revision')||jsonb_build_object('version',((w->>'version')::bigint+1)::text,'days','60','untilMs',((w->>'soldAtMs')::bigint+60*86400000::bigint)::text);
 doc:=jsonb_build_object('operationId',req->>'operationId','warranty',w,'business',null,'amountCents','0','method',null,'concept','Garantía QA-ROLLBACK-IMEI-01');
 r:=pg_temp.apply('WARRANTY_PATCH',req,doc);
 if w->>'soldAtMs'<>'1791842400000' or w->>'priceCents'<>'1234' then raise exception 'QA_WARRANTY_ORIGIN_CHANGED';end if;
 w:=public.native_warranty_current_v1('96000000-0000-4000-8000-000000000001','BRANCH','96000002-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000020','QA-ROLLBACK-IMEI-01');
 req:=req||jsonb_build_object('operationId','96900000-0000-4000-8000-000000000106','expectedRevision',w->>'revision','action','CERTIFY','days','');
 doc:=doc||jsonb_build_object('operationId',req->>'operationId','warranty',(w-'revision')||jsonb_build_object('version',((w->>'version')::bigint+1)::text));
 r:=pg_temp.apply('WARRANTY_PATCH',req,doc);
 -- Server capture for a second independent installation preserves current parents.
 execute 'set local role authenticated';
 m:=public.native_sales_bootstrap_v1('96000000-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000013','96900000-0000-4000-8000-000000000012',1,'BRANCH','96000002-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000050');
 rows:='[]'::jsonb;
 for descriptor in select value from jsonb_array_elements(m->'pages') loop
  page:=public.native_sales_bootstrap_page_v1('96000000-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000013','96900000-0000-4000-8000-000000000012',1,'BRANCH','96000002-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000050',(descriptor->>'index')::integer);
  rows:=rows||(page->>'payload')::jsonb;
 end loop;
 execute 'reset role';
 if not exists(select 1 from jsonb_array_elements(rows) x where x->>'kind'='LAYAWAY' and x->'event'->'receipt'->>'operationId'='96900000-0000-4000-8000-000000000104') or not exists(select 1 from jsonb_array_elements(rows) x where x->>'kind'='WARRANTY_RECORD' and x->'event'->'receipt'->>'operationId'='96900000-0000-4000-8000-000000000106') or position('SYNTHETIC_ROLLBACK_ONLY' in rows::text)>0 then raise exception 'QA_CAPTURE_INVALID';end if;
 if (public.native_sales_feed_v1('96000000-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000003','96900000-0000-4000-8000-000000000002',1,'BRANCH','96000002-0000-4000-8000-000000000001','0')->'cashBase'->'netCents') is distinct from (select value from qa_proof where key='cash') then raise exception 'QA_CASH_CHANGED';end if;
 -- Real seller DB role cannot read the private channel.
 perform set_config('request.jwt.claim.sub','592ee073-ac71-4e9b-b112-9a4aadab5c4a',true);
 execute 'set local role authenticated';
 begin perform public.native_repairs_private_read_v1('96000000-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000003','96900000-0000-4000-8000-000000000002',1,'BRANCH','96000002-0000-4000-8000-000000000001');
 exception when insufficient_privilege then denied:=true;end;
 execute 'reset role';
 if not denied then raise exception 'QA_SELLER_PRIVATE_ACCESS';end if;
 -- Reproduce old grant without tier -> Pro. Only new registration may renew.
 -- These temporary licence mutations are inside the same rolled-back QA fixture.
 perform set_config('request.jwt.claim.sub','4e500fbf-a8a4-4a41-8928-06d222962a5c',true);
 update public.native_staging_licenses_v1 set plan_tier=null where negocio_id='96000000-0000-4000-8000-000000000001';
 execute 'set local role authenticated';
 r:=public.native_registrar_instalacion_v1('96900000-0000-4000-8000-000000000021','96000000-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000003','96900000-0000-4000-8000-000000000002','BRANCH','96000002-0000-4000-8000-000000000001');
 execute 'reset role';
 if r->'license' ? 'planTier' then raise exception 'QA_OLD_TIER_FABRICATED';end if;
 update public.native_staging_licenses_v1 set plan_tier='pro' where negocio_id='96000000-0000-4000-8000-000000000001';
 execute 'set local role authenticated';denied:=false;
 begin perform public.native_registrar_instalacion_v1('96900000-0000-4000-8000-000000000021','96000000-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000003','96900000-0000-4000-8000-000000000002','BRANCH','96000002-0000-4000-8000-000000000001');
 exception when insufficient_privilege then if sqlerrm='NATIVE_POLICY_CHANGED' then denied:=true;else raise;end if;end;
 r:=public.native_registrar_instalacion_v1('96900000-0000-4000-8000-000000000022','96000000-0000-4000-8000-000000000001','96900000-0000-4000-8000-000000000003','96900000-0000-4000-8000-000000000002','BRANCH','96000002-0000-4000-8000-000000000001');
 execute 'reset role';
 if not denied or r->'license'->>'planTier'<>'pro' or r->>'writerEpoch'<>'1' or r->>'installationId'<>'96900000-0000-4000-8000-000000000003' then raise exception 'QA_POLICY_RENEWAL_FAILED';end if;
end $run$;
rollback;
select 'PASS' as result,'Staging PostgreSQL transaction; authenticated DB role with synthetic sub; all test writes rolled back' as coverage;
