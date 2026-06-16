-- ════════════════════════════════════════════════════════════════════════════
-- PARCHE RLS — completa las 3 tablas que quedaron sin proteger:
-- cortes_caja, seriales, usuarios_negocio.
-- Idempotente. Asume que las funciones ya existen (de rls_blindaje.sql); por si
-- acaso, las re-crea.
-- ════════════════════════════════════════════════════════════════════════════

-- Funciones (idempotentes)
create or replace function es_miembro_del_negocio(p_negocio_id uuid)
returns boolean language sql security definer stable as $$
    select exists (select 1 from negocios n where n.id = p_negocio_id and n.dueño_id = auth.uid())
        or exists (select 1 from usuarios_negocio un where un.negocio_id = p_negocio_id and un.user_id = auth.uid() and un.activo = true);
$$;
create or replace function es_admin_del_negocio(p_negocio_id uuid)
returns boolean language sql security definer stable as $$
    select exists (select 1 from negocios n where n.id = p_negocio_id and n.dueño_id = auth.uid())
        or exists (select 1 from usuarios_negocio un where un.negocio_id = p_negocio_id and un.user_id = auth.uid() and un.activo = true and un.rol = 'admin');
$$;
grant execute on function es_miembro_del_negocio to authenticated, service_role;
grant execute on function es_admin_del_negocio  to authenticated, service_role;

-- cortes_caja (negocio_id directo)
alter table public.cortes_caja enable row level security;
drop policy if exists "tenant_all" on public.cortes_caja;
create policy "tenant_all" on public.cortes_caja for all
    using (es_miembro_del_negocio(negocio_id)) with check (es_miembro_del_negocio(negocio_id));

-- seriales (negocio_id directo)
alter table public.seriales enable row level security;
drop policy if exists "tenant_all" on public.seriales;
create policy "tenant_all" on public.seriales for all
    using (es_miembro_del_negocio(negocio_id)) with check (es_miembro_del_negocio(negocio_id));

-- usuarios_negocio (ver = miembro; gestionar = solo admin)
alter table public.usuarios_negocio enable row level security;
drop policy if exists "un_select" on public.usuarios_negocio;
drop policy if exists "un_insert" on public.usuarios_negocio;
drop policy if exists "un_update" on public.usuarios_negocio;
drop policy if exists "un_delete" on public.usuarios_negocio;
create policy "un_select" on public.usuarios_negocio for select using (es_miembro_del_negocio(negocio_id));
create policy "un_insert" on public.usuarios_negocio for insert with check (es_admin_del_negocio(negocio_id));
create policy "un_update" on public.usuarios_negocio for update using (es_admin_del_negocio(negocio_id)) with check (es_admin_del_negocio(negocio_id));
create policy "un_delete" on public.usuarios_negocio for delete using (es_admin_del_negocio(negocio_id));
