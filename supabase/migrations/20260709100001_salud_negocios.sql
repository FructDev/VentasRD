-- Salud de actividad por negocio para el panel de operador: última venta
-- sincronizada y ventas de los últimos 7 días. Permite soporte proactivo
-- (detectar negocios apagados o con sync rota antes de que llamen).
-- Cast ::text: negocio_id es text en el esquema legado de ventas.
create or replace function salud_negocios()
returns table(negocio_id text, ultima_venta bigint, ventas_7d int)
language sql security definer stable as $$
    select
        negocio_id::text,
        max(fecha_creacion)::bigint,
        (count(*) filter (
            where fecha_creacion > (extract(epoch from now()) * 1000 - 7 * 86400000)
        ))::int
    from ventas
    group by negocio_id;
$$;
grant execute on function salud_negocios to service_role;
