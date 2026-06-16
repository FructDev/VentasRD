-- ════════════════════════════════════════════════════════════════════════════
-- BLINDAJE RLS — aísla cada negocio: un usuario solo accede a SUS datos.
-- Idempotente: se puede correr varias veces sin problema.
-- Las rutas con service role (invitar/activar usuarios, subir imágenes, sync de
-- inventario) IGNORAN RLS automáticamente, así que no se afectan.
--
-- ⚠️ Tras aplicar: prueba (1) iniciar sesión, (2) hacer una venta, (3) abrir
-- "Mi Equipo". Si algo fallara, al final hay un bloque de ROLLBACK comentado.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Funciones de control (SECURITY DEFINER = leen sin recursión de RLS) ────

-- ¿El usuario actual pertenece a este negocio? (dueño o empleado activo)
create or replace function es_miembro_del_negocio(p_negocio_id uuid)
returns boolean language sql security definer stable as $$
    select exists (select 1 from negocios n
                   where n.id = p_negocio_id and n.dueño_id = auth.uid())
        or exists (select 1 from usuarios_negocio un
                   where un.negocio_id = p_negocio_id and un.user_id = auth.uid() and un.activo = true);
$$;

-- ¿Es dueño o admin del negocio? (para gestionar equipo y configuración)
create or replace function es_admin_del_negocio(p_negocio_id uuid)
returns boolean language sql security definer stable as $$
    select exists (select 1 from negocios n
                   where n.id = p_negocio_id and n.dueño_id = auth.uid())
        or exists (select 1 from usuarios_negocio un
                   where un.negocio_id = p_negocio_id and un.user_id = auth.uid()
                     and un.activo = true and un.rol = 'admin');
$$;

grant execute on function es_miembro_del_negocio  to authenticated, service_role;
grant execute on function es_admin_del_negocio     to authenticated, service_role;

-- ── 2. Limpieza: quitar TODAS las políticas previas para dejar un estado conocido
do $$
declare r record;
declare tablas text[] := array[
    'cajas','clientes','composiciones','cortes_caja','detalles_ventas','devoluciones',
    'gastos','inventario_sucursales','movimientos_stock','ncf_secuencias','negocios',
    'productos','seriales','sucursales','transacciones_fiado','usuarios_negocio',
    'venta_detalles','ventas'
];
begin
    for r in select policyname, tablename from pg_policies
             where schemaname='public' and tablename = any(tablas) loop
        execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
    end loop;
end $$;

-- ── 3. Tablas de datos con negocio_id directo: acceso total para miembros ─────
do $$
declare t text;
declare tablas_negocio text[] := array[
    'cajas','clientes','composiciones','cortes_caja','devoluciones','gastos',
    'movimientos_stock','ncf_secuencias','productos','seriales','sucursales',
    'transacciones_fiado','venta_detalles','ventas'
];
begin
    foreach t in array tablas_negocio loop
        execute format('alter table public.%I enable row level security', t);
        execute format(
            'create policy "tenant_all" on public.%I for all
                using (es_miembro_del_negocio(negocio_id))
                with check (es_miembro_del_negocio(negocio_id))', t);
    end loop;
end $$;

-- ── 4. Tablas relacionadas por producto (sin negocio_id propio) ───────────────
-- inventario_sucursales y detalles_ventas: el negocio se deduce del producto.
alter table public.inventario_sucursales enable row level security;
create policy "tenant_all" on public.inventario_sucursales for all
    using (exists (select 1 from productos p
                   where p.id = inventario_sucursales.producto_id
                     and es_miembro_del_negocio(p.negocio_id)))
    with check (exists (select 1 from productos p
                   where p.id = inventario_sucursales.producto_id
                     and es_miembro_del_negocio(p.negocio_id)));

alter table public.detalles_ventas enable row level security;
create policy "tenant_all" on public.detalles_ventas for all
    using (exists (select 1 from productos p
                   where p.id = detalles_ventas.producto_id
                     and es_miembro_del_negocio(p.negocio_id)))
    with check (exists (select 1 from productos p
                   where p.id = detalles_ventas.producto_id
                     and es_miembro_del_negocio(p.negocio_id)));

-- ── 5. negocios: ver = miembro; modificar = solo dueño/admin; crear = uno mismo
alter table public.negocios enable row level security;
create policy "negocios_select" on public.negocios for select
    using (es_miembro_del_negocio(id));
create policy "negocios_insert" on public.negocios for insert
    with check (dueño_id = auth.uid());
create policy "negocios_update" on public.negocios for update
    using (es_admin_del_negocio(id)) with check (es_admin_del_negocio(id));

-- ── 6. usuarios_negocio: ver = miembro; gestionar = solo admin ────────────────
-- (un cajero/vendedor no puede auto-ascenderse; invitaciones usan service role)
alter table public.usuarios_negocio enable row level security;
create policy "un_select" on public.usuarios_negocio for select
    using (es_miembro_del_negocio(negocio_id));
create policy "un_insert" on public.usuarios_negocio for insert
    with check (es_admin_del_negocio(negocio_id));
create policy "un_update" on public.usuarios_negocio for update
    using (es_admin_del_negocio(negocio_id)) with check (es_admin_del_negocio(negocio_id));
create policy "un_delete" on public.usuarios_negocio for delete
    using (es_admin_del_negocio(negocio_id));

-- ── 7. Verificación: TODAS deben quedar en rls_activado = true ────────────────
-- select c.relname as tabla, c.relrowsecurity as rls_activado
-- from pg_class c join pg_namespace n on n.oid=c.relnamespace
-- where n.nspname='public' and c.relkind='r' order by c.relrowsecurity, c.relname;

-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK de emergencia (si algo se rompiera, descomenta y corre solo lo necesario)
-- alter table public.NOMBRE_TABLA disable row level security;
-- ════════════════════════════════════════════════════════════════════════════
