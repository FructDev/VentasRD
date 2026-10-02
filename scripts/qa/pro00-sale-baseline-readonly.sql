-- SOLO Staging blzzinivvzadqjbnpsre. SELECT sobre hechos QA, sin reparacion.
-- Producto BRANCH impar 0401 de negocio A; A1 inicia 60, A2 40, global 100.
WITH result AS (
  SELECT 'stock' AS section, jsonb_build_object(
    'product', p.id, 'global', p.stock_actual,
    'branches', (SELECT jsonb_agg(jsonb_build_object('branch', i.sucursal_id,
      'stock', i.stock_actual) ORDER BY i.sucursal_id)
      FROM public.inventario_sucursales i WHERE i.producto_id=p.id)) AS evidence
  FROM public.productos p
  WHERE p.id='96000001-0000-4000-8000-000000000401'::uuid
    AND p.negocio_id='96000000-0000-4000-8000-000000000001'::uuid
  UNION ALL
  SELECT 'sales', coalesce(jsonb_agg(jsonb_build_object('id', v.id,
    'branch', v.sucursal_id, 'total', v.total, 'method', v.metodo_pago)
    ORDER BY v.id), '[]'::jsonb)
  FROM public.ventas v WHERE v.negocio_id::text='96000000-0000-4000-8000-000000000001'
  UNION ALL
  SELECT 'ledger_v2', coalesce(jsonb_agg(jsonb_build_object('operation', o.operacion_id,
    'hash', o.payload_hash, 'authority', o.authority_kind, 'effect', o.effect_value,
    'sequence', o.remote_sequence, 'before', o.stock_before, 'after', o.stock_after,
    'branch', o.sucursal_id) ORDER BY o.operacion_id), '[]'::jsonb)
  FROM public.inventario_operaciones_v2 o
  WHERE o.negocio_id='96000000-0000-4000-8000-000000000001'::uuid
    AND o.producto_id='96000001-0000-4000-8000-000000000401'::uuid
  UNION ALL
  SELECT 'legacy_movements', coalesce(jsonb_agg(jsonb_build_object('operation', m.id,
    'branch', m.sucursal_id, 'delta', m.delta, 'absolute', m.valor_absoluto,
    'kind', m.tipo) ORDER BY m.id), '[]'::jsonb)
  FROM public.movimientos_stock m
  WHERE m.negocio_id='96000000-0000-4000-8000-000000000001'::uuid
    AND m.producto_id='96000001-0000-4000-8000-000000000401'::uuid
)
SELECT section, evidence::text FROM result ORDER BY section;
