-- Authorized NEW test business only, run with an explicit Staging project-ref.
-- No Auth users, PINs, operational contexts, sales, balances or NCF are created.
begin;
do $pilot$
declare n constant uuid:='96000000-0000-4000-8000-000000000003';
 b constant uuid:='96000003-0000-4000-8000-000000000003';
 owner_id constant uuid:='a1d0532d-df26-43bf-b8b2-5a99de7ab101';
 at_ms bigint:=pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp())*1000)::bigint;
 until_ms bigint;created uuid;r record;pid uuid;
begin
 if (select count(*) from public.negocios where (id='96000000-0000-4000-8000-000000000001' and nombre='PRO00 QA A - SINTETICO') or (id='96000000-0000-4000-8000-000000000002' and nombre='PRO00 QA B - SINTETICO'))<>2
 or not exists(select 1 from auth.users where id=owner_id and email='pro00-admin-a@example.test')
 or not exists(select 1 from public.usuarios_negocio where negocio_id='96000000-0000-4000-8000-000000000001' and user_id=owner_id and rol='admin' and activo)
 then raise exception 'PILOT_STAGING_IDENTITY_GUARD_FAILED';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-pilot-create:'||n::text,0));
 if exists(select 1 from public.negocios where id=n) then
  if not exists(select 1 from public.negocios where id=n and "dueño_id"=owner_id and nota_operador='STAGING_NEW_PILOT_V1')
  or not exists(select 1 from public.sucursales where id=b and negocio_id=n) then raise exception 'PILOT_ALREADY_EXISTS_DIFFERENT';end if;
  -- Re-running setup never resets stock, names, money, expiry or later work.
  return;
 end if;
 if exists(select 1 from public.negocios where "dueño_id"=owner_id) then raise exception 'PILOT_OWNER_ALREADY_HAS_BUSINESS';end if;
 until_ms:=at_ms+2592000000;
 insert into public.negocios(id,nombre,"dueño_id",onboarding_completado,tipo_negocio,direccion,nota_operador,plan_activo,plan_tier,acceso_hasta,trial_hasta,mensaje_ticket,catalogo_publico)
 values(n,'Comercial La Esquina — PILOTO STAGING',owner_id,true,'colmado','Local de prueba — sin dirección real','STAGING_NEW_PILOT_V1',true,'pro',until_ms,until_ms,'PILOTO STAGING · Comprobante de prueba',false) returning id into created;
 if created is distinct from n then raise exception 'PILOT_CREATE_FAILED';end if;
 insert into public.sucursales(id,negocio_id,nombre,direccion,fecha_creacion) values(b,n,'Local Principal','Sucursal de prueba',at_ms);
 insert into public.native_staging_licenses_v1(negocio_id,plan_active,plan_tier,access_until_ms,trial_until_ms) values(n,true,'pro',until_ms,until_ms);
 for r in select * from (values
 (1,'Arroz 1 libra',75.00,55.00,40,0.00),
 (2,'Habichuelas 1 libra',95.00,70.00,24,0.00),
 (3,'Aceite 16 oz',210.00,170.00,18,0.18),
 (4,'Azúcar 1 libra',40.00,28.00,30,0.00),
 (5,'Sal 1 libra',25.00,15.00,20,0.00),
 (6,'Agua 500 ml',25.00,15.00,48,0.18),
 (7,'Refresco 600 ml',75.00,50.00,24,0.18),
 (8,'Leche 1 litro',80.00,60.00,24,0.00),
 (9,'Café 1 paquete',150.00,110.00,16,0.18),
 (10,'Jabón de lavar',65.00,40.00,20,0.18),
 (11,'Galletas 1 paquete',35.00,22.00,36,0.18),
 (12,'Pilas AA 2 unidades',120.00,80.00,12,0.18)
 ) as items(number,name,price,cost,quantity,tax) loop
  pid:=('96000003-0000-4000-8001-'||pg_catalog.lpad(r.number::text,12,'0'))::uuid;
  insert into public.productos(id,negocio_id,nombre,codigo_barras,precio_venta,costo,stock_actual,stock_minimo,tasa_itbis,tipo,serializable,eliminado,fecha_actualizacion,ubicacion)
  values(pid,n,r.name||' [PILOTO]','PILOTO-'||pg_catalog.lpad(r.number::text,3,'0'),r.price,r.cost,r.quantity,3,r.tax,'simple',false,false,at_ms,'PRUEBA');
  insert into public.inventario_sucursales(sucursal_id,producto_id,stock_actual,stock_minimo,fecha_actualizacion) values(b,pid,r.quantity,3,at_ms);
 end loop;
 insert into public.clientes(id,negocio_id,nombre,limite_credito,fecha_actualizacion,sucursal_id,tipo_precio,eliminado) values
 ('96000003-0000-4000-8002-000000000001',n,'Ana — CLIENTE DE PRUEBA',3000.00,at_ms,b,1,false),
 ('96000003-0000-4000-8002-000000000002',n,'Luis — CLIENTE DE PRUEBA',5000.00,at_ms,b,1,false);
end $pilot$;
select 'STAGING_NEW_PILOT_READY' as status,n.id,n.nombre,
 (select count(*) from public.productos p where p.negocio_id=n.id) as products,
 (select count(*) from public.clientes c where c.negocio_id=n.id) as customers,
 (select count(*) from public.native_installations_v1 i where i.negocio_id=n.id) as registered_installations,
 (select count(*) from public.native_sales_ledger_v1 l where l.negocio_id=n.id) as native_operations
from public.negocios n where n.id='96000000-0000-4000-8000-000000000003';
commit;
