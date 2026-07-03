-- Catálogo público (mini-tienda por link). Opt-in del dueño; la API
-- pública solo expone productos si este flag está activo.
alter table negocios add column if not exists catalogo_publico boolean not null default false;
