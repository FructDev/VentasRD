-- Elimina las foreign keys frágiles de las tablas espejo del sync offline-first.
-- En este modelo la fuente de verdad es el dispositivo: la nube es un espejo.
-- Una FK en el espejo convierte casos legítimos en filas imposibles de subir:
--   · venta libre → producto_id que jamás existirá en productos
--   · cliente borrado → sus cargos históricos quedan huérfanos
--   · orden de llegada → el detalle puede llegar antes que su producto
-- Esas filas rechazadas envenenaban el sync (deudas de fiado invisibles).
-- La integridad real la garantizan la app + RLS por negocio.

do $$
declare c record;
begin
    -- venta_detalles: FK a productos y ventas
    for c in
        select conname from pg_constraint
        where conrelid = 'venta_detalles'::regclass and contype = 'f'
    loop
        execute format('alter table venta_detalles drop constraint %I', c.conname);
        raise notice 'FK eliminada: venta_detalles.%', c.conname;
    end loop;

    -- transacciones_fiado: FK a ventas y clientes
    for c in
        select conname from pg_constraint
        where conrelid = 'transacciones_fiado'::regclass and contype = 'f'
    loop
        execute format('alter table transacciones_fiado drop constraint %I', c.conname);
        raise notice 'FK eliminada: transacciones_fiado.%', c.conname;
    end loop;

    -- seriales: FK a productos/ventas
    for c in
        select conname from pg_constraint
        where conrelid = 'seriales'::regclass and contype = 'f'
    loop
        execute format('alter table seriales drop constraint %I', c.conname);
        raise notice 'FK eliminada: seriales.%', c.conname;
    end loop;
exception when undefined_table then
    raise notice 'Alguna tabla no existe aún — nada que hacer';
end $$;

-- producto_id puede venir sin producto real (venta libre)
alter table venta_detalles alter column producto_id drop not null;
