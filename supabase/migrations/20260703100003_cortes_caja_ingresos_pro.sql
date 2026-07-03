-- Hilo de dinero completo en el corte de caja: los cobros de reparaciones
-- y apartados del turno se registran junto a las ventas.
alter table cortes_caja add column if not exists ingreso_reparaciones numeric;
alter table cortes_caja add column if not exists ingreso_apartados numeric;
