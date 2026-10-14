-- Staging QA only; does not activate businesses or replay commercial data.
begin;
do $guard$ begin if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2 or pg_catalog.to_regprocedure('public.native_inventory_submit_v1(text,text,text,text)') is null then raise exception 'NATIVE_STAGING_GUARD_FAILED';end if;end $guard$;
alter table public.native_product_metadata_v1 add column if not exists photo jsonb;
alter table public.productos add column if not exists imagen_url text;
create or replace function public.native_product_photo_validate_v1(d jsonb) returns void language plpgsql set search_path='' as $f$
declare v text;encoded text;data bytea;w bigint;h bigint;
begin
 perform public.native_sales_object_v1(d,array['data']);
 if d->'data'<>'null'::jsonb then
  v:=d->>'data';if pg_catalog.jsonb_typeof(d->'data') is distinct from 'string' or pg_catalog.left(v,22)<>'data:image/png;base64,' or pg_catalog.length(v)>131094 then raise exception 'NATIVE_PRODUCT_PHOTO_INVALID';end if;
  encoded:=pg_catalog.substr(v,23);if encoded !~ '^[A-Za-z0-9+/]*={0,2}$' then raise exception 'NATIVE_PRODUCT_PHOTO_INVALID';end if;
  data:=pg_catalog.decode(encoded,'base64');
  if pg_catalog.octet_length(data) not between 45 and 98304 or pg_catalog.replace(pg_catalog.encode(data,'base64'),E'\n','')<>encoded or pg_catalog.encode(pg_catalog.substr(data,1,16),'hex')<>'89504e470d0a1a0a0000000d49484452' or pg_catalog.encode(pg_catalog.substr(data,pg_catalog.octet_length(data)-11),'hex')<>'0000000049454e44ae426082' then raise exception 'NATIVE_PRODUCT_PHOTO_INVALID';end if;
  w:=pg_catalog.get_byte(data,16)::bigint*16777216+pg_catalog.get_byte(data,17)*65536+pg_catalog.get_byte(data,18)*256+pg_catalog.get_byte(data,19);
  h:=pg_catalog.get_byte(data,20)::bigint*16777216+pg_catalog.get_byte(data,21)*65536+pg_catalog.get_byte(data,22)*256+pg_catalog.get_byte(data,23);
  if w not between 1 and 480 or h not between 1 and 480 or pg_catalog.get_byte(data,24)<>8 or pg_catalog.get_byte(data,25) not in(2,6) or pg_catalog.encode(pg_catalog.substr(data,27,3),'hex')<>'000000' then raise exception 'NATIVE_PRODUCT_PHOTO_INVALID';end if;
 end if;
end $f$;
revoke all on function public.native_product_photo_validate_v1(jsonb) from public,anon,authenticated;
create or replace function public.native_product_photo_metadata_v1(n uuid,pid uuid) returns jsonb language sql stable security definer set search_path='' as $f$
 select case when m.photo is not null then pg_catalog.jsonb_build_object('photo',m.photo)
 when p.imagen_url like 'data:image/png;base64,%' then pg_catalog.jsonb_build_object('photo',pg_catalog.jsonb_build_object('data',p.imagen_url))
 when coalesce(p.imagen_url,'')<>'' then pg_catalog.jsonb_build_object('photo',pg_catalog.jsonb_build_object('data',null,'source',p.imagen_url)) else '{}'::jsonb end
 from public.productos p left join public.native_product_metadata_v1 m on m.negocio_id=p.negocio_id and m.producto_id=p.id where p.negocio_id=n and p.id=pid;
