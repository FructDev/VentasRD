-- Extras del panel de operador (superadmin) que existían solo como script
-- suelto y nunca se aplicaron: por eso el "Historial" del detalle de negocio
-- salía siempre vacío.

-- 1. Bitácora de pagos / extensiones de acceso
create table if not exists pagos_log (
    id uuid primary key default gen_random_uuid(),
    negocio_id uuid not null,
    dias int,                       -- días extendidos (null si fue fecha manual / corte)
    nuevo_acceso_hasta bigint,      -- a qué fecha quedó el acceso
    nota text,                      -- ej: 'Pago +30d', 'Corte', 'Ajuste manual'
    creado_en timestamptz not null default now()
);
create index if not exists idx_pagos_log_negocio on pagos_log (negocio_id, creado_en desc);

-- Solo el operador (service role) lee/escribe. RLS activado sin políticas de
-- cliente = nadie autenticado normal puede tocarla; el service role la ignora.
alter table pagos_log enable row level security;

-- 2. Total facturado por un negocio (suma eficiente, sin traer todas las filas)
-- Cast ::text: ventas.negocio_id es text en el esquema legado.
create or replace function total_ventas_negocio(p_negocio_id uuid)
returns numeric language sql security definer stable as $$
    select coalesce(sum(total), 0) from ventas where negocio_id::text = p_negocio_id::text;
$$;
grant execute on function total_ventas_negocio to service_role;
