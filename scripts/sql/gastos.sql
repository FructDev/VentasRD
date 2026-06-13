-- ════════════════════════════════════════════════════════════════════════════
-- MÓDULO DE GASTOS
-- Registro de salidas de dinero: ganancia neta real + cuadre de caja completo.
-- Correr en el SQL Editor de Supabase.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists gastos (
    id uuid primary key,
    negocio_id uuid not null,
    sucursal_id uuid,
    categoria text not null,           -- mercancia | servicios | alquiler | sueldos | transporte | otro
    descripcion text not null,
    monto numeric not null,
    metodo text not null default 'efectivo',  -- efectivo | transferencia | tarjeta
    creado_por text,                   -- nombre de quien lo registró
    fecha_creacion bigint not null,
    fecha_actualizacion bigint not null
);

create index if not exists idx_gastos_negocio on gastos (negocio_id, fecha_creacion desc);

alter table gastos enable row level security;

drop policy if exists "gastos_select" on gastos;
drop policy if exists "gastos_insert" on gastos;
drop policy if exists "gastos_update" on gastos;
drop policy if exists "gastos_delete" on gastos;
create policy "gastos_select" on gastos for select
    using (es_miembro_del_negocio(negocio_id));
create policy "gastos_insert" on gastos for insert
    with check (es_miembro_del_negocio(negocio_id));
create policy "gastos_update" on gastos for update
    using (es_miembro_del_negocio(negocio_id));
create policy "gastos_delete" on gastos for delete
    using (es_miembro_del_negocio(negocio_id));
