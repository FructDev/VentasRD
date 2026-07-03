-- Programa de referidos: cada negocio tiene un código único para invitar;
-- al completar onboarding el invitado, ambos ganan días de acceso.
alter table negocios add column if not exists codigo_referido      text unique;
alter table negocios add column if not exists referido_por         text;
alter table negocios add column if not exists referido_acreditado  boolean not null default false;
alter table negocios add column if not exists referidos_total      int not null default 0;
