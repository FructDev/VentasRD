-- Nombre libre del cliente en la venta: aparece en la factura sin exigir
-- que el cliente esté registrado en el sistema (pedido de usuarios con
-- delivery: toda factura debe decir de quién es).
alter table ventas add column if not exists cliente_nombre text;
