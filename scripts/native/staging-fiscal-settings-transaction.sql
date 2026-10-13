-- Authorized only for Staging blzzinivvzadqjbnpsre and synthetic QA A/B.
-- All test writes roll back. Authenticated DB role/sub fixture, not a user login.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'QA_GUARD_FAILED';end if;
 if exists(select 1 from public.native_installations_v1 where installation_id::text like '97310000-%') or exists(select 1 from public.native_fiscal_settings_ledger_v1 where request_id::text like '97340000-%') then raise exception 'QA_FIXTURE_ID_EXISTS';end if;
end $guard$;
create temporary table qa_fiscal_results(tenant uuid,status text);
do $test$
declare qa record;idx integer:=0;i uuid;d uuid;g uuid;k text;b uuid;v jsonb;c jsonb;t text;h text;r jsonb;bad jsonb;blocked boolean;
begin
 for qa in select n.id,(to_jsonb(n)->>'dueño_id')::uuid actor,m.scope_kind,m.sucursal_id from public.negocios n left join public.native_sales_mode_v1 m on m.negocio_id=n.id where n.id in('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002') order by n.id loop
  idx:=idx+1;i:=('97310000-0000-4000-8000-'||lpad(idx::text,12,'0'))::uuid;d:=('97320000-0000-4000-8000-'||lpad(idx::text,12,'0'))::uuid;g:=('97330000-0000-4000-8000-'||lpad(idx::text,12,'0'))::uuid;k:=coalesce(qa.scope_kind,'GLOBAL');b:=qa.sucursal_id;
  perform set_config('request.jwt.claim.sub',qa.actor::text,true);execute 'set local role authenticated';
  perform public.native_registrar_instalacion_v1(g,qa.id,i,d,k,b);
  if qa.scope_kind is null then
   blocked:=false;begin perform public.native_fiscal_settings_read_v1(qa.id,i,d,1,k,b);exception when others then if sqlerrm='NATIVE_ACTIVATION_REQUIRED' then blocked:=true;else raise;end if;end;
   execute 'reset role';if not blocked then raise exception 'QA_UNADOPTED_FISCAL_ACCEPTED';end if;insert into qa_fiscal_results values(qa.id,'UNADOPTED_DENIED');continue;
  end if;
  execute 'reset role';
  perform pg_advisory_xact_lock(hashtextextended('native-fiscal:'||qa.id::text,0));
  insert into public.native_sales_write_context_v1 values(txid_current(),qa.id);
  insert into public.ncf_secuencias values(qa.id,'B02',1,999,41,false) on conflict(negocio_id) do update set tipo='B02',desde=1,hasta=999,proximo=41,habilitado=false;
  delete from public.native_sales_write_context_v1 where transaction_id=txid_current() and negocio_id=qa.id;
  execute 'set local role authenticated';
  c:=public.native_fiscal_settings_read_v1(qa.id,i,d,1,k,b)->'configuration';
  v:=jsonb_build_object('protocol','ventard.fiscal.settings.request.1','version','1','requestId','97340000-0000-4000-8000-'||lpad(idx::text,12,'0'),'actorId',qa.actor,'tenantId',qa.id,'installationId',i,'deviceId',d,'writerEpoch','1','scopeType',k,'branchId',b,'permissionGrantId',g,'expectedRevision',c->>'revision','type','B02','first','1','last','1000','enabled',true);
  execute 'reset role';t:=public.native_sales_canonical_v1(v);h:=public.native_sales_hash_v1(t);execute 'set local role authenticated';
  if public.native_fiscal_settings_lookup_v1(t,h) is distinct from jsonb_build_object('status','NOT_FOUND','requestId',v->>'requestId','payloadHash',h) then raise exception 'QA_NEGATIVE_LOOKUP_INVALID';end if;
  r:=public.native_fiscal_settings_submit_v1(t,h);
  if r->>'status'<>'APPLIED' or r->'configuration'->>'next'<>'41' or r is distinct from public.native_fiscal_settings_submit_v1(t,h) or r is distinct from public.native_fiscal_settings_lookup_v1(t,h) or r is distinct from public.native_fiscal_settings_abandon_v1(t,h) then raise exception 'QA_FISCAL_REPLAY_FAILED';end if;
  bad:=v||jsonb_build_object('requestId','97340000-0000-4000-8000-000000000010','enabled',false);execute 'reset role';t:=public.native_sales_canonical_v1(bad);h:=public.native_sales_hash_v1(t);execute 'set local role authenticated';blocked:=false;
  begin perform public.native_fiscal_settings_submit_v1(t,h);exception when others then if sqlerrm='FISCAL_SETTINGS_VERSION_CONFLICT' then blocked:=true;else raise;end if;end;if not blocked then raise exception 'QA_STALE_ACCEPTED';end if;
  bad:=v||jsonb_build_object('last','2000');execute 'reset role';t:=public.native_sales_canonical_v1(bad);h:=public.native_sales_hash_v1(t);execute 'set local role authenticated';blocked:=false;
  begin perform public.native_fiscal_settings_lookup_v1(t,h);exception when others then if sqlerrm='FISCAL_SETTINGS_ID_CONFLICT' then blocked:=true;else raise;end if;end;if not blocked then raise exception 'QA_CHANGED_BYTES_ACCEPTED';end if;
  v:=v||jsonb_build_object('requestId','97340000-0000-4000-8000-000000000011','enabled',false,'expectedRevision',r->'configuration'->>'revision');execute 'reset role';t:=public.native_sales_canonical_v1(v);h:=public.native_sales_hash_v1(t);execute 'set local role authenticated';r:=public.native_fiscal_settings_submit_v1(t,h);
  if r->'configuration'->>'next'<>'41' or r->'configuration'->'enabled'<>'false'::jsonb then raise exception 'QA_DISABLED_RESET_CURSOR';end if;
  v:=v||jsonb_build_object('requestId','97340000-0000-4000-8000-000000000012','type','B01','expectedRevision',r->'configuration'->>'revision');execute 'reset role';t:=public.native_sales_canonical_v1(v);h:=public.native_sales_hash_v1(t);execute 'set local role authenticated';blocked:=false;
  begin perform public.native_fiscal_settings_submit_v1(t,h);exception when others then if sqlerrm='FISCAL_SETTINGS_KIND_TRANSITION_REQUIRED' then blocked:=true;else raise;end if;end;if not blocked then raise exception 'QA_KIND_CURSOR_DISCARDED';end if;
  r:=public.native_fiscal_settings_abandon_v1(t,h);if r->>'status'<>'ABANDONED' or public.native_fiscal_settings_submit_v1(t,h) is distinct from r then raise exception 'QA_ABANDON_RESUBMITTED';end if;
  execute 'reset role';
  if (select proximo from public.ncf_secuencias where negocio_id=qa.id)<>41 or (select count(*) from public.native_fiscal_settings_ledger_v1 where negocio_id=qa.id and request_id::text like '97340000-%')<>3 then raise exception 'QA_FISCAL_EFFECT_INVALID';end if;
  insert into qa_fiscal_results values(qa.id,'APPLY_REPLAY_CURSOR_CAS_ABANDON_PASS');
 end loop;
end $test$;
select jsonb_build_object('status','PASS','writes','ROLLBACK','authentication','authenticated DB role with synthetic JWT sub','qa',(select jsonb_agg(jsonb_build_object('tenant',tenant,'status',status)) from qa_fiscal_results)) as fiscal_settings_result;
rollback;
