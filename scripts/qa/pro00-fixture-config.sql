-- SOLO VentaRD Staging blzzinivvzadqjbnpsre: configuracion de fixtures propios.
-- No activa suscripciones reales, no credenciales/PIN, no stock ni historia.
BEGIN;
DO $qa_config$
BEGIN
  IF pg_catalog.to_regclass('public.inventario_operaciones_v2') IS NULL
    OR (SELECT count(*) FROM public.negocios WHERE
      (id='96000000-0000-4000-8000-000000000001'::uuid
        AND nombre='PRO00 QA A - SINTETICO'
        AND "dueño_id"='4e500fbf-a8a4-4a41-8928-06d222962a5c'::uuid) OR
      (id='96000000-0000-4000-8000-000000000002'::uuid
        AND nombre='PRO00 QA B - SINTETICO'
        AND "dueño_id"='162167f6-a75c-4084-9615-e5c7db505a84'::uuid))<>2
  THEN RAISE EXCEPTION 'PRO00_FIXTURE_CONFIG_GUARD_FAILED'; END IF;
END; $qa_config$;
UPDATE public.negocios
SET plan_activo=true, plan_tier='pro', onboarding_completado=true
WHERE (id='96000000-0000-4000-8000-000000000001'::uuid
    AND nombre='PRO00 QA A - SINTETICO'
    AND "dueño_id"='4e500fbf-a8a4-4a41-8928-06d222962a5c'::uuid) OR
  (id='96000000-0000-4000-8000-000000000002'::uuid
    AND nombre='PRO00 QA B - SINTETICO'
    AND "dueño_id"='162167f6-a75c-4084-9615-e5c7db505a84'::uuid);
COMMIT;
SELECT id, nombre, plan_activo, plan_tier, onboarding_completado
FROM public.negocios
WHERE id IN ('96000000-0000-4000-8000-000000000001'::uuid,
  '96000000-0000-4000-8000-000000000002'::uuid) ORDER BY id;
