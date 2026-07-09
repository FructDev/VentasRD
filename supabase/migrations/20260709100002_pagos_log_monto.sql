-- Cobro estructurado: el registro de pago guarda monto, método y plan.
-- Con esto pagos_log pasa de "bitácora de extensiones" a libro de facturación
-- (MRR, pagos del mes, historia por negocio).
alter table pagos_log add column if not exists monto numeric;
alter table pagos_log add column if not exists metodo text;   -- efectivo | transferencia | otro
alter table pagos_log add column if not exists plan text;     -- basico | pro (+ periodo en la nota)
