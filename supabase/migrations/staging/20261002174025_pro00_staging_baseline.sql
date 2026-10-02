-- PRO-00 STAGING-ONLY: blzzinivvzadqjbnpsre. NO incluir en release productivo.
-- Fuente: captura public sanitizada 2026-10-02; no contiene datos comerciales.
-- Repetible/aditiva. FK a tablas preexistentes NOT VALID: validar por separado.
-- PIN default omitido por redaccion; no se fabrica historia ni se ajusta stock.
BEGIN;
DO $pro00_guard$
BEGIN
  IF pg_catalog.to_regclass('public.inventario_operaciones_v2') IS NULL
    OR (SELECT count(*) FROM public.negocios
      WHERE (id='96000000-0000-4000-8000-000000000001'::uuid AND nombre='PRO00 QA A - SINTETICO')
         OR (id='96000000-0000-4000-8000-000000000002'::uuid AND nombre='PRO00 QA B - SINTETICO'))<>2
  THEN RAISE EXCEPTION 'PRO00_STAGING_GUARD_FAILED'; END IF;
END;
$pro00_guard$;

CREATE TABLE IF NOT EXISTS public."apartados" (
  "id" uuid NOT NULL,
  "negocio_id" uuid NOT NULL,
  "sucursal_id" uuid,
  "folio" text NOT NULL,
  "cliente_id" uuid,
  "cliente_nombre" text NOT NULL,
  "cliente_telefono" text,
  "items" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "total" numeric DEFAULT 0 NOT NULL,
  "abonado" numeric DEFAULT 0 NOT NULL,
  "abonos" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "estado" text DEFAULT 'activo'::text NOT NULL,
  "notas" text,
  "fecha_creacion" bigint NOT NULL,
  "fecha_completado" bigint,
  "fecha_cancelado" bigint,
  "fecha_actualizacion" bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public."cajas" (
  "id" text NOT NULL,
  "negocio_id" text NOT NULL,
  "sucursal_id" text,
  "estado" text NOT NULL,
  "monto_apertura" numeric DEFAULT 0 NOT NULL,
  "monto_cierre" numeric,
  "monto_esperado" numeric,
  "diferencia" numeric,
  "denominaciones_apertura" jsonb,
  "denominaciones_cierre" jsonb,
  "fecha_apertura" bigint NOT NULL,
  "fecha_cierre" bigint,
  "fecha_actualizacion" bigint DEFAULT ((EXTRACT(epoch FROM now()) * (1000)::numeric))::bigint NOT NULL,
  "notas" text
);

CREATE TABLE IF NOT EXISTS public."clientes" (
  "id" uuid NOT NULL,
  "negocio_id" uuid NOT NULL,
  "nombre" text NOT NULL,
  "telefono" text,
  "limite_credito" numeric DEFAULT 0,
  "estado_sincronizacion" smallint DEFAULT 1,
  "fecha_actualizacion" bigint NOT NULL,
  "sucursal_id" uuid,
  "tipo_precio" smallint DEFAULT 1,
  "al_por_mayor" boolean DEFAULT false,
  "eliminado" boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS public."composiciones" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "producto_padre_id" uuid,
  "insumo_id" uuid,
  "cantidad_necesaria" numeric(12,4) NOT NULL,
  "negocio_id" uuid,
  "fecha_actualizacion" bigint DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public."cortes_caja" (
  "id" uuid NOT NULL,
  "negocio_id" uuid NOT NULL,
  "caja_id" uuid NOT NULL,
  "sucursal_id" uuid,
  "tipo" text NOT NULL,
  "fecha_creacion" bigint NOT NULL,
  "efectivo" numeric DEFAULT 0 NOT NULL,
  "tarjeta" numeric DEFAULT 0 NOT NULL,
  "transferencia" numeric DEFAULT 0 NOT NULL,
  "fiado" numeric DEFAULT 0 NOT NULL,
  "mixto" numeric DEFAULT 0 NOT NULL,
  "total_ventas" numeric DEFAULT 0 NOT NULL,
  "cantidad_transacciones" integer DEFAULT 0 NOT NULL,
  "monto_apertura" numeric,
  "monto_esperado" numeric,
  "monto_contado" numeric,
  "diferencia" numeric,
  "ingreso_reparaciones" numeric,
  "ingreso_apartados" numeric
);

CREATE TABLE IF NOT EXISTS public."detalles_ventas" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "venta_id" uuid,
  "producto_id" uuid,
  "cantidad" integer NOT NULL,
  "precio_unitario" numeric(12,2) NOT NULL,
  "itbis_aplicado" numeric(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS public."devoluciones" (
  "id" uuid NOT NULL,
  "negocio_id" text NOT NULL,
  "venta_id" uuid NOT NULL,
  "items_devueltos" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "monto_devuelto" numeric(12,2) DEFAULT 0 NOT NULL,
  "razon" text,
  "fecha_creacion" bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public."gastos" (
  "id" uuid NOT NULL,
  "negocio_id" uuid NOT NULL,
  "sucursal_id" uuid,
  "categoria" text NOT NULL,
  "descripcion" text NOT NULL,
  "monto" numeric NOT NULL,
  "metodo" text DEFAULT 'efectivo'::text NOT NULL,
  "creado_por" text,
  "fecha_creacion" bigint NOT NULL,
  "fecha_actualizacion" bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public."inventario_sucursales" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "sucursal_id" uuid NOT NULL,
  "producto_id" uuid NOT NULL,
  "stock_actual" integer DEFAULT 0 NOT NULL,
  "stock_minimo" integer DEFAULT 0 NOT NULL,
  "estado_sincronizacion" smallint DEFAULT 1 NOT NULL,
  "fecha_actualizacion" bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public."movimientos_stock" (
  "id" uuid NOT NULL,
  "negocio_id" uuid NOT NULL,
  "sucursal_id" uuid,
  "producto_id" uuid NOT NULL,
  "delta" numeric DEFAULT 0 NOT NULL,
  "valor_absoluto" numeric,
  "tipo" text NOT NULL,
  "referencia_id" uuid,
  "fecha_creacion" bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public."ncf_secuencias" (
  "negocio_id" uuid NOT NULL,
  "tipo" text DEFAULT 'B02'::text NOT NULL,
  "desde" bigint NOT NULL,
  "hasta" bigint NOT NULL,
  "proximo" bigint NOT NULL,
  "habilitado" boolean DEFAULT true NOT NULL
);

CREATE TABLE IF NOT EXISTS public."negocios" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "nombre" text NOT NULL,
  "dueño_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "onboarding_completado" boolean DEFAULT false,
  "telefono" text,
  "tipo_negocio" text,
  "direccion" text,
  "pin_admin" text,
  "whatsapp_dueno" text DEFAULT ''::text,
  "rnc" text DEFAULT ''::text,
  "mensaje_ticket" text DEFAULT '¡Gracias por su compra!'::text,
  "plan_activo" boolean DEFAULT false NOT NULL,
  "trial_hasta" bigint,
  "logo_url" text,
  "acceso_hasta" bigint,
  "nota_operador" text,
  "plan_tier" text DEFAULT 'basico'::text NOT NULL,
  "color_marca" text,
  "fuente_marca" text,
  "catalogo_publico" boolean DEFAULT false NOT NULL,
  "codigo_referido" text,
  "referido_por" text,
  "referido_acreditado" boolean DEFAULT false NOT NULL,
  "referidos_total" integer DEFAULT 0 NOT NULL,
  "banco_nombre" text,
  "banco_cuenta" text,
  "banco_titular" text
);

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "onboarding_completado" boolean DEFAULT false;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "telefono" text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "tipo_negocio" text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "direccion" text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "pin_admin" text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "whatsapp_dueno" text DEFAULT ''::text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "rnc" text DEFAULT ''::text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "mensaje_ticket" text DEFAULT '¡Gracias por su compra!'::text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "plan_activo" boolean DEFAULT false NOT NULL;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "trial_hasta" bigint;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "logo_url" text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "acceso_hasta" bigint;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "nota_operador" text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "plan_tier" text DEFAULT 'basico'::text NOT NULL;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "color_marca" text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "fuente_marca" text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "catalogo_publico" boolean DEFAULT false NOT NULL;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "referido_por" text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "referido_acreditado" boolean DEFAULT false NOT NULL;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "referidos_total" integer DEFAULT 0 NOT NULL;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "banco_nombre" text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "banco_cuenta" text;

ALTER TABLE public."negocios" ADD COLUMN IF NOT EXISTS "banco_titular" text;

CREATE TABLE IF NOT EXISTS public."pagos_log" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "negocio_id" uuid NOT NULL,
  "dias" integer,
  "nuevo_acceso_hasta" bigint,
  "nota" text,
  "creado_en" timestamp with time zone DEFAULT now() NOT NULL,
  "monto" numeric,
  "metodo" text,
  "plan" text
);

CREATE TABLE IF NOT EXISTS public."productos" (
  "id" uuid NOT NULL,
  "negocio_id" uuid,
  "nombre" text NOT NULL,
  "codigo_barras" text,
  "precio_venta" numeric(12,2) NOT NULL,
  "costo" numeric(12,2) NOT NULL,
  "stock_actual" integer DEFAULT 0,
  "stock_minimo" integer DEFAULT 0,
  "tasa_itbis" numeric(5,2) DEFAULT 0.18,
  "actualizado_en" timestamp with time zone DEFAULT now(),
  "tipo" text DEFAULT 'simple'::text,
  "fecha_actualizacion" bigint DEFAULT 0,
  "precio_2" numeric,
  "precio_3" numeric,
  "ubicacion" text,
  "serializable" boolean DEFAULT false,
  "imagen_url" text,
  "eliminado" boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS public."reparaciones" (
  "id" uuid NOT NULL,
  "negocio_id" uuid NOT NULL,
  "sucursal_id" uuid,
  "folio" text NOT NULL,
  "cliente_id" uuid,
  "cliente_nombre" text NOT NULL,
  "cliente_telefono" text,
  "equipo_marca" text,
  "equipo_modelo" text NOT NULL,
  "equipo_imei" text,
  "equipo_color" text,
  "patron_clave" text,
  "condicion_entrada" text,
  "accesorios" text,
  "problema_reportado" text NOT NULL,
  "diagnostico" text,
  "estado" text DEFAULT 'recibido'::text NOT NULL,
  "repuestos" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "mano_obra" numeric DEFAULT 0 NOT NULL,
  "total" numeric DEFAULT 0 NOT NULL,
  "abono" numeric DEFAULT 0 NOT NULL,
  "metodo_abono" text,
  "metodo_pago_final" text,
  "garantia_dias" integer,
  "garantia_hasta" bigint,
  "tecnico_nombre" text,
  "notas" text,
  "fecha_creacion" bigint NOT NULL,
  "fecha_entrega" bigint,
  "fecha_actualizacion" bigint NOT NULL,
  "condicion_checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "pagos" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "es_garantia" boolean DEFAULT false,
  "reparacion_origen_id" uuid,
  "bitacora" jsonb DEFAULT '[]'::jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public."seriales" (
  "id" uuid NOT NULL,
  "negocio_id" uuid NOT NULL,
  "producto_id" uuid NOT NULL,
  "numero_serial" text NOT NULL,
  "estado" text DEFAULT 'disponible'::text NOT NULL,
  "venta_id" uuid,
  "fecha_venta" bigint,
  "fecha_actualizacion" bigint NOT NULL,
  "garantia_dias" integer,
  "garantia_hasta" bigint,
  "cliente_nombre" text,
  "precio_venta" numeric
);

CREATE TABLE IF NOT EXISTS public."sucursales" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "negocio_id" uuid NOT NULL,
  "nombre" text NOT NULL,
  "direccion" text,
  "fecha_creacion" bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public."transacciones_fiado" (
  "id" uuid NOT NULL,
  "negocio_id" uuid NOT NULL,
  "cliente_id" uuid NOT NULL,
  "venta_id" uuid,
  "tipo" text NOT NULL,
  "monto" numeric NOT NULL,
  "concepto" text NOT NULL,
  "fecha_creacion" timestamp with time zone DEFAULT now() NOT NULL,
  "estado_sincronizacion" smallint DEFAULT 1,
  "fecha_actualizacion" bigint NOT NULL,
  "sucursal_id" uuid
);

CREATE TABLE IF NOT EXISTS public."usuarios_negocio" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "negocio_id" uuid NOT NULL,
  "user_id" uuid,
  "nombre" text NOT NULL,
  "email" text NOT NULL,
  "rol" text DEFAULT 'cajero'::text NOT NULL,
  "activo" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "invite_token" uuid DEFAULT gen_random_uuid()
);

CREATE TABLE IF NOT EXISTS public."venta_detalles" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "venta_id" uuid NOT NULL,
  "producto_id" uuid,
  "negocio_id" uuid NOT NULL,
  "sucursal_id" uuid,
  "cantidad" numeric NOT NULL,
  "precio_unitario" numeric NOT NULL,
  "subtotal" numeric NOT NULL,
  "fecha_creacion" bigint NOT NULL,
  "nombre" text
);

CREATE TABLE IF NOT EXISTS public."ventas" (
  "id" uuid NOT NULL,
  "negocio_id" text NOT NULL,
  "total" numeric NOT NULL,
  "metodo_pago" text NOT NULL,
  "fecha_creacion" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT timezone('utc'::text, now()),
  "sucursal_id" uuid,
  "numero_ticket" integer,
  "monto_efectivo" numeric(12,2),
  "monto_transferencia" numeric(12,2),
  "cliente_id" uuid,
  "ncf" text,
  "vendedor_id" uuid,
  "vendedor_nombre" text,
  "caja_codigo" text,
  "cliente_nombre" text
);

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."apartados"'::pg_catalog.regclass AND conname='apartados_pkey') THEN
    ALTER TABLE public."apartados" ADD CONSTRAINT "apartados_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."cajas"'::pg_catalog.regclass AND conname='cajas_estado_check') THEN
    ALTER TABLE public."cajas" ADD CONSTRAINT "cajas_estado_check" CHECK (estado = ANY (ARRAY['abierta'::text, 'cerrada'::text]));
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."cajas"'::pg_catalog.regclass AND conname='cajas_pkey') THEN
    ALTER TABLE public."cajas" ADD CONSTRAINT "cajas_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."clientes"'::pg_catalog.regclass AND conname='clientes_pkey') THEN
    ALTER TABLE public."clientes" ADD CONSTRAINT "clientes_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."composiciones"'::pg_catalog.regclass AND conname='composiciones_pkey') THEN
    ALTER TABLE public."composiciones" ADD CONSTRAINT "composiciones_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."cortes_caja"'::pg_catalog.regclass AND conname='cortes_caja_pkey') THEN
    ALTER TABLE public."cortes_caja" ADD CONSTRAINT "cortes_caja_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."cortes_caja"'::pg_catalog.regclass AND conname='cortes_caja_tipo_check') THEN
    ALTER TABLE public."cortes_caja" ADD CONSTRAINT "cortes_caja_tipo_check" CHECK (tipo = ANY (ARRAY['X'::text, 'Z'::text]));
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."detalles_ventas"'::pg_catalog.regclass AND conname='detalles_ventas_pkey') THEN
    ALTER TABLE public."detalles_ventas" ADD CONSTRAINT "detalles_ventas_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."devoluciones"'::pg_catalog.regclass AND conname='devoluciones_pkey') THEN
    ALTER TABLE public."devoluciones" ADD CONSTRAINT "devoluciones_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."gastos"'::pg_catalog.regclass AND conname='gastos_pkey') THEN
    ALTER TABLE public."gastos" ADD CONSTRAINT "gastos_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."inventario_sucursales"'::pg_catalog.regclass AND conname='inventario_sucursales_pkey') THEN
    ALTER TABLE public."inventario_sucursales" ADD CONSTRAINT "inventario_sucursales_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."inventario_sucursales"'::pg_catalog.regclass AND conname='inventario_sucursales_sucursal_id_producto_id_key') THEN
    ALTER TABLE public."inventario_sucursales" ADD CONSTRAINT "inventario_sucursales_sucursal_id_producto_id_key" UNIQUE (sucursal_id, producto_id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."movimientos_stock"'::pg_catalog.regclass AND conname='movimientos_stock_pkey') THEN
    ALTER TABLE public."movimientos_stock" ADD CONSTRAINT "movimientos_stock_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."ncf_secuencias"'::pg_catalog.regclass AND conname='ncf_secuencias_pkey') THEN
    ALTER TABLE public."ncf_secuencias" ADD CONSTRAINT "ncf_secuencias_pkey" PRIMARY KEY (negocio_id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."negocios"'::pg_catalog.regclass AND conname='negocios_codigo_referido_key') THEN
    ALTER TABLE public."negocios" ADD CONSTRAINT "negocios_codigo_referido_key" UNIQUE (codigo_referido);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."negocios"'::pg_catalog.regclass AND conname='negocios_pkey') THEN
    ALTER TABLE public."negocios" ADD CONSTRAINT "negocios_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."pagos_log"'::pg_catalog.regclass AND conname='pagos_log_pkey') THEN
    ALTER TABLE public."pagos_log" ADD CONSTRAINT "pagos_log_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."productos"'::pg_catalog.regclass AND conname='productos_pkey') THEN
    ALTER TABLE public."productos" ADD CONSTRAINT "productos_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."reparaciones"'::pg_catalog.regclass AND conname='reparaciones_pkey') THEN
    ALTER TABLE public."reparaciones" ADD CONSTRAINT "reparaciones_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."seriales"'::pg_catalog.regclass AND conname='seriales_estado_check') THEN
    ALTER TABLE public."seriales" ADD CONSTRAINT "seriales_estado_check" CHECK (estado = ANY (ARRAY['disponible'::text, 'vendido'::text]));
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."seriales"'::pg_catalog.regclass AND conname='seriales_negocio_id_numero_serial_key') THEN
    ALTER TABLE public."seriales" ADD CONSTRAINT "seriales_negocio_id_numero_serial_key" UNIQUE (negocio_id, numero_serial);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."seriales"'::pg_catalog.regclass AND conname='seriales_pkey') THEN
    ALTER TABLE public."seriales" ADD CONSTRAINT "seriales_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."sucursales"'::pg_catalog.regclass AND conname='sucursales_pkey') THEN
    ALTER TABLE public."sucursales" ADD CONSTRAINT "sucursales_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."transacciones_fiado"'::pg_catalog.regclass AND conname='transacciones_fiado_monto_check') THEN
    ALTER TABLE public."transacciones_fiado" ADD CONSTRAINT "transacciones_fiado_monto_check" CHECK (monto > 0::numeric);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."transacciones_fiado"'::pg_catalog.regclass AND conname='transacciones_fiado_pkey') THEN
    ALTER TABLE public."transacciones_fiado" ADD CONSTRAINT "transacciones_fiado_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."transacciones_fiado"'::pg_catalog.regclass AND conname='transacciones_fiado_tipo_check') THEN
    ALTER TABLE public."transacciones_fiado" ADD CONSTRAINT "transacciones_fiado_tipo_check" CHECK (tipo = ANY (ARRAY['cargo'::text, 'abono'::text]));
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."usuarios_negocio"'::pg_catalog.regclass AND conname='usuarios_negocio_pkey') THEN
    ALTER TABLE public."usuarios_negocio" ADD CONSTRAINT "usuarios_negocio_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."usuarios_negocio"'::pg_catalog.regclass AND conname='usuarios_negocio_rol_check') THEN
    ALTER TABLE public."usuarios_negocio" ADD CONSTRAINT "usuarios_negocio_rol_check" CHECK (rol = ANY (ARRAY['admin'::text, 'vendedor'::text, 'cajero'::text]));
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."venta_detalles"'::pg_catalog.regclass AND conname='venta_detalles_pkey') THEN
    ALTER TABLE public."venta_detalles" ADD CONSTRAINT "venta_detalles_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."ventas"'::pg_catalog.regclass AND conname='ventas_pkey') THEN
    ALTER TABLE public."ventas" ADD CONSTRAINT "ventas_pkey" PRIMARY KEY (id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."composiciones"'::pg_catalog.regclass AND conname='composiciones_insumo_id_fkey') THEN
    ALTER TABLE public."composiciones" ADD CONSTRAINT "composiciones_insumo_id_fkey" FOREIGN KEY (insumo_id) REFERENCES public.productos(id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."composiciones"'::pg_catalog.regclass AND conname='composiciones_negocio_id_fkey') THEN
    ALTER TABLE public."composiciones" ADD CONSTRAINT "composiciones_negocio_id_fkey" FOREIGN KEY (negocio_id) REFERENCES public.negocios(id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."composiciones"'::pg_catalog.regclass AND conname='composiciones_producto_padre_id_fkey') THEN
    ALTER TABLE public."composiciones" ADD CONSTRAINT "composiciones_producto_padre_id_fkey" FOREIGN KEY (producto_padre_id) REFERENCES public.productos(id) ON DELETE CASCADE;
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."cortes_caja"'::pg_catalog.regclass AND conname='cortes_caja_negocio_id_fkey') THEN
    ALTER TABLE public."cortes_caja" ADD CONSTRAINT "cortes_caja_negocio_id_fkey" FOREIGN KEY (negocio_id) REFERENCES public.negocios(id) ON DELETE CASCADE;
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."detalles_ventas"'::pg_catalog.regclass AND conname='detalles_ventas_producto_id_fkey') THEN
    ALTER TABLE public."detalles_ventas" ADD CONSTRAINT "detalles_ventas_producto_id_fkey" FOREIGN KEY (producto_id) REFERENCES public.productos(id);
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."detalles_ventas"'::pg_catalog.regclass AND conname='detalles_ventas_venta_id_fkey') THEN
    ALTER TABLE public."detalles_ventas" ADD CONSTRAINT "detalles_ventas_venta_id_fkey" FOREIGN KEY (venta_id) REFERENCES public.ventas(id) ON DELETE CASCADE;
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."devoluciones"'::pg_catalog.regclass AND conname='devoluciones_venta_id_fkey') THEN
    ALTER TABLE public."devoluciones" ADD CONSTRAINT "devoluciones_venta_id_fkey" FOREIGN KEY (venta_id) REFERENCES public.ventas(id) ON DELETE CASCADE;
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."negocios"'::pg_catalog.regclass AND conname='negocios_dueño_id_fkey') THEN
    ALTER TABLE public."negocios" ADD CONSTRAINT "negocios_dueño_id_fkey" FOREIGN KEY ("dueño_id") REFERENCES auth.users(id) ON DELETE CASCADE NOT VALID;
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."productos"'::pg_catalog.regclass AND conname='productos_negocio_id_fkey') THEN
    ALTER TABLE public."productos" ADD CONSTRAINT "productos_negocio_id_fkey" FOREIGN KEY (negocio_id) REFERENCES public.negocios(id) NOT VALID;
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."usuarios_negocio"'::pg_catalog.regclass AND conname='usuarios_negocio_negocio_id_fkey') THEN
    ALTER TABLE public."usuarios_negocio" ADD CONSTRAINT "usuarios_negocio_negocio_id_fkey" FOREIGN KEY (negocio_id) REFERENCES public.negocios(id) ON DELETE CASCADE NOT VALID;
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."usuarios_negocio"'::pg_catalog.regclass AND conname='usuarios_negocio_user_id_fkey') THEN
    ALTER TABLE public."usuarios_negocio" ADD CONSTRAINT "usuarios_negocio_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL NOT VALID;
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."ventas"'::pg_catalog.regclass AND conname='ventas_cliente_id_fkey') THEN
    ALTER TABLE public."ventas" ADD CONSTRAINT "ventas_cliente_id_fkey" FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE SET NULL;
  END IF;
END; $pro00_constraint$;

DO $pro00_constraint$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public."ventas"'::pg_catalog.regclass AND conname='ventas_vendedor_id_fkey') THEN
    ALTER TABLE public."ventas" ADD CONSTRAINT "ventas_vendedor_id_fkey" FOREIGN KEY (vendedor_id) REFERENCES auth.users(id);
  END IF;
END; $pro00_constraint$;

CREATE INDEX IF NOT EXISTS idx_apartados_fecha_act ON public.apartados USING btree (negocio_id, fecha_actualizacion);

CREATE INDEX IF NOT EXISTS idx_apartados_negocio ON public.apartados USING btree (negocio_id);

CREATE INDEX IF NOT EXISTS idx_cajas_fecha_actualizacion ON public.cajas USING btree (fecha_actualizacion);

CREATE INDEX IF NOT EXISTS idx_cajas_negocio_id ON public.cajas USING btree (negocio_id);

CREATE INDEX IF NOT EXISTS idx_cajas_sucursal_id ON public.cajas USING btree (sucursal_id);

CREATE INDEX IF NOT EXISTS idx_devoluciones_negocio ON public.devoluciones USING btree (negocio_id);

CREATE INDEX IF NOT EXISTS idx_devoluciones_venta ON public.devoluciones USING btree (venta_id);

CREATE INDEX IF NOT EXISTS idx_gastos_negocio ON public.gastos USING btree (negocio_id, fecha_creacion DESC);

CREATE INDEX IF NOT EXISTS idx_mov_stock_negocio ON public.movimientos_stock USING btree (negocio_id, fecha_creacion DESC);

CREATE INDEX IF NOT EXISTS idx_mov_stock_producto ON public.movimientos_stock USING btree (producto_id, fecha_creacion DESC);

CREATE UNIQUE INDEX IF NOT EXISTS negocios_dueno_unico ON public.negocios USING btree ("dueño_id") WHERE ("dueño_id" IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_pagos_log_negocio ON public.pagos_log USING btree (negocio_id, creado_en DESC);

CREATE INDEX IF NOT EXISTS idx_reparaciones_fecha_act ON public.reparaciones USING btree (negocio_id, fecha_actualizacion);

CREATE INDEX IF NOT EXISTS idx_reparaciones_imei ON public.reparaciones USING btree (negocio_id, equipo_imei);

CREATE INDEX IF NOT EXISTS idx_reparaciones_negocio ON public.reparaciones USING btree (negocio_id);

CREATE INDEX IF NOT EXISTS idx_transacciones_fiado_cliente ON public.transacciones_fiado USING btree (cliente_id);

CREATE INDEX IF NOT EXISTS idx_transacciones_fiado_negocio ON public.transacciones_fiado USING btree (negocio_id);

CREATE INDEX IF NOT EXISTS idx_usuarios_negocio_negocio_id ON public.usuarios_negocio USING btree (negocio_id);

CREATE INDEX IF NOT EXISTS idx_usuarios_negocio_user_id ON public.usuarios_negocio USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_venta_detalles_negocio ON public.venta_detalles USING btree (negocio_id);

CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON public.ventas USING btree (cliente_id);

DO $pro00_function$ BEGIN
  IF pg_catalog.to_regprocedure('public."configurar_ncf"(uuid, text, bigint, bigint, boolean)') IS NULL THEN
    EXECUTE $pro00_definition$CREATE FUNCTION public."configurar_ncf"(p_negocio_id uuid, p_tipo text, p_desde bigint, p_hasta bigint, p_habilitado boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $function$
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
$function$
$pro00_definition$;
    REVOKE ALL ON FUNCTION public."configurar_ncf"(uuid, text, bigint, bigint, boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public."configurar_ncf"(uuid, text, bigint, bigint, boolean) TO service_role;
    GRANT EXECUTE ON FUNCTION public."configurar_ncf"(uuid, text, bigint, bigint, boolean) TO authenticated;
  END IF;
END; $pro00_function$;

DO $pro00_function$ BEGIN
  IF pg_catalog.to_regprocedure('public."get_negocio_id"()') IS NULL THEN
    EXECUTE $pro00_definition$CREATE FUNCTION public."get_negocio_id"()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $function$
  SELECT id::text FROM public.negocios WHERE dueño_id = auth.uid() LIMIT 1;
$function$
$pro00_definition$;
    REVOKE ALL ON FUNCTION public."get_negocio_id"() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public."get_negocio_id"() TO service_role;
    GRANT EXECUTE ON FUNCTION public."get_negocio_id"() TO authenticated;
  END IF;
END; $pro00_function$;

DO $pro00_function$ BEGIN
  IF pg_catalog.to_regprocedure('public."handle_new_user"()') IS NULL THEN
    EXECUTE $pro00_definition$CREATE FUNCTION public."handle_new_user"()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $function$
BEGIN
  -- Si es un empleado, no crear negocio
  IF (new.raw_user_meta_data->>'is_empleado' = 'true') THEN
    RETURN new;
  END IF;

  INSERT INTO public.negocios (dueño_id, nombre)
  VALUES (new.id, new.raw_user_meta_data->>'nombre_negocio');

  RETURN new;
END;
$function$
$pro00_definition$;
    REVOKE ALL ON FUNCTION public."handle_new_user"() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public."handle_new_user"() TO service_role;
  END IF;
END; $pro00_function$;

DO $pro00_function$ BEGIN
  IF pg_catalog.to_regprocedure('public."mis_negocio_ids"()') IS NULL THEN
    EXECUTE $pro00_definition$CREATE FUNCTION public."mis_negocio_ids"()
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $function$
  SELECT id::text FROM public.negocios
  WHERE dueño_id::text = auth.uid()::text
  UNION
  SELECT negocio_id::text FROM public.usuarios_negocio
  WHERE user_id::text = auth.uid()::text AND activo = true
$function$
$pro00_definition$;
    REVOKE ALL ON FUNCTION public."mis_negocio_ids"() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public."mis_negocio_ids"() TO service_role;
    GRANT EXECUTE ON FUNCTION public."mis_negocio_ids"() TO authenticated;
  END IF;
END; $pro00_function$;

DO $pro00_function$ BEGIN
  IF pg_catalog.to_regprocedure('public."reservar_ncf"(uuid, integer)') IS NULL THEN
    EXECUTE $pro00_definition$CREATE FUNCTION public."reservar_ncf"(p_negocio_id uuid, p_cantidad integer DEFAULT 20)
 RETURNS TABLE(bloque_desde bigint, bloque_hasta bigint, tipo text)
 LANGUAGE plpgsql
 SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $function$
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
$function$
$pro00_definition$;
    REVOKE ALL ON FUNCTION public."reservar_ncf"(uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public."reservar_ncf"(uuid, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public."reservar_ncf"(uuid, integer) TO authenticated;
  END IF;
END; $pro00_function$;

DO $pro00_function$ BEGIN
  IF pg_catalog.to_regprocedure('public."salud_negocios"()') IS NULL THEN
    EXECUTE $pro00_definition$CREATE FUNCTION public."salud_negocios"()
 RETURNS TABLE(negocio_id text, ultima_venta bigint, ventas_7d integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $function$
    select
        negocio_id::text,
        max(fecha_creacion)::bigint,
        (count(*) filter (
            where fecha_creacion > (extract(epoch from now()) * 1000 - 7 * 86400000)
        ))::int
    from ventas
    group by negocio_id;
$function$
$pro00_definition$;
    REVOKE ALL ON FUNCTION public."salud_negocios"() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public."salud_negocios"() TO service_role;
  END IF;
END; $pro00_function$;

DO $pro00_function$ BEGIN
  IF pg_catalog.to_regprocedure('public."total_ventas_negocio"(uuid)') IS NULL THEN
    EXECUTE $pro00_definition$CREATE FUNCTION public."total_ventas_negocio"(p_negocio_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $function$
    select coalesce(sum(total), 0) from ventas where negocio_id::text = p_negocio_id::text;
$function$
$pro00_definition$;
    REVOKE ALL ON FUNCTION public."total_ventas_negocio"(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public."total_ventas_negocio"(uuid) TO service_role;
  END IF;
END; $pro00_function$;

DO $pro00_trigger$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='auth."users"'::pg_catalog.regclass AND tgname='on_auth_user_created') THEN
    CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public."handle_new_user"();
  END IF;
END; $pro00_trigger$;

DO $pro00_trigger$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public."apartados"'::pg_catalog.regclass AND tgname='trg_normalizar_fecha_apartados') THEN
    CREATE TRIGGER trg_normalizar_fecha_apartados BEFORE INSERT OR UPDATE ON public."apartados" FOR EACH ROW EXECUTE FUNCTION public."normalizar_fecha_actualizacion"();
  END IF;
END; $pro00_trigger$;

DO $pro00_trigger$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public."cajas"'::pg_catalog.regclass AND tgname='trg_normalizar_fecha_cajas') THEN
    CREATE TRIGGER trg_normalizar_fecha_cajas BEFORE INSERT OR UPDATE ON public."cajas" FOR EACH ROW EXECUTE FUNCTION public."normalizar_fecha_actualizacion"();
  END IF;
END; $pro00_trigger$;

DO $pro00_trigger$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public."clientes"'::pg_catalog.regclass AND tgname='trg_normalizar_fecha_clientes') THEN
    CREATE TRIGGER trg_normalizar_fecha_clientes BEFORE INSERT OR UPDATE ON public."clientes" FOR EACH ROW EXECUTE FUNCTION public."normalizar_fecha_actualizacion"();
  END IF;
END; $pro00_trigger$;

DO $pro00_trigger$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public."composiciones"'::pg_catalog.regclass AND tgname='trg_normalizar_fecha_composiciones') THEN
    CREATE TRIGGER trg_normalizar_fecha_composiciones BEFORE INSERT OR UPDATE ON public."composiciones" FOR EACH ROW EXECUTE FUNCTION public."normalizar_fecha_actualizacion"();
  END IF;
END; $pro00_trigger$;

DO $pro00_trigger$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public."productos"'::pg_catalog.regclass AND tgname='trg_normalizar_fecha_productos') THEN
    CREATE TRIGGER trg_normalizar_fecha_productos BEFORE INSERT OR UPDATE ON public."productos" FOR EACH ROW EXECUTE FUNCTION public."normalizar_fecha_actualizacion"();
  END IF;
END; $pro00_trigger$;

DO $pro00_trigger$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public."reparaciones"'::pg_catalog.regclass AND tgname='trg_normalizar_fecha_reparaciones') THEN
    CREATE TRIGGER trg_normalizar_fecha_reparaciones BEFORE INSERT OR UPDATE ON public."reparaciones" FOR EACH ROW EXECUTE FUNCTION public."normalizar_fecha_actualizacion"();
  END IF;
END; $pro00_trigger$;

ALTER TABLE public."apartados" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."apartados" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."apartados" TO authenticated, service_role;

ALTER TABLE public."cajas" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."cajas" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."cajas" TO authenticated, service_role;

ALTER TABLE public."clientes" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."clientes" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."clientes" TO authenticated, service_role;

ALTER TABLE public."composiciones" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."composiciones" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."composiciones" TO authenticated, service_role;

ALTER TABLE public."cortes_caja" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."cortes_caja" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."cortes_caja" TO authenticated, service_role;

ALTER TABLE public."detalles_ventas" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."detalles_ventas" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."detalles_ventas" TO authenticated, service_role;

ALTER TABLE public."devoluciones" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."devoluciones" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."devoluciones" TO authenticated, service_role;

ALTER TABLE public."gastos" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."gastos" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."gastos" TO authenticated, service_role;

ALTER TABLE public."inventario_sucursales" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."movimientos_stock" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."ncf_secuencias" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."ncf_secuencias" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."ncf_secuencias" TO authenticated, service_role;

ALTER TABLE public."negocios" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."pagos_log" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."pagos_log" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."pagos_log" TO authenticated, service_role;

ALTER TABLE public."productos" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."reparaciones" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."reparaciones" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."reparaciones" TO authenticated, service_role;

ALTER TABLE public."seriales" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."seriales" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."seriales" TO authenticated, service_role;

ALTER TABLE public."sucursales" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."transacciones_fiado" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."transacciones_fiado" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."transacciones_fiado" TO authenticated, service_role;

ALTER TABLE public."usuarios_negocio" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."venta_detalles" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."venta_detalles" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."venta_detalles" TO authenticated, service_role;

ALTER TABLE public."ventas" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."ventas" FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."ventas" TO authenticated, service_role;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."apartados"'::pg_catalog.regclass AND polname='apartados_delete') THEN
    CREATE POLICY "apartados_delete" ON public."apartados" AS PERMISSIVE FOR DELETE TO authenticated USING (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."apartados"'::pg_catalog.regclass AND polname='apartados_insert') THEN
    CREATE POLICY "apartados_insert" ON public."apartados" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."apartados"'::pg_catalog.regclass AND polname='apartados_select') THEN
    CREATE POLICY "apartados_select" ON public."apartados" AS PERMISSIVE FOR SELECT TO authenticated USING (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."apartados"'::pg_catalog.regclass AND polname='apartados_update') THEN
    CREATE POLICY "apartados_update" ON public."apartados" AS PERMISSIVE FOR UPDATE TO authenticated USING (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."cajas"'::pg_catalog.regclass AND polname='Empleados pueden acceder cajas') THEN
    CREATE POLICY "Empleados pueden acceder cajas" ON public."cajas" AS PERMISSIVE FOR ALL TO authenticated USING ((negocio_id IN ( SELECT mis_negocio_ids() AS mis_negocio_ids)));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."cajas"'::pg_catalog.regclass AND polname='cajas_negocio') THEN
    CREATE POLICY "cajas_negocio" ON public."cajas" AS PERMISSIVE FOR ALL TO authenticated USING ((negocio_id = get_negocio_id())) WITH CHECK ((negocio_id = get_negocio_id()));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."clientes"'::pg_catalog.regclass AND polname='Empleados pueden acceder clientes') THEN
    CREATE POLICY "Empleados pueden acceder clientes" ON public."clientes" AS PERMISSIVE FOR ALL TO authenticated USING (((negocio_id)::text IN ( SELECT mis_negocio_ids() AS mis_negocio_ids)));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."clientes"'::pg_catalog.regclass AND polname='clientes_negocio') THEN
    CREATE POLICY "clientes_negocio" ON public."clientes" AS PERMISSIVE FOR ALL TO authenticated USING (((negocio_id)::text = get_negocio_id())) WITH CHECK (((negocio_id)::text = get_negocio_id()));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."composiciones"'::pg_catalog.regclass AND polname='composiciones_negocio') THEN
    CREATE POLICY "composiciones_negocio" ON public."composiciones" AS PERMISSIVE FOR ALL TO authenticated USING (((negocio_id)::text = get_negocio_id())) WITH CHECK (((negocio_id)::text = get_negocio_id()));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."cortes_caja"'::pg_catalog.regclass AND polname='Empleados pueden acceder cortes') THEN
    CREATE POLICY "Empleados pueden acceder cortes" ON public."cortes_caja" AS PERMISSIVE FOR ALL TO authenticated USING (((negocio_id)::text IN ( SELECT mis_negocio_ids() AS mis_negocio_ids)));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."cortes_caja"'::pg_catalog.regclass AND polname='tenant_all') THEN
    CREATE POLICY "tenant_all" ON public."cortes_caja" AS PERMISSIVE FOR ALL TO authenticated USING (es_miembro_del_negocio(negocio_id)) WITH CHECK (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."devoluciones"'::pg_catalog.regclass AND polname='Empleados pueden acceder devoluciones') THEN
    CREATE POLICY "Empleados pueden acceder devoluciones" ON public."devoluciones" AS PERMISSIVE FOR ALL TO authenticated USING ((negocio_id IN ( SELECT mis_negocio_ids() AS mis_negocio_ids)));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."devoluciones"'::pg_catalog.regclass AND polname='tenant_devoluciones') THEN
    CREATE POLICY "tenant_devoluciones" ON public."devoluciones" AS PERMISSIVE FOR ALL TO authenticated USING ((negocio_id = get_negocio_id()));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."gastos"'::pg_catalog.regclass AND polname='gastos_delete') THEN
    CREATE POLICY "gastos_delete" ON public."gastos" AS PERMISSIVE FOR DELETE TO authenticated USING (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."gastos"'::pg_catalog.regclass AND polname='gastos_insert') THEN
    CREATE POLICY "gastos_insert" ON public."gastos" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."gastos"'::pg_catalog.regclass AND polname='gastos_select') THEN
    CREATE POLICY "gastos_select" ON public."gastos" AS PERMISSIVE FOR SELECT TO authenticated USING (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."gastos"'::pg_catalog.regclass AND polname='gastos_update') THEN
    CREATE POLICY "gastos_update" ON public."gastos" AS PERMISSIVE FOR UPDATE TO authenticated USING (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."inventario_sucursales"'::pg_catalog.regclass AND polname='Dueño puede gestionar inventario de sus sucursales') THEN
    CREATE POLICY "Dueño puede gestionar inventario de sus sucursales" ON public."inventario_sucursales" AS PERMISSIVE FOR ALL TO authenticated USING ((sucursal_id IN ( SELECT s.id
   FROM (sucursales s
     JOIN negocios n ON ((n.id = s.negocio_id)))
  WHERE (n."dueño_id" = auth.uid())))) WITH CHECK ((sucursal_id IN ( SELECT s.id
   FROM (sucursales s
     JOIN negocios n ON ((n.id = s.negocio_id)))
  WHERE (n."dueño_id" = auth.uid()))));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."inventario_sucursales"'::pg_catalog.regclass AND polname='dueno_manage_inventario') THEN
    CREATE POLICY "dueno_manage_inventario" ON public."inventario_sucursales" AS PERMISSIVE FOR ALL TO authenticated USING ((sucursal_id IN ( SELECT s.id
   FROM (sucursales s
     JOIN negocios n ON ((n.id = s.negocio_id)))
  WHERE (n."dueño_id" = auth.uid()))));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."inventario_sucursales"'::pg_catalog.regclass AND polname='inventario_sucursales_negocio') THEN
    CREATE POLICY "inventario_sucursales_negocio" ON public."inventario_sucursales" AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM sucursales s
  WHERE ((s.id = inventario_sucursales.sucursal_id) AND ((s.negocio_id)::text = get_negocio_id()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM sucursales s
  WHERE ((s.id = inventario_sucursales.sucursal_id) AND ((s.negocio_id)::text = get_negocio_id())))));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."movimientos_stock"'::pg_catalog.regclass AND polname='mov_stock_insert') THEN
    CREATE POLICY "mov_stock_insert" ON public."movimientos_stock" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."movimientos_stock"'::pg_catalog.regclass AND polname='mov_stock_select') THEN
    CREATE POLICY "mov_stock_select" ON public."movimientos_stock" AS PERMISSIVE FOR SELECT TO authenticated USING (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."ncf_secuencias"'::pg_catalog.regclass AND polname='ncf_select') THEN
    CREATE POLICY "ncf_select" ON public."ncf_secuencias" AS PERMISSIVE FOR SELECT TO authenticated USING (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."negocios"'::pg_catalog.regclass AND polname='Empleados pueden leer su negocio') THEN
    CREATE POLICY "Empleados pueden leer su negocio" ON public."negocios" AS PERMISSIVE FOR SELECT TO authenticated USING (((id)::text IN ( SELECT mis_negocio_ids() AS mis_negocio_ids)));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."negocios"'::pg_catalog.regclass AND polname='negocios_owner') THEN
    CREATE POLICY "negocios_owner" ON public."negocios" AS PERMISSIVE FOR ALL TO authenticated USING (("dueño_id" = auth.uid())) WITH CHECK (("dueño_id" = auth.uid()));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."productos"'::pg_catalog.regclass AND polname='Empleados pueden leer productos') THEN
    CREATE POLICY "Empleados pueden leer productos" ON public."productos" AS PERMISSIVE FOR SELECT TO authenticated USING (((negocio_id)::text IN ( SELECT mis_negocio_ids() AS mis_negocio_ids)));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."productos"'::pg_catalog.regclass AND polname='Empleados pueden modificar productos') THEN
    CREATE POLICY "Empleados pueden modificar productos" ON public."productos" AS PERMISSIVE FOR ALL TO authenticated USING (((negocio_id)::text IN ( SELECT mis_negocio_ids() AS mis_negocio_ids)));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."productos"'::pg_catalog.regclass AND polname='productos_negocio') THEN
    CREATE POLICY "productos_negocio" ON public."productos" AS PERMISSIVE FOR ALL TO authenticated USING (((negocio_id)::text = get_negocio_id())) WITH CHECK (((negocio_id)::text = get_negocio_id()));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."reparaciones"'::pg_catalog.regclass AND polname='reparaciones_delete') THEN
    CREATE POLICY "reparaciones_delete" ON public."reparaciones" AS PERMISSIVE FOR DELETE TO authenticated USING (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."reparaciones"'::pg_catalog.regclass AND polname='reparaciones_insert') THEN
    CREATE POLICY "reparaciones_insert" ON public."reparaciones" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."reparaciones"'::pg_catalog.regclass AND polname='reparaciones_select') THEN
    CREATE POLICY "reparaciones_select" ON public."reparaciones" AS PERMISSIVE FOR SELECT TO authenticated USING (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."reparaciones"'::pg_catalog.regclass AND polname='reparaciones_update') THEN
    CREATE POLICY "reparaciones_update" ON public."reparaciones" AS PERMISSIVE FOR UPDATE TO authenticated USING (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."seriales"'::pg_catalog.regclass AND polname='tenant_all') THEN
    CREATE POLICY "tenant_all" ON public."seriales" AS PERMISSIVE FOR ALL TO authenticated USING (es_miembro_del_negocio(negocio_id)) WITH CHECK (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."sucursales"'::pg_catalog.regclass AND polname='Empleados pueden leer sucursales') THEN
    CREATE POLICY "Empleados pueden leer sucursales" ON public."sucursales" AS PERMISSIVE FOR SELECT TO authenticated USING (((negocio_id)::text IN ( SELECT mis_negocio_ids() AS mis_negocio_ids)));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."sucursales"'::pg_catalog.regclass AND polname='sucursales_negocio') THEN
    CREATE POLICY "sucursales_negocio" ON public."sucursales" AS PERMISSIVE FOR ALL TO authenticated USING (((negocio_id)::text = get_negocio_id())) WITH CHECK (((negocio_id)::text = get_negocio_id()));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."transacciones_fiado"'::pg_catalog.regclass AND polname='Empleados pueden acceder fiado') THEN
    CREATE POLICY "Empleados pueden acceder fiado" ON public."transacciones_fiado" AS PERMISSIVE FOR ALL TO authenticated USING (((negocio_id)::text IN ( SELECT mis_negocio_ids() AS mis_negocio_ids)));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."transacciones_fiado"'::pg_catalog.regclass AND polname='transacciones_fiado_negocio') THEN
    CREATE POLICY "transacciones_fiado_negocio" ON public."transacciones_fiado" AS PERMISSIVE FOR ALL TO authenticated USING (((negocio_id)::text = get_negocio_id())) WITH CHECK (((negocio_id)::text = get_negocio_id()));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."usuarios_negocio"'::pg_catalog.regclass AND polname='Empleados pueden leer su fila') THEN
    CREATE POLICY "Empleados pueden leer su fila" ON public."usuarios_negocio" AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id)::text = (auth.uid())::text));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."usuarios_negocio"'::pg_catalog.regclass AND polname='un_delete') THEN
    CREATE POLICY "un_delete" ON public."usuarios_negocio" AS PERMISSIVE FOR DELETE TO authenticated USING (es_admin_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."usuarios_negocio"'::pg_catalog.regclass AND polname='un_insert') THEN
    CREATE POLICY "un_insert" ON public."usuarios_negocio" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (es_admin_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."usuarios_negocio"'::pg_catalog.regclass AND polname='un_select') THEN
    CREATE POLICY "un_select" ON public."usuarios_negocio" AS PERMISSIVE FOR SELECT TO authenticated USING (es_miembro_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."usuarios_negocio"'::pg_catalog.regclass AND polname='un_update') THEN
    CREATE POLICY "un_update" ON public."usuarios_negocio" AS PERMISSIVE FOR UPDATE TO authenticated USING (es_admin_del_negocio(negocio_id)) WITH CHECK (es_admin_del_negocio(negocio_id));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."venta_detalles"'::pg_catalog.regclass AND polname='Empleados pueden acceder detalles') THEN
    CREATE POLICY "Empleados pueden acceder detalles" ON public."venta_detalles" AS PERMISSIVE FOR ALL TO authenticated USING (((negocio_id)::text IN ( SELECT mis_negocio_ids() AS mis_negocio_ids)));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."venta_detalles"'::pg_catalog.regclass AND polname='venta_detalles_negocio') THEN
    CREATE POLICY "venta_detalles_negocio" ON public."venta_detalles" AS PERMISSIVE FOR ALL TO authenticated USING (((negocio_id)::text = get_negocio_id())) WITH CHECK (((negocio_id)::text = get_negocio_id()));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."ventas"'::pg_catalog.regclass AND polname='Empleados pueden acceder ventas') THEN
    CREATE POLICY "Empleados pueden acceder ventas" ON public."ventas" AS PERMISSIVE FOR ALL TO authenticated USING ((negocio_id IN ( SELECT mis_negocio_ids() AS mis_negocio_ids)));
  END IF;
END; $pro00_policy$;

DO $pro00_policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public."ventas"'::pg_catalog.regclass AND polname='ventas_negocio') THEN
    CREATE POLICY "ventas_negocio" ON public."ventas" AS PERMISSIVE FOR ALL TO authenticated USING ((negocio_id = get_negocio_id())) WITH CHECK ((negocio_id = get_negocio_id()));
  END IF;
END; $pro00_policy$;

COMMIT;
