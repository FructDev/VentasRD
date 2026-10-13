-- Existing Staging reader permissions only. Never insert fixtures or contexts.
begin transaction isolation level repeatable read read only;
do $verify$
declare n uuid;installation record;probe jsonb;entry record;contexts integer:=0;sample_rows integer:=0;raw_ledger jsonb:='[]'::jsonb;
begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 then raise exception 'WEB_STAGING_GUARD_FAILED';end if;
 if pg_catalog.to_regclass('public.inventario_operaciones_v2') is null then raise exception 'INVENTORY_LEDGER_UNAVAILABLE';end if;
 if not pg_catalog.has_table_privilege('authenticated','public.inventario_operaciones_v2','SELECT')
 or pg_catalog.has_table_privilege('authenticated','public.inventario_operaciones_v2','INSERT,UPDATE,DELETE,TRUNCATE') then raise exception 'INVENTORY_LEDGER_ACL_INVALID';end if;
 foreach n in array array['96000000-0000-4000-8000-000000000001'::uuid,'96000000-0000-4000-8000-000000000002'::uuid] loop
  select x.*,a.actor_id into installation from public.native_installations_v1 x join public.native_actor_sequences_v1 a using(negocio_id,installation_id) join public.negocios business on business.id=x.negocio_id
  where x.negocio_id=n and x.status='REGISTERED' and (a.actor_id=business."dueño_id" or exists(select 1 from public.usuarios_negocio un where un.negocio_id=n and un.user_id=a.actor_id and un.activo and un.rol='admin')) order by x.installation_id,a.actor_id limit 1;
  if not found then continue;end if;
  perform pg_catalog.set_config('request.jwt.claim.sub',installation.actor_id::text,true);
  execute 'set local role authenticated';
  probe:=public.native_web_observe_v1(n,installation.installation_id,installation.device_id,installation.writer_epoch,installation.scope_kind,installation.sucursal_id,'96409999-0000-4000-8000-000000000098','movimientos_stock',array['96409999-0000-4000-8000-000000000099']);
  if probe->>'tenantId' is distinct from n::text or probe->>'actorId' is distinct from installation.actor_id::text or probe->>'writerEpoch' is distinct from installation.writer_epoch::text then raise exception 'INVENTORY_LEDGER_CONTEXT_DENIED';end if;
  for entry in select l.* from public.inventario_operaciones_v2 l where l.negocio_id=n and l.authority_kind=installation.scope_kind and l.sucursal_id is not distinct from installation.sucursal_id order by l.operacion_id limit 100 loop
   if entry.payload_version<>2 or entry.payload_hash!~'^[0-9a-f]{64}$' or entry.remote_sequence<=0
   or (entry.effect_kind='DELTA' and (entry.stock_before::bigint+entry.effect_value::bigint<>entry.stock_after::bigint or entry.expected_remote_sequence is not null))
   or (entry.effect_kind='ABSOLUTE' and (entry.stock_after<>entry.effect_value or entry.expected_remote_sequence is distinct from entry.remote_sequence-1)) then raise exception 'INVENTORY_LEDGER_SAMPLE_INVALID';end if;
   sample_rows:=sample_rows+1;
   raw_ledger:=raw_ledger||pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(entry));
  end loop;
  execute 'reset role';contexts:=contexts+1;
 end loop;
 if contexts=0 then raise exception 'INVENTORY_LEDGER_NO_REAL_QA_CONTEXT';end if;
 perform pg_catalog.set_config('ventard.inventory_verify_contexts',contexts::text,true);
 perform pg_catalog.set_config('ventard.inventory_verify_rows',sample_rows::text,true);
 -- Optional native parser fixture capture is explicit and never printed by this
 -- verifier. Session-local read-only state disappears at rollback.
 perform pg_catalog.set_config('ventard.inventory_verify_raw',raw_ledger::text,true);
end $verify$;
select 'INVENTORY_LEDGER_READONLY_PASS' as status,
 pg_catalog.current_setting('ventard.inventory_verify_contexts')::integer as registered_contexts_checked,
 pg_catalog.current_setting('ventard.inventory_verify_rows')::integer as existing_rows_sampled;
rollback;
