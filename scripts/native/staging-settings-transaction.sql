-- Authorized only in Staging blzzinivvzadqjbnpsre, synthetic QA A/B.
-- Real PostgreSQL with authenticated role and synthetic JWT sub. No end-user login.
-- Every fixture, business edit, snapshot and registration is rolled back.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where
  (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
  (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2
 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
 if exists(select 1 from public.native_installations_v1 where installation_id::text like '97010000-%')
 or exists(select 1 from public.native_sales_ledger_v1 where operation_id::text like '97040000-%')
 then raise exception 'QA_TEST_ID_ALREADY_EXISTS';end if;
end $guard$;
create temporary table qa_settings_checks(tenant uuid primary key,passed boolean);
do $test$
declare qa record;idx integer:=0;i uuid;device uuid;grant_id uuid;op uuid;old_snapshot uuid;new_snapshot uuid;
 def jsonb;doc jsonb;req jsonb;v jsonb;t text;hash text;receipt jsonb;replay jsonb;before_manifest jsonb;after_manifest jsonb;page jsonb;
 revision bigint;counter bigint;cash jsonb;bad text;denied boolean;
begin
 for qa in select n.id,n.nombre,(to_jsonb(n)->>'dueño_id')::uuid actor,m.scope_kind,m.sucursal_id
 from public.negocios n join public.native_sales_mode_v1 m on m.negocio_id=n.id
 where n.id in('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002') order by n.id loop
  idx:=idx+1;
  i:=('97010000-0000-4000-8000-'||lpad(idx::text,12,'0'))::uuid;
  device:=('97020000-0000-4000-8000-'||lpad(idx::text,12,'0'))::uuid;
  grant_id:=('97030000-0000-4000-8000-'||lpad(idx::text,12,'0'))::uuid;
  op:=('97040000-0000-4000-8000-'||lpad(idx::text,12,'0'))::uuid;
  old_snapshot:=('97050000-0000-4000-8000-'||lpad(idx::text,12,'0'))::uuid;
  new_snapshot:=('97060000-0000-4000-8000-'||lpad(idx::text,12,'0'))::uuid;
  perform set_config('request.jwt.claim.sub',qa.actor::text,true);
  execute 'set local role authenticated';
  perform public.native_registrar_instalacion_v1(grant_id,qa.id,i,device,qa.scope_kind,qa.sucursal_id);
  before_manifest:=public.native_sales_bootstrap_v1(qa.id,i,device,1,qa.scope_kind,qa.sucursal_id,old_snapshot);
  cash:=public.native_sales_feed_v1(qa.id,i,device,1,qa.scope_kind,qa.sucursal_id,0)->'cashBase'->'netCents';
  execute 'reset role';
  select coalesce((select s.revision from public.native_business_settings_v1 s where s.negocio_id=qa.id),0) into revision;
  select last_sequence into counter from public.native_sales_counter_v1 where negocio_id=qa.id;
  def:=jsonb_build_object('name','QA Ajustes ROLLBACK '||idx,'whatsapp','8095550100','phone','8095550101','rnc','131000001','address','Dirección sintética','footer','Gracias QA','logo',null,'color','turquesa','font','montserrat','bank',jsonb_build_object('name','Banco QA','account','001-000123','holder','Titular QA'));
  req:=jsonb_build_object('kind','BUSINESS_SAVE','operationId',op,'expectedRevision',revision::text,'definition',def);
  doc:=jsonb_build_object('operationId',op,'businessSettings',jsonb_build_object('revision',(revision+1)::text,'definition',def),'business',public.native_settings_profile_v1(def,revision+1,op),'amountCents','0','method',null,'concept','Configuración del negocio');
  v:=jsonb_build_object('protocol','ventard.native.v1','kind','CONFIG_PATCH','contractVersion',1,'canonicalizationVersion','C-N1','operationId',op,'negocioId',qa.id,'scope',jsonb_build_object('type',qa.scope_kind,'sucursalId',qa.sucursal_id),'originDeviceId',device,'installationId',i,'writerEpoch','1','actorId',qa.actor,'permissionGrantId',grant_id,'originalTurnId',null,'originAtUtcMs','1791842400000','expectedVersions','{}'::jsonb,'dependencies','[]'::jsonb,'payload',jsonb_build_object('request',req,'document',doc));
  t:=public.native_sales_canonical_v1(v);hash:=public.native_sales_hash_v1(t);
  bad:=public.native_sales_canonical_v1(jsonb_set(v,'{payload,document,business,name}','"FORGED"'));
  execute 'set local role authenticated';
  denied:=false;
  begin perform public.native_sales_submit_v1(bad,encode(sha256(convert_to(bad,'UTF8')),'hex'),null,null);
  exception when others then denied:=true;end;
  if not denied then raise exception 'QA_SETTINGS_TAMPER_ACCEPTED';end if;
  receipt:=public.native_sales_submit_v1(t,hash,null,null);
  replay:=public.native_sales_submit_v1(t,hash,null,null);
  if receipt is distinct from replay or receipt->'stock'<>'[]'::jsonb or jsonb_array_length(receipt->'effects')<>1 or receipt->'effects'->0->>'kind'<>'CONFIG_PATCH' then raise exception 'QA_SETTINGS_REPLAY_FAILED';end if;
  if public.native_sales_bootstrap_v1(qa.id,i,device,1,qa.scope_kind,qa.sucursal_id,old_snapshot) is distinct from before_manifest then raise exception 'QA_SETTINGS_CAPTURE_REWRITTEN';end if;
  after_manifest:=public.native_sales_bootstrap_v1(qa.id,i,device,1,qa.scope_kind,qa.sucursal_id,new_snapshot);
  page:=public.native_sales_feed_v1(qa.id,i,device,1,qa.scope_kind,qa.sucursal_id,(receipt->>'remoteSequence')::bigint);
  if after_manifest->'businessSettings'->'receipt' is distinct from receipt then raise exception 'QA_SETTINGS_CAPTURE_RECEIPT_FAILED';end if;
  if after_manifest->'business' is distinct from doc->'business' then raise exception 'QA_SETTINGS_CAPTURE_HEADER_FAILED';end if;
  if page->'businessSettings'->'receipt' is distinct from receipt then raise exception 'QA_SETTINGS_FEED_RECEIPT_FAILED';end if;
  if page->'cashBase'->'netCents' is distinct from cash then raise exception 'QA_SETTINGS_CASH_CHANGED';end if;
  execute 'reset role';
  if (select count(*) from public.native_sales_ledger_v1 where negocio_id=qa.id and operation_id=op)<>1 or (select last_sequence from public.native_sales_counter_v1 where negocio_id=qa.id)<>counter+1 or (select nombre from public.negocios where id=qa.id)<>qa.nombre then raise exception 'QA_SETTINGS_UNEXPECTED_EFFECT';end if;
  insert into qa_settings_checks values(qa.id,true);
 end loop;
 if idx<1 then raise exception 'QA_SETTINGS_ACTIVE_MODE_REQUIRED';end if;
end $test$;
-- QA B has no adopted native mode. Test the actual activation guard; never
-- fabricate quiescence/activation to make this fixture appear operational.
do $unadopted$
declare n uuid:='96000000-0000-4000-8000-000000000002';actor uuid;i uuid:='97010000-0000-4000-8000-000000000003';device uuid:='97020000-0000-4000-8000-000000000003';grant_id uuid:='97030000-0000-4000-8000-000000000003';op uuid:='97040000-0000-4000-8000-000000000003';v jsonb;def jsonb;doc jsonb;req jsonb;t text;blocked boolean:=false;
begin
 if exists(select 1 from public.native_sales_mode_v1 where negocio_id=n) then return;end if;
 select (to_jsonb(g)->>'dueño_id')::uuid into actor from public.negocios g where id=n;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 execute 'set local role authenticated';
 perform public.native_registrar_instalacion_v1(grant_id,n,i,device,'GLOBAL',null);
 execute 'reset role';
 def:=jsonb_build_object('name','QA B blocked fixture','whatsapp','','phone','','rnc','','address','','footer','','logo',null,'color','dorado','font','syne','bank',null);
 req:=jsonb_build_object('kind','BUSINESS_SAVE','operationId',op,'expectedRevision','0','definition',def);
 doc:=jsonb_build_object('operationId',op,'businessSettings',jsonb_build_object('revision','1','definition',def),'business',public.native_settings_profile_v1(def,1,op),'amountCents','0','method',null,'concept','Configuración del negocio');
 v:=jsonb_build_object('protocol','ventard.native.v1','kind','CONFIG_PATCH','contractVersion',1,'canonicalizationVersion','C-N1','operationId',op,'negocioId',n,'scope',jsonb_build_object('type','GLOBAL','sucursalId',null),'originDeviceId',device,'installationId',i,'writerEpoch','1','actorId',actor,'permissionGrantId',grant_id,'originalTurnId',null,'originAtUtcMs','1791842400000','expectedVersions','{}'::jsonb,'dependencies','[]'::jsonb,'payload',jsonb_build_object('request',req,'document',doc));
 t:=public.native_sales_canonical_v1(v);
 execute 'set local role authenticated';
 begin perform public.native_sales_submit_v1(t,encode(sha256(convert_to(t,'UTF8')),'hex'),null,null);
 exception when others then if sqlerrm='NATIVE_ACTIVATION_REQUIRED' then blocked:=true;else raise;end if;end;
 execute 'reset role';
 if not blocked or exists(select 1 from public.native_sales_ledger_v1 where negocio_id=n and operation_id=op) then raise exception 'QA_UNADOPTED_SETTINGS_ACCEPTED';end if;
 insert into qa_settings_checks values(n,true);
end $unadopted$;
select jsonb_build_object('qaBusinesses',(select count(*) from qa_settings_checks),'status','PASS','writes','ROLLBACK','authentication','authenticated DB role with synthetic JWT sub','qaB','settings denied until real native adoption') as settings_transaction_result;
rollback;
