-- ════════════════════════════════════════════════════════════════════════════
-- ACCESO / SUSCRIPCIÓN POR FECHA DE VENCIMIENTO
-- Reemplaza el booleano plan_activo (que nunca caducaba) por una fecha de acceso.
-- El acceso vence solo; cada pago la extiende. El cliente se bloquea tras 5 días
-- de gracia, incluso offline (la fecha se cachea en el dispositivo).
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Columna de vencimiento (timestamp en milisegundos)
alter table negocios add column if not exists acceso_hasta bigint;

-- 2. Backfill para negocios existentes (no bloquear a nadie de golpe):
--    usa trial_hasta si existe; si ya es cliente pagado, dale 30 días desde hoy.
update negocios
set acceso_hasta = coalesce(
    acceso_hasta,
    trial_hasta,
    case when plan_activo
         then (extract(epoch from now()) * 1000)::bigint + 30 * 86400000::bigint
         else (extract(epoch from now()) * 1000)::bigint
    end
)
where acceso_hasta is null;

-- ════════════════════════════════════════════════════════════════════════════
-- CÓMO REGISTRAR UN PAGO (manual, por ahora)
-- Extiende 30 días desde HOY o desde el vencimiento actual (lo que sea mayor),
-- así pagar antes de vencer no pierde días. Reemplaza el id del negocio.
-- ════════════════════════════════════════════════════════════════════════════
-- update negocios
-- set acceso_hasta = greatest(coalesce(acceso_hasta, 0), (extract(epoch from now()) * 1000)::bigint) + 30 * 86400000::bigint
-- where id = 'EL-ID-DEL-NEGOCIO';

-- Ver vencimientos (para tu control):
-- select id, nombre,
--        to_timestamp(acceso_hasta / 1000) as vence,
--        (acceso_hasta - extract(epoch from now())*1000) / 86400000 as dias_restantes
-- from negocios order by acceso_hasta;
