-- Un dueño = UN negocio. Cierre definitivo del bug de negocios duplicados:
-- procesarUsuario corría en paralelo (eventos de auth en ráfaga) y la
-- auto-sanación insertaba el negocio 2+ veces para el mismo dueño. Síntomas:
-- "cuentas duplicadas", onboarding roto y logins en bucle (maybeSingle con
-- >1 fila lanza error).

-- 1) Borrar duplicados VACÍOS (sin ventas/productos/clientes/reparaciones).
--    Se conserva el negocio con onboarding completado; a igualdad, el más viejo.
with duplicados as (
    select "dueño_id"
    from negocios
    where "dueño_id" is not null
    group by "dueño_id"
    having count(*) > 1
), ranked as (
    select id, row_number() over (
        partition by "dueño_id"
        order by onboarding_completado desc nulls last, id
    ) as rn
    from negocios
    where "dueño_id" in (select "dueño_id" from duplicados)
), perdedores_vacios as (
    select r.id from ranked r
    where r.rn > 1
      and not exists (select 1 from ventas v      where v.negocio_id = r.id)
      and not exists (select 1 from productos p   where p.negocio_id = r.id)
      and not exists (select 1 from clientes c    where c.negocio_id = r.id)
      and not exists (select 1 from reparaciones rep where rep.negocio_id = r.id)
)
delete from sucursales s where s.negocio_id in (select id from perdedores_vacios);

with duplicados as (
    select "dueño_id"
    from negocios
    where "dueño_id" is not null
    group by "dueño_id"
    having count(*) > 1
), ranked as (
    select id, row_number() over (
        partition by "dueño_id"
        order by onboarding_completado desc nulls last, id
    ) as rn
    from negocios
    where "dueño_id" in (select "dueño_id" from duplicados)
)
delete from negocios n
where n.id in (select id from ranked where rn > 1)
  and not exists (select 1 from ventas v      where v.negocio_id = n.id)
  and not exists (select 1 from productos p   where p.negocio_id = n.id)
  and not exists (select 1 from clientes c    where c.negocio_id = n.id)
  and not exists (select 1 from reparaciones rep where rep.negocio_id = n.id)
  and not exists (select 1 from usuarios_negocio u where u.negocio_id = n.id);

-- 2) Índice único: la base de datos ya no permite un segundo negocio por dueño.
--    Si aún quedan duplicados CON datos (requieren revisión manual), no se
--    puede crear: avisar sin romper la migración.
do $$
begin
    create unique index if not exists negocios_dueno_unico
        on negocios ("dueño_id") where "dueño_id" is not null;
exception when others then
    raise notice 'AVISO: quedan negocios duplicados CON datos — revisar a mano y re-crear el indice negocios_dueno_unico. (%)', sqlerrm;
end $$;
