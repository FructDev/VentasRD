-- Run ONLY after explicit approval/deployment on blzzinivvzadqjbnpsre.
-- Read-only transaction, synthetic A/B guard, authenticated RPC calls. No data
-- fixtures are inserted, no license/mode/grant/context is manufactured.
begin transaction isolation level repeatable read read only;
do $verify$
declare n uuid;installation record;table_name text;ids text[];answer jsonb;tables_checked integer:=0;contexts_checked integer:=0;
begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'WEB_STAGING_GUARD_FAILED';end if;
 if pg_catalog.to_regprocedure('public.native_web_observe_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,text,text[])') is null then raise exception 'WEB_OBSERVATION_MIGRATION_REQUIRED';end if;
 if pg_catalog.has_function_privilege('anon','public.native_web_observe_v1(uuid,uuid,uuid,bigint,text,uuid,uuid,text,text[])','EXECUTE') or pg_catalog.has_function_privilege('authenticated','public.native_web_observation_json_v1(jsonb,integer)','EXECUTE') then raise exception 'WEB_OBSERVATION_ACL_INVALID';end if;
 foreach n in array array['96000000-0000-4000-8000-000000000001'::uuid,'96000000-0000-4000-8000-000000000002'::uuid] loop
  select x.*,a.actor_id into installation from public.native_installations_v1 x join public.native_actor_sequences_v1 a using(negocio_id,installation_id) join public.negocios business on business.id=x.negocio_id
  where x.negocio_id=n and x.status='REGISTERED' and (a.actor_id=business."dueño_id" or exists(select 1 from public.usuarios_negocio un where un.negocio_id=n and un.user_id=a.actor_id and un.activo and un.rol='admin')) order by x.installation_id,a.actor_id limit 1;
  if not found then raise notice 'WEB_OBSERVATION_QA_CONTEXT_UNAVAILABLE %',n;continue;end if;
  perform pg_catalog.set_config('request.jwt.claim.sub',installation.actor_id::text,true);
  foreach table_name in array array['apartados','cajas','clientes','composiciones','cortes_caja','devoluciones','gastos','movimientos_stock','productos','reparaciones','seriales','sucursales','transacciones_fiado','venta_detalles','ventas'] loop
   execute pg_catalog.format('select coalesce(array_agg(id::text order by id),array[''96009999-0000-4000-8000-000000000099'']) from(select id from public.%I where negocio_id=$1 order by id limit 3) fixture',table_name) into ids using n;
   execute 'set local role authenticated';
   answer:=public.native_web_observe_v1(n,installation.installation_id,installation.device_id,installation.writer_epoch,installation.scope_kind,installation.sucursal_id,'96009999-0000-4000-8000-000000000098',table_name,ids);
   execute 'reset role';
   if answer->>'protocol'<>'ventard.web.observation.1' or answer->>'tenantId'<>n::text or answer->>'actorId'<>installation.actor_id::text or answer->>'coverage'<>'REQUESTED_IDS_ONLY' or exists(select 1 from pg_catalog.jsonb_array_elements(answer->'rows') r where r->>'negocio_id'<>n::text) then raise exception 'WEB_OBSERVATION_RESPONSE_INVALID';end if;
   tables_checked:=tables_checked+1;
  end loop;
  contexts_checked:=contexts_checked+1;
 end loop;
 if contexts_checked=0 then raise exception 'WEB_OBSERVATION_NO_REAL_QA_CONTEXT';end if;
 raise notice 'WEB_OBSERVATION_READONLY_PASS contexts=% tables=%; no payloads printed',contexts_checked,tables_checked;
end $verify$;
rollback;