$f$;
revoke all on function public.native_product_photo_metadata_v1(uuid,uuid) from public,anon,authenticated;
do $patch$ declare source text;needle text;begin
 select pg_catalog.pg_get_functiondef('public.native_inventory_submit_v1(text,text,text,text)'::regprocedure) into source;
 if pg_catalog.strpos(source,'native_product_photo_validate_v1')=0 then
  needle:='perform public.native_sales_object_v1(def,array[''name'',''code'',''priceCents'',''tier2Cents'',''tier3Cents'',''costCents'',''taxPercent'',''productType'',''location'',''minimum'',''serialRequired'',''recipe'']);';
  if pg_catalog.strpos(source,needle)=0 then raise exception 'NATIVE_PHOTO_PARENT_INCOMPATIBLE';end if;
  source:=pg_catalog.replace(source,needle,'perform public.native_sales_object_v1(def,case when def ? ''photo'' then array[''name'',''code'',''priceCents'',''tier2Cents'',''tier3Cents'',''costCents'',''taxPercent'',''productType'',''location'',''minimum'',''serialRequired'',''recipe'',''photo''] else array[''name'',''code'',''priceCents'',''tier2Cents'',''tier3Cents'',''costCents'',''taxPercent'',''productType'',''location'',''minimum'',''serialRequired'',''recipe''] end);if def ? ''photo'' then perform public.native_product_photo_validate_v1(def->''photo'');end if;');
  source:=pg_catalog.replace(source,'insert into public.native_product_metadata_v1 values(','insert into public.native_product_metadata_v1(negocio_id,producto_id,revision,location,minimum) values(');
  needle:='expected:=pg_catalog.jsonb_build_object(''product'',pg_catalog.jsonb_build_object(''id'',pid,''name'',name';
  if pg_catalog.strpos(source,needle)=0 then raise exception 'NATIVE_PHOTO_PARENT_INCOMPATIBLE';end if;
  source:=pg_catalog.replace(source,needle,'meta:=meta||case when def ? ''photo'' then pg_catalog.jsonb_build_object(''photo'',def->''photo'') when kind=''PRODUCT_PATCH'' then public.native_product_photo_metadata_v1(n,pid) else ''{}''::jsonb end;'||needle);
  needle:='do update set revision=excluded.revision,location=excluded.location,minimum=excluded.minimum;';
  source:=pg_catalog.replace(source,needle,needle||'if def ? ''photo'' then update public.native_product_metadata_v1 set photo=def->''photo'' where negocio_id=n and producto_id=pid;update public.productos set imagen_url=def->''photo''->>''data'' where negocio_id=n and id=pid;end if;');execute source;
 end if;
 for source in select pg_catalog.pg_get_functiondef(p.oid) from pg_catalog.pg_proc p join pg_catalog.pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname like 'native_sales_bootstrap%' and pg_catalog.strpos(p.prosrc,'''PRODUCT''')>0 loop
  if pg_catalog.strpos(source,'native_product_photo_metadata_v1')=0 and pg_catalog.strpos(source,'''metadata'',pg_catalog.jsonb_build_object(''costCents''')>0 then
   source:=pg_catalog.replace(source,'''metadata'',pg_catalog.jsonb_build_object(''costCents''','''metadata'',public.native_product_photo_metadata_v1(p_negocio_id,p.id)||pg_catalog.jsonb_build_object(''costCents''');
   -- Split by bytes and row count, preserving order and the 1 MiB IPC cap.
   needle:='for batch in select pg_catalog.jsonb_agg(value order by ordinality) from pg_catalog.jsonb_array_elements(rows) with ordinality group by ((ordinality-1)/200) order by ((ordinality-1)/200) loop';
   if pg_catalog.strpos(source,needle)=0 then raise exception 'NATIVE_PHOTO_BOOTSTRAP_PARENT_INCOMPATIBLE';end if;
   source:=pg_catalog.replace(source,needle,'for batch in select pg_catalog.jsonb_agg(value order by ordinality) from (select value,ordinality,pg_catalog.sum(pg_catalog.octet_length(public.native_sales_canonical_v1(value))+1) over(order by ordinality) bytes from pg_catalog.jsonb_array_elements(rows) with ordinality) sized group by ((bytes-1)/800000),((ordinality-1)/200) order by pg_catalog.min(ordinality) loop');execute source;
  end if;
 end loop;
end $patch$;
commit;
