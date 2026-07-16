-- Datos de pago del negocio para el QR de transferencia en el cobro:
-- el cliente escanea y ve banco/cuenta/titular + monto exacto, sin dictados
-- de números de cuenta ni errores de dedo.
alter table negocios add column if not exists banco_nombre  text;
alter table negocios add column if not exists banco_cuenta  text;
alter table negocios add column if not exists banco_titular text;
