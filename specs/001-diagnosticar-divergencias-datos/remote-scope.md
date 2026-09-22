# Alcance remoto conocido (T002; diseño, no permiso para US2)

El endpoint remoto de US2 está implementado como lectura diagnóstica opt-in. Este mapeo parte de archivos del repositorio; no demuestra políticas ni columnas desplegadas. Hasta verificar en staging, cualquier incompatibilidad devuelve 503 y cobertura no verificable.

| Entidad diagnóstica | Tabla candidata | Tenant / sucursal | Paginación y advertencia |
|---|---|---|---|
| ventas | `ventas` | `negocio_id`, `sucursal_id?` | ID exacto o fecha/ID; verificar columnas reales. |
| ventaDetalles | `venta_detalles` | El worker actual escribe `negocio_id`, `sucursal_id`; se filtran ambos y se valida cada fila | Confirmar columnas desplegadas en staging; nunca asumir cobertura si la lectura falla. |
| productos | `productos` | `negocio_id`; stock de sucursal en `inventario_sucursales` por producto/sucursal | Stock global y por sucursal son ámbitos distintos. |
| movimientosStock | `movimientos_stock` | `negocio_id`, `sucursal_id?`, `producto_id` | ID exacto para ausencia concluyente; fecha+ID para rango. |
| transaccionesFiado | `transacciones_fiado` | `negocio_id`, `sucursal_id?` | Verificar existencia y columnas en staging. |
| seriales | `seriales` | `negocio_id`, producto | Nunca devolver número serial completo. |
| devoluciones | `devoluciones` | `negocio_id`, venta | Verificar ámbito de venta y cobertura. |
| cajas / cortesCaja / gastos | `cajas`, `cortes_caja`, `gastos` | `negocio_id`, `sucursal_id?`, caja | Cajas/cortes pueden no tener fecha índice apropiado; limitar período. |
| reparaciones / apartados | `reparaciones`, `apartados` | `negocio_id`, `sucursal_id?` | Proyectar solo sumarios de pago; no contacto, IMEI ni PIN. |
| reportes | No hay tabla probada | No disponible | Un cálculo derivado necesita contrato propio; no afirmar cobertura remota. |

`src/lib/api/guardia.ts` expone `usuarioDesdeToken` y `rolEnNegocio`: este último devuelve dueño o el rol de un empleado activo. US2 exige **dueño/admin** en servidor y verifica que la sucursal pertenece al negocio. Las filas diagnósticas y la sucursal se leen con un cliente ligado al bearer del usuario, por lo que RLS continúa activa, además de aplicar filtros por `negocio_id`/`sucursal_id` en cada SELECT. `service_role` queda limitado a la guardia compartida existente para verificar la sesión y distinguir dueño/admin; no lee filas diagnósticas ni firma cursores. Se requiere `DIAGNOSTIC_CURSOR_SECRET` independiente. Se requiere auditoría en staging de columnas, permisos y aislamiento real. El contrato limita página a 500 y exige cursor firmado ligado a usuario, tenant, entidad y ámbito. La paginación por offset se marca PARTIAL aunque agote páginas: sin instantánea de base de datos no prueba ausencias concurrentes. El stock remoto por sucursal en `productos` se devuelve como no disponible hasta implementar una lectura segura de `inventario_sucursales`.
