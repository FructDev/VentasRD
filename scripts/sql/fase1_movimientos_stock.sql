-- ════════════════════════════════════════════════════════════════════════════
-- FASE 1: Stock por movimientos (deltas atómicos)
-- Elimina la pérdida de stock cuando varias cajas venden simultáneamente.
-- Correr completo en el SQL Editor de Supabase.
-- ════════════════════════════════════════════════════════════════════════════

-- 0. Función de membresía (por si no existe ya de la corrección de RLS)
create or replace function es_miembro_del_negocio(p_negocio_id uuid)
returns boolean
language sql
security definer
stable
as $$
    select exists (
        select 1 from negocios n
        where n.id = p_negocio_id and n.dueño_id = auth.uid()
    )
    or exists (
        select 1 from usuarios_negocio un
        where un.negocio_id = p_negocio_id
          and un.user_id = auth.uid()
          and un.activo = true
    );
$$;

-- 1. Tabla de movimientos (kardex)
create table if not exists movimientos_stock (
    id uuid primary key,
    negocio_id uuid not null,
    sucursal_id uuid,
    producto_id uuid not null,
    delta numeric not null default 0,      -- negativo = salida, positivo = entrada
    valor_absoluto numeric,                -- solo para conteos físicos (pisa el stock)
    tipo text not null,                    -- venta | devolucion | entrada | merma | conteo | importacion
    referencia_id uuid,                    -- venta_id / devolucion_id que lo originó
    fecha_creacion bigint not null
);

create index if not exists idx_mov_stock_negocio on movimientos_stock (negocio_id, fecha_creacion desc);
create index if not exists idx_mov_stock_producto on movimientos_stock (producto_id, fecha_creacion desc);

-- RLS: misma política de membresía que el resto de las tablas
alter table movimientos_stock enable row level security;

drop policy if exists "mov_stock_select" on movimientos_stock;
drop policy if exists "mov_stock_insert" on movimientos_stock;
create policy "mov_stock_select" on movimientos_stock for select
    using (es_miembro_del_negocio(negocio_id));
create policy "mov_stock_insert" on movimientos_stock for insert
    with check (es_miembro_del_negocio(negocio_id));

-- 2. RPC atómica e idempotente
--    - Inserta el movimiento; si ya existe (reintento tras timeout) NO lo aplica de nuevo.
--    - delta: incrementa/decrementa el stock (nunca pisa el valor de otra caja).
--    - valor_absoluto: para conteos físicos, establece el stock exacto.
--    - Mantiene también inventario_sucursales si viene sucursal_id.
create or replace function aplicar_movimiento_stock(
    p_id uuid,
    p_negocio_id uuid,
    p_sucursal_id uuid,
    p_producto_id uuid,
    p_delta numeric,
    p_tipo text,
    p_referencia_id uuid,
    p_fecha_creacion bigint,
    p_valor_absoluto numeric default null
) returns void
language plpgsql
security definer
as $$
declare
    v_insertadas int;
    v_ahora bigint := (extract(epoch from now()) * 1000)::bigint;
begin
    -- Validar membresía (el RPC corre como definer, validamos a mano).
    -- El service role (procesos del servidor) pasa directo.
    if coalesce(auth.role(), '') <> 'service_role'
       and not es_miembro_del_negocio(p_negocio_id) then
        raise exception 'No autorizado para este negocio';
    end if;

    -- Idempotencia: si este movimiento ya fue aplicado, salir sin tocar nada
    insert into movimientos_stock
        (id, negocio_id, sucursal_id, producto_id, delta, valor_absoluto, tipo, referencia_id, fecha_creacion)
    values
        (p_id, p_negocio_id, p_sucursal_id, p_producto_id, p_delta, p_valor_absoluto, p_tipo, p_referencia_id, p_fecha_creacion)
    on conflict (id) do nothing;

    get diagnostics v_insertadas = row_count;
    if v_insertadas = 0 then
        return; -- ya estaba aplicado
    end if;

    -- Aplicar al stock global del producto
    if p_valor_absoluto is not null then
        update productos
        set stock_actual = p_valor_absoluto, fecha_actualizacion = v_ahora
        where id = p_producto_id and negocio_id = p_negocio_id;
    else
        update productos
        set stock_actual = coalesce(stock_actual, 0) + p_delta, fecha_actualizacion = v_ahora
        where id = p_producto_id and negocio_id = p_negocio_id;
    end if;

    -- Mantener el stock por sucursal si aplica
    if p_sucursal_id is not null then
        insert into inventario_sucursales (sucursal_id, producto_id, stock_actual, stock_minimo, fecha_actualizacion)
        values (
            p_sucursal_id,
            p_producto_id,
            coalesce(p_valor_absoluto, p_delta),
            0,
            v_ahora
        )
        on conflict (sucursal_id, producto_id) do update
        set stock_actual = case
                when p_valor_absoluto is not null then p_valor_absoluto
                else coalesce(inventario_sucursales.stock_actual, 0) + p_delta
            end,
            fecha_actualizacion = v_ahora;
    end if;
end;
$$;

-- Solo usuarios autenticados y el servidor pueden ejecutarla
revoke execute on function aplicar_movimiento_stock from public, anon;
grant execute on function aplicar_movimiento_stock to authenticated, service_role;
