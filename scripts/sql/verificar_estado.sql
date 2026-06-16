-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN DE ESTADO — corre esto en Supabase para ver qué falta.
-- Lo que salga "existe = false" es lo que tienes que aplicar.
-- ════════════════════════════════════════════════════════════════════════════
with checks as (
    -- Columnas
    select 'columna: negocios.acceso_hasta'   as requisito, 'acceso_suscripcion.sql'        as script,
           exists(select 1 from information_schema.columns where table_name='negocios' and column_name='acceso_hasta') as existe
    union all select 'columna: negocios.logo_url', 'alter negocios add logo_url',
           exists(select 1 from information_schema.columns where table_name='negocios' and column_name='logo_url')
    union all select 'columna: ventas.vendedor_nombre', 'alter ventas add vendedor_nombre',
           exists(select 1 from information_schema.columns where table_name='ventas' and column_name='vendedor_nombre')
    union all select 'columna: ventas.caja_codigo', 'alter ventas add caja_codigo',
           exists(select 1 from information_schema.columns where table_name='ventas' and column_name='caja_codigo')
    union all select 'columna: productos.imagen_url', 'alter productos add imagen_url',
           exists(select 1 from information_schema.columns where table_name='productos' and column_name='imagen_url')
    -- Tablas
    union all select 'tabla: movimientos_stock', 'fase1_movimientos_stock.sql',
           exists(select 1 from information_schema.tables where table_name='movimientos_stock')
    union all select 'tabla: ncf_secuencias', 'fase2_ncf_central.sql',
           exists(select 1 from information_schema.tables where table_name='ncf_secuencias')
    union all select 'tabla: gastos', 'gastos.sql',
           exists(select 1 from information_schema.tables where table_name='gastos')
    union all select 'tabla: pagos_log', 'superadmin_extras.sql',
           exists(select 1 from information_schema.tables where table_name='pagos_log')
    -- Funciones
    union all select 'función: es_miembro_del_negocio', 'rls_blindaje.sql',
           exists(select 1 from pg_proc where proname='es_miembro_del_negocio')
    union all select 'función: es_admin_del_negocio', 'rls_blindaje.sql',
           exists(select 1 from pg_proc where proname='es_admin_del_negocio')
    union all select 'función: aplicar_movimiento_stock', 'fase1_movimientos_stock.sql',
           exists(select 1 from pg_proc where proname='aplicar_movimiento_stock')
    union all select 'función: reservar_ncf', 'fase2_ncf_central.sql',
           exists(select 1 from pg_proc where proname='reservar_ncf')
    union all select 'función: total_ventas_negocio', 'superadmin_extras.sql',
           exists(select 1 from pg_proc where proname='total_ventas_negocio')
)
select * from checks order by existe asc, requisito;

-- RLS activado en las tablas principales (todas deben quedar en true tras rls_blindaje.sql)
select c.relname as tabla, c.relrowsecurity as rls_activado
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r'
  and c.relname in ('productos','ventas','venta_detalles','clientes','transacciones_fiado',
                    'cajas','devoluciones','cortes_caja','seriales','composiciones','sucursales',
                    'gastos','movimientos_stock','ncf_secuencias','negocios','usuarios_negocio',
                    'inventario_sucursales')
order by c.relrowsecurity asc, c.relname;
