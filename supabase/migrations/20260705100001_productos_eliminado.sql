-- Soft-delete y columnas opcionales de productos que el código ya usa.
-- 'eliminado' es la que faltaba: sin ella el borrado de un producto no se
-- propaga a los demás dispositivos (el pull filtra p.eliminado).
alter table productos add column if not exists eliminado boolean not null default false;
alter table productos add column if not exists ubicacion text;
alter table productos add column if not exists serializable boolean;
alter table productos add column if not exists precio_2 numeric;
alter table productos add column if not exists precio_3 numeric;
alter table productos add column if not exists imagen_url text;
