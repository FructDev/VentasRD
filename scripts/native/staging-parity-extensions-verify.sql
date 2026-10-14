-- Authorized Staging QA only. No adoption, fixtures or business mutation.
begin transaction isolation level repeatable read read only;
do $verify$
declare x record;n uuid;checked integer:=0;answer jsonb;
begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'STAGING_GUARD_FAILED';end if;
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='native_product_metadata_v1' and column_name='photo') or pg_catalog.to_regclass('public.native_service_refunds_v1') is null then raise exception 'EXTENSIONS_MISSING';end if;
 if not exists(select 1 from pg_catalog.pg_constraint where conrelid='public.seriales'::regclass and contype='c' and pg_catalog.pg_get_constraintdef(oid) like '%merma%') then raise exception 'SERIAL_LOSS_MISSING';end if;
 if pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.native_inventory_submit_v1(text,text,text,text)'::regprocedure),'serialChanges')=0 or pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.native_web_cutover_v1(text,text)'::regprocedure),'legacyCashHistoryConfirmed')=0 then raise exception 'EXTENSIONS_FUNCTIONS_MISSING';end if;
 if pg_catalog.has_function_privilege('authenticated','public.native_service_refund_submit_v1(text,text,text,text)','EXECUTE') or pg_catalog.has_function_privilege('anon','public.native_sales_submit_v1(text,text,text,text)','EXECUTE') or pg_catalog.has_function_privilege('authenticated','public.native_product_photo_metadata_v1(uuid,uuid)','EXECUTE') or pg_catalog.has_table_privilege('authenticated','public.native_service_refunds_v1','INSERT') then raise exception 'EXTENSIONS_ACL_INVALID';end if;
 foreach n in array array['96000000-0000-4000-8000-000000000001'::uuid,'96000000-0000-4000-8000-000000000002'::uuid] loop
  for x in select i.*,a.actor_id from public.native_installations_v1 i join public.native_actor_sequences_v1 a using(negocio_id,installation_id) where i.negocio_id=n and i.status='REGISTERED' loop
   perform pg_catalog.set_config('request.jwt.claim.sub',x.actor_id::text,true);
   execute 'set local role authenticated';
   answer:=public.native_sales_lookup_v1(n,x.installation_id,x.device_id,x.writer_epoch,x.scope_kind,x.sucursal_id,'96009999-0000-4000-8000-000000000096','0000000000000000000000000000000000000000000000000000000000000000');
   execute 'reset role';
   if answer->>'status'<>'NOT_FOUND' then raise exception 'EXTENSIONS_CONTEXT_INVALID';end if;
   checked:=checked+1;
  end loop;
 end loop;
 if checked=0 then raise exception 'EXTENSIONS_NO_EXISTING_CONTEXT';end if;
 perform pg_catalog.set_config('ventard.extensions_contexts',checked::text,true);
end $verify$;
select 'PARITY_EXTENSIONS_READONLY_PASS' as status,pg_catalog.current_setting('ventard.extensions_contexts')::integer as registered_contexts_checked;
rollback;
