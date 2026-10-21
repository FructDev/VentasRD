-- Online administration for existing authorized native businesses only.
-- DDL does not enroll, migrate, activate or modify any business or NCF.
begin;
create table if not exists public.native_admin_operations_v1(
 negocio_id uuid not null references public.negocios(id),operation_id uuid not null,
 actor_id uuid not null,request_hash text not null,result jsonb not null,
 primary key(negocio_id,operation_id)
);
alter table public.native_admin_operations_v1 enable row level security;
revoke all on public.native_admin_operations_v1 from public,anon,authenticated;
create or replace function public.native_business_admin_v1(p_context jsonb,p_action text,p_operation_id uuid default null,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare n uuid;h text;prior public.native_admin_operations_v1%rowtype;result jsonb;branch_id uuid;name text;address text;
begin
 n:=public.native_team_context_v1(p_context);
 if p_action='READ' then
  if p_operation_id is not null or p_payload<>'{}'::jsonb then raise exception 'ADMIN_INVALID';end if;
  return pg_catalog.jsonb_build_object('tenantId',n,'branchId',p_context->'branchId','branches',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.nombre,'address',s.direccion) order by s.fecha_creacion,s.id) from public.sucursales s where s.negocio_id=n),'[]'::jsonb),'pinConfigured',exists(select 1 from public.negocios where id=n and coalesce(pin_admin,'')<>''));
 end if;
 if p_operation_id is null or p_action not in('CREATE_BRANCH','SET_ADMIN_PIN') or p_action is null or p_payload is null or pg_catalog.jsonb_typeof(p_payload)<>'object' then raise exception 'ADMIN_INVALID';end if;
 h:=public.native_sales_hash_v1(p_action||':'||p_payload::text);
 select * into prior from public.native_admin_operations_v1 where negocio_id=n and operation_id=p_operation_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.request_hash<>h then raise exception 'ADMIN_ID_CONFLICT';end if;
  return prior.result;
 end if;
 if p_action='CREATE_BRANCH' then
  if not(p_payload ?& array['id','name','address']) or (select count(*) from jsonb_object_keys(p_payload))<>3 then raise exception 'ADMIN_INVALID';end if;
  branch_id:=(p_payload->>'id')::uuid;name:=pg_catalog.btrim(p_payload->>'name');address:=pg_catalog.btrim(p_payload->>'address');
  if branch_id is null or name is null or pg_catalog.length(name) not between 1 and 120 or address is null or pg_catalog.length(address)>500 then raise exception 'ADMIN_INVALID';end if;
  if exists(select 1 from public.sucursales where id=branch_id or (negocio_id=n and pg_catalog.lower(pg_catalog.btrim(nombre))=pg_catalog.lower(name))) then raise exception 'ADMIN_BRANCH_EXISTS';end if;
  insert into public.native_sales_write_context_v1 values(pg_catalog.txid_current(),n) on conflict do nothing;
  insert into public.sucursales(id,negocio_id,nombre,direccion,fecha_creacion) values(branch_id,n,name,address,pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint);
  delete from public.native_sales_write_context_v1 where transaction_id=pg_catalog.txid_current() and negocio_id=n;
  result:=pg_catalog.jsonb_build_object('status','APPLIED','operationId',p_operation_id,'branchId',branch_id);
 else
  if (select count(*) from jsonb_object_keys(p_payload))<>1 or p_payload->>'pinHash' is null or p_payload->>'pinHash'!~'^[a-f0-9]{64}$' then raise exception 'ADMIN_INVALID';end if;
  update public.negocios set pin_admin=p_payload->>'pinHash' where id=n;
  result:=pg_catalog.jsonb_build_object('status','APPLIED','operationId',p_operation_id);
 end if;
 insert into public.native_admin_operations_v1 values(n,p_operation_id,auth.uid(),h,result);
 return result;
end $f$;
revoke all on function public.native_business_admin_v1(jsonb,text,uuid,jsonb) from public,anon;
grant execute on function public.native_business_admin_v1(jsonb,text,uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
