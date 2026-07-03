-- Nombre del producto congelado al momento de la venta.
-- Sobrevive a productos borrados y soporta la venta libre (sin producto).
alter table venta_detalles add column if not exists nombre text;
