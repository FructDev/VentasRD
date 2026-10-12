-- Compatibility repair for the authorized Staging layaway implementation.
-- Baseline seriales_estado_check only allowed disponible/vendido.
begin;
do $guard$ begin
 if (select count(*) from public.negocios where
 (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or
 (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2
 or pg_catalog.to_regprocedure('public.native_layaways_submit_v1(text,text,text,text)') is null
 then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;
end $guard$;
alter table public.seriales drop constraint if exists seriales_estado_check;
alter table public.seriales add constraint seriales_estado_check
 check (estado in ('disponible','vendido','apartado'));
commit;
