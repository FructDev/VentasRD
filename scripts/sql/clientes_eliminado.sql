-- Borrado suave de clientes (se ocultan de las listas, se conserva el historial)
alter table clientes add column if not exists eliminado boolean default false;
