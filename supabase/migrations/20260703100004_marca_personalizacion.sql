-- Personalización por tienda: color de marca (clave de paleta curada)
-- y tipografía de títulos (clave del catálogo de fuentes).
alter table negocios add column if not exists color_marca  text;
alter table negocios add column if not exists fuente_marca text;
