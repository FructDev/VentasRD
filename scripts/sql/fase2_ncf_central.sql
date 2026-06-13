-- ════════════════════════════════════════════════════════════════════════════
-- FASE 2: NCF centralizado con reserva de bloques
-- Elimina el riesgo de comprobantes fiscales duplicados entre cajas.
-- La secuencia vive en la nube; cada dispositivo reserva bloques atómicamente
-- para poder emitir offline.
-- Correr completo en el SQL Editor de Supabase (re-ejecutable sin peligro).
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Secuencia única por negocio
create table if not exists ncf_secuencias (
    negocio_id uuid primary key,
    tipo text not null default 'B02',          -- B02 consumidor final | B01 crédito fiscal
    desde bigint not null,                     -- inicio del rango autorizado por la DGII
    hasta bigint not null,                     -- fin del rango autorizado
    proximo bigint not null,                   -- siguiente número SIN asignar a ningún dispositivo
    habilitado boolean not null default true
);

alter table ncf_secuencias enable row level security;

drop policy if exists "ncf_select" on ncf_secuencias;
create policy "ncf_select" on ncf_secuencias for select
    using (es_miembro_del_negocio(negocio_id));
-- insert/update solo vía RPCs (security definer) — sin políticas de escritura directa

-- 2. RPC: configura/actualiza el rango DGII sin perder el progreso de la secuencia
create or replace function configurar_ncf(
    p_negocio_id uuid,
    p_tipo text,
    p_desde bigint,
    p_hasta bigint,
    p_habilitado boolean
) returns void
language plpgsql
security definer
as $$
begin
    if coalesce(auth.role(), '') <> 'service_role'
       and not es_miembro_del_negocio(p_negocio_id) then
        raise exception 'No autorizado para este negocio';
    end if;

    insert into ncf_secuencias (negocio_id, tipo, desde, hasta, proximo, habilitado)
    values (p_negocio_id, p_tipo, p_desde, p_hasta, p_desde, p_habilitado)
    on conflict (negocio_id) do update
        set tipo = excluded.tipo,
            desde = excluded.desde,
            hasta = excluded.hasta,
            habilitado = excluded.habilitado,
            -- nunca retroceder la secuencia (evita re-emitir números ya usados)
            proximo = greatest(ncf_secuencias.proximo, excluded.desde);
end;
$$;

-- 3. RPC: reserva un bloque de números de forma atómica (FOR UPDATE = sin carreras)
--    Devuelve el bloque reservado, o ninguna fila si no hay números disponibles.
create or replace function reservar_ncf(
    p_negocio_id uuid,
    p_cantidad int default 20
) returns table(bloque_desde bigint, bloque_hasta bigint, tipo text)
language plpgsql
security definer
as $$
declare
    v ncf_secuencias%rowtype;
begin
    if coalesce(auth.role(), '') <> 'service_role'
       and not es_miembro_del_negocio(p_negocio_id) then
        raise exception 'No autorizado para este negocio';
    end if;

    select * into v from ncf_secuencias
    where negocio_id = p_negocio_id
    for update;                       -- bloquea la fila: dos cajas no pueden reservar a la vez

    if not found or not v.habilitado or v.proximo > v.hasta then
        return;                       -- sin secuencia, deshabilitada o agotada
    end if;

    bloque_desde := v.proximo;
    bloque_hasta := least(v.hasta, v.proximo + p_cantidad - 1);
    tipo := v.tipo;

    update ncf_secuencias
    set proximo = bloque_hasta + 1
    where negocio_id = p_negocio_id;

    return next;
end;
$$;

-- Permisos
revoke execute on function configurar_ncf from public, anon;
revoke execute on function reservar_ncf from public, anon;
grant execute on function configurar_ncf to authenticated, service_role;
grant execute on function reservar_ncf to authenticated, service_role;
