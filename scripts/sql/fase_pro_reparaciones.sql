-- ════════════════════════════════════════════════════════════════════════════
-- PLAN PRO · MÓDULO DE REPARACIONES (tiendas de celulares)
-- Correr en el SQL Editor de Supabase.
-- ════════════════════════════════════════════════════════════════════════════

-- 1) Nivel de plan en negocios: 'basico' (por defecto) | 'pro'
alter table negocios add column if not exists plan_tier text not null default 'basico';

-- 2) Tabla de reparaciones
create table if not exists reparaciones (
    id uuid primary key,
    negocio_id uuid not null,
    sucursal_id uuid,
    folio text not null,                       -- consecutivo legible: REP-001
    cliente_id uuid,
    cliente_nombre text not null,
    cliente_telefono text,
    equipo_marca text,
    equipo_modelo text not null,
    equipo_imei text,
    equipo_color text,
    patron_clave text,
    condicion_checklist jsonb not null default '[]'::jsonb,
    condicion_entrada text,
    accesorios text,
    problema_reportado text not null,
    diagnostico text,
    estado text not null default 'recibido',   -- recibido|diagnostico|esperando_repuesto|listo|entregado|cancelado
    repuestos jsonb not null default '[]'::jsonb,
    mano_obra numeric not null default 0,
    total numeric not null default 0,
    abono numeric not null default 0,
    pagos jsonb not null default '[]'::jsonb,
    metodo_abono text,
    metodo_pago_final text,
    garantia_dias int,
    garantia_hasta bigint,
    tecnico_nombre text,
    notas text,
    fecha_creacion bigint not null,
    fecha_entrega bigint,
    fecha_actualizacion bigint not null
);

create index if not exists idx_reparaciones_negocio on reparaciones (negocio_id);
create index if not exists idx_reparaciones_fecha_act on reparaciones (negocio_id, fecha_actualizacion);
create index if not exists idx_reparaciones_imei on reparaciones (negocio_id, equipo_imei);

-- 3) RLS por negocio (mismo helper que el resto de tablas)
alter table reparaciones enable row level security;

drop policy if exists "reparaciones_select" on reparaciones;
drop policy if exists "reparaciones_insert" on reparaciones;
drop policy if exists "reparaciones_update" on reparaciones;
drop policy if exists "reparaciones_delete" on reparaciones;
create policy "reparaciones_select" on reparaciones for select
    using (es_miembro_del_negocio(negocio_id));
create policy "reparaciones_insert" on reparaciones for insert
    with check (es_miembro_del_negocio(negocio_id));
create policy "reparaciones_update" on reparaciones for update
    using (es_miembro_del_negocio(negocio_id));
create policy "reparaciones_delete" on reparaciones for delete
    using (es_miembro_del_negocio(negocio_id));

-- 4) Normalizar fecha_actualizacion futura (misma protección anti-skew que productos)
create or replace trigger trg_normalizar_fecha_reparaciones
before insert or update on reparaciones
for each row execute function normalizar_fecha_actualizacion();

-- ── Si ya creaste la tabla antes de esta versión, corre solo esto: ───────────
-- alter table reparaciones add column if not exists condicion_checklist jsonb not null default '[]'::jsonb;
-- alter table reparaciones add column if not exists pagos jsonb not null default '[]'::jsonb;

-- ════════════════════════════════════════════════════════════════════════════
-- FASE 2 · GARANTÍAS POR IMEI (extiende la tabla seriales existente)
-- ════════════════════════════════════════════════════════════════════════════
alter table seriales add column if not exists garantia_dias int;
alter table seriales add column if not exists garantia_hasta bigint;
alter table seriales add column if not exists cliente_nombre text;
alter table seriales add column if not exists precio_venta numeric;

-- ════════════════════════════════════════════════════════════════════════════
-- FASE 3 · APARTADOS (layaway / plan separe)
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists apartados (
    id uuid primary key,
    negocio_id uuid not null,
    sucursal_id uuid,
    folio text not null,                        -- AP-001
    cliente_id uuid,
    cliente_nombre text not null,
    cliente_telefono text,
    items jsonb not null default '[]'::jsonb,
    total numeric not null default 0,
    abonado numeric not null default 0,
    abonos jsonb not null default '[]'::jsonb,
    estado text not null default 'activo',      -- activo | completado | cancelado
    notas text,
    fecha_creacion bigint not null,
    fecha_completado bigint,
    fecha_cancelado bigint,
    fecha_actualizacion bigint not null
);

create index if not exists idx_apartados_negocio on apartados (negocio_id);
create index if not exists idx_apartados_fecha_act on apartados (negocio_id, fecha_actualizacion);

alter table apartados enable row level security;

drop policy if exists "apartados_select" on apartados;
drop policy if exists "apartados_insert" on apartados;
drop policy if exists "apartados_update" on apartados;
drop policy if exists "apartados_delete" on apartados;
create policy "apartados_select" on apartados for select using (es_miembro_del_negocio(negocio_id));
create policy "apartados_insert" on apartados for insert with check (es_miembro_del_negocio(negocio_id));
create policy "apartados_update" on apartados for update using (es_miembro_del_negocio(negocio_id));
create policy "apartados_delete" on apartados for delete using (es_miembro_del_negocio(negocio_id));

create or replace trigger trg_normalizar_fecha_apartados
before insert or update on apartados
for each row execute function normalizar_fecha_actualizacion();

-- Permitir el estado 'apartado' en seriales ya estaba como texto libre (sin enum), no requiere cambios.
