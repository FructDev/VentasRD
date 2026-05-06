-- ============================================================
-- VentaRD — Migration: columnas mixto/fiado en ventas + tabla devoluciones
-- Ejecutar en: Supabase → SQL Editor
-- ============================================================

-- 1. Agregar columnas de pagos mixtos y cliente_id a ventas
ALTER TABLE public.ventas
    ADD COLUMN IF NOT EXISTS monto_efectivo     numeric(12,2),
    ADD COLUMN IF NOT EXISTS monto_transferencia numeric(12,2),
    ADD COLUMN IF NOT EXISTS cliente_id          uuid REFERENCES public.clientes(id) ON DELETE SET NULL;

-- 2. Crear tabla de devoluciones (negocio_id es text — RLS lo protege, sin FK directa)
CREATE TABLE IF NOT EXISTS public.devoluciones (
    id              uuid PRIMARY KEY,
    negocio_id      text NOT NULL,
    venta_id        uuid NOT NULL REFERENCES public.ventas(id) ON DELETE CASCADE,
    items_devueltos jsonb NOT NULL DEFAULT '[]',
    monto_devuelto  numeric(12,2) NOT NULL DEFAULT 0,
    razon           text,
    fecha_creacion  bigint NOT NULL
);

-- 3. RLS en devoluciones (mismo patrón que el resto de tablas)
ALTER TABLE public.devoluciones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_devoluciones" ON public.devoluciones
    USING (negocio_id::text = public.get_negocio_id());

-- 4. Índices
CREATE INDEX IF NOT EXISTS idx_devoluciones_negocio ON public.devoluciones (negocio_id);
CREATE INDEX IF NOT EXISTS idx_devoluciones_venta   ON public.devoluciones (venta_id);
CREATE INDEX IF NOT EXISTS idx_ventas_cliente        ON public.ventas (cliente_id);
