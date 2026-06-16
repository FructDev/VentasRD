-- ════════════════════════════════════════════════════════════════════════════
-- DIAGNÓSTICO DE SEGURIDAD (RLS) — SOLO LECTURA, no cambia nada
-- Corre las 4 consultas en el SQL Editor de Supabase y comparte el resultado.
-- Con eso genero el blindaje exacto para cada tabla sin romper la app.
-- ════════════════════════════════════════════════════════════════════════════

-- 1) Estado de RLS por tabla (las que digan "false" están DESPROTEGIDAS)
select
    c.relname                                                   as tabla,
    c.relrowsecurity                                            as rls_activado,
    (select count(*) from pg_policies p
       where p.schemaname = 'public' and p.tablename = c.relname) as cantidad_politicas
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relrowsecurity asc, c.relname;

-- 2) ¿Existe la función de membresía que ya usamos en las tablas nuevas?
select exists (
    select 1 from pg_proc where proname = 'es_miembro_del_negocio'
) as funcion_membresia_existe;

-- 3) Detalle de las políticas existentes (para ver qué protege cada una)
select tablename, policyname, cmd,
       qual        as condicion_using,
       with_check  as condicion_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- 4) Columnas clave por tabla (para saber cómo se relaciona cada una con el negocio)
select table_name, string_agg(column_name, ', ' order by ordinal_position) as columnas
from information_schema.columns
where table_schema = 'public'
  and column_name in ('negocio_id', 'producto_id', 'producto_padre_id', 'sucursal_id', 'user_id', 'dueño_id', 'dueno_id')
group by table_name
order by table_name;
