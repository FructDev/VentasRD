-- SOLO staging. Hash de filas preexistentes; no exporta sus valores.
-- Antes/despues: hashes outside_fixture deben permanecer iguales.
-- negocios: solo las cinco columnas previas al baseline, no nuevos defaults.
-- La reserva debe estar VACIA antes de la primera ejecucion del seed.
WITH snapshots AS (
  SELECT 'negocios' AS relation, id::text AS row_id,
    jsonb_build_object('id', n.id, 'nombre', n.nombre, 'dueño_id', n.dueño_id,
      'created_at', n.created_at, 'codigo_referido', n.codigo_referido)::text AS content,
    id IN ('96000000-0000-4000-8000-000000000001'::uuid, '96000000-0000-4000-8000-000000000002'::uuid) AS fixture
  FROM public.negocios n
  UNION ALL
  SELECT 'sucursales', id::text, to_jsonb(s)::text,
    id::text IN ('96000002-0000-4000-8000-000000000001', '96000002-0000-4000-8000-000000000002', '96000002-0000-4000-8000-000000000003')
  FROM public.sucursales s
  UNION ALL
  SELECT 'productos', id::text, to_jsonb(p)::text,
    id::text LIKE '96000001-0000-4000-8000-%'
  FROM public.productos p
  UNION ALL
  SELECT 'inventario_sucursales', id::text, to_jsonb(i)::text,
    id::text LIKE '96000003-0000-4000-8000-%'
  FROM public.inventario_sucursales i
  UNION ALL
  SELECT 'usuarios_negocio', id::text, to_jsonb(u)::text,
    id::text IN ('96000004-0000-4000-8000-000000000001', '96000004-0000-4000-8000-000000000002')
  FROM public.usuarios_negocio u
  UNION ALL
  SELECT 'movimientos_stock', id::text, to_jsonb(m)::text,
    negocio_id::text IN ('96000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000002')
  FROM public.movimientos_stock m
  UNION ALL
  SELECT 'inventario_operaciones_v2', negocio_id::text || ':' || operacion_id::text,
    to_jsonb(o)::text,
    negocio_id::text IN ('96000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000002')
  FROM public.inventario_operaciones_v2 o
  UNION ALL
  SELECT 'inventario_secuencias_v2', scope_id::text, to_jsonb(q)::text,
    negocio_id::text IN ('96000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000002')
  FROM public.inventario_secuencias_v2 q
), names(relation) AS (
  VALUES ('negocios'), ('sucursales'), ('productos'), ('inventario_sucursales'),
         ('usuarios_negocio'), ('movimientos_stock'), ('inventario_operaciones_v2'), ('inventario_secuencias_v2')
)
SELECT n.relation,
  count(s.row_id) FILTER (WHERE s.fixture) AS fixture_rows,
  count(s.row_id) FILTER (WHERE NOT s.fixture) AS outside_fixture_rows,
  md5(coalesce(string_agg(s.content, E'\n' ORDER BY s.row_id) FILTER (WHERE NOT s.fixture), '')) AS outside_fixture_hash
FROM names n LEFT JOIN snapshots s USING (relation)
GROUP BY n.relation ORDER BY n.relation;
