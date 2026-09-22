# Alcance remoto conocido (T002; diseño, no permiso para US2)

El endpoint remoto pertenece a T022+ y **no se implementa en este checkpoint**. Este mapeo parte de archivos del repositorio; no demuestra políticas ni columnas desplegadas. Hasta verificar en staging, toda lectura remota se considera no disponible.

| Entidad diagnóstica | Tabla candidata | Tenant / sucursal | Paginación y advertencia |
|---|---|---|---|
| ventas | `ventas` | `negocio_id`, `sucursal_id?` | ID exacto o fecha/ID; verificar columnas reales. |
| ventaDetalles | `detalles_ventas` | `negocio_id` no garantizado; probar pertenencia por `venta_id → ventas` y producto | No consultar sin join/alcance probado. |
| productos | `productos` | `negocio_id`; stock de sucursal en `inventario_sucursales` por producto/sucursal | Stock global y por sucursal son ámbitos distintos. |
| movimientosStock | `movimientos_stock` | `negocio_id`, `sucursal_id?`, `producto_id` | ID exacto para ausencia concluyente; fecha+ID para rango. |
| transaccionesFiado | `transacciones_fiado` | `negocio_id`, `sucursal_id?` | Verificar existencia y columnas en staging. |
| seriales | `seriales` | `negocio_id`, producto | Nunca devolver número serial completo. |
| devoluciones | `devoluciones` | `negocio_id`, venta | Verificar ámbito de venta y cobertura. |
| cajas / cortesCaja / gastos | `cajas`, `cortes_caja`, `gastos` | `negocio_id`, `sucursal_id?`, caja | Cajas/cortes pueden no tener fecha índice apropiado; limitar período. |
| reparaciones / apartados | `reparaciones`, `apartados` | `negocio_id`, `sucursal_id?` | Proyectar solo sumarios de pago; no contacto, IMEI ni PIN. |
| reportes | No hay tabla probada | No disponible | Un cálculo derivado necesita contrato propio; no afirmar cobertura remota. |

`src/lib/api/guardia.ts` expone `usuarioDesdeToken` y `rolEnNegocio`: este último devuelve dueño o el rol de un empleado activo. US2 debe exigir **dueño/admin** en servidor y verificar que la sucursal pertenece al negocio. Las políticas SQL del repositorio dan membresía en ciertos casos, no prueban autorización de diagnóstico ni el estado desplegado. `service_role` omite RLS; no usarlo sin guardia y filtro por cada consulta. El contrato limita página a 500 y exige cursor ligado a tenant/entidad/ámbito. No asumir `COMPLETE` por una sola página o un cursor del worker.
