# Quickstart de validación: conciliación diagnóstica

Esta guía describe cómo validar la feature **después** de implementarla.
Los módulos y scripts propuestos aún no existen; los comandos de abajo son
el contrato de ejecución que la fase de tareas debe habilitar. No ejecutar
el escenario contra datos reales de clientes ni usar credenciales de
producción para preparar fixtures.

## Prerrequisitos

- Dependencias del repositorio instaladas con `npm ci`.
- Entorno local de pruebas y, para lectura remota, un proyecto de pruebas
  aislado con dos negocios ficticios y dos usuarios de roles diferentes.
- Capturas/fixtures sin secretos que implementen
  [snapshot.md](contracts/snapshot.md), con PC A, remoto y PC B.
- Instante de referencia fijo y ámbito explícito (negocio, sucursal,
  periodo). Las reglas del informe están en [report.md](contracts/report.md).
- Respaldos o hashes antes/después de todos los almacenes de prueba.
  Preparar fixtures es una fase separada; **la conciliación no los cambia**.

## 1. Validación estática y núcleo determinista

Tras implementar los paths propuestos en [plan.md](plan.md):

```powershell
npm run typecheck
npm run test -- src/lib/diagnostics/reconciliation
```

Resultado esperado: pruebas de venta válida/incompleta, stock igual,
pendiente, falso sincronizado, rechazo, duplicado, producto faltante,
edición pendiente, caja, pago, devolución y reporte pasan. Dos ejecuciones
con iguales capturas y asOf producen los mismos códigos, IDs y orden.
Un dato fiscal histórico ausente resulta no verificable, no se calcula
con la tasa actual.

## 2. Prueba de solo lectura local

En una base IndexedDB de prueba previamente sembrada con ventas,
movimientos, productos, caja y datos de Pro:

1. Obtener una copia/hash completo antes de invocar el lector local.
2. Invocar una sola captura local con periodo y asOf fijos.
3. Ejecutar el núcleo de conciliación con esa captura.
4. Obtener copia/hash completo después.

Resultado esperado: estado antes/después idéntico; ningún movimiento nuevo,
ninguna marca de sincronización cambiada, ningún callback de sync/retry
invocado. El lector informa cobertura de cada entidad y ventana de captura.
La prueba usa IndexedDB simulado o perfil aislado, nunca el perfil de un
cliente.

## 3. Prueba de lectura remota y permisos

En el proyecto remoto **de pruebas**:

1. Preparar un negocio A, una sucursal A y un negocio B, con registros de
   diagnóstico no sensibles. Registrar hash/recuento antes.
2. Autenticar dueño/admin de A y solicitar páginas para negocio A según
   [remote-read.md](contracts/remote-read.md); consumir hasta agotamiento.
3. Repetir como vendedor/cajero de A y como usuario de B.
4. Forzar una página interrumpida, ausencia de red y un cursor inválido.
5. Comparar hash/recuento después y observar el tráfico del diagnóstico.

Resultado esperado: dueño/admin solo ve filas de A; usuarios sin permiso
reciben denegación; nunca aparecen filas de B. Una página faltante marca
cobertura parcial, no ausencia comprobada. No hay escritura, RPC de stock,
reintento ni avance de cursores del sync. La prueba de integración debe
ejecutarse automáticamente en un entorno aislado antes de liberar.

## 4. Escenarios PC A → remoto → PC B

Preparar **fuera del conciliador**, en fixtures controlados, una venta de
una unidad del mismo producto en PC A y snapshots etiquetados de cada etapa.
Analizar por separado:

| Escenario | Resultado esperado |
|---|---|
| A tiene venta/movimiento local pendientes | SYNC_PENDING; B no se declara corrupta |
| Movimiento rechazado, A muestra sync=1 y lectura remota completa no lo tiene | SYNC_FALSE_CONFIRMED, CRITICAL |
| Remoto aplicó, B aún tiene stock anterior | DEVICE_PROPAGATION_GAP en recepción/actualización de B |
| Remoto inaccesible o página incompleta | SYNC_REMOTE_UNVERIFIABLE; ninguna falsa confirmación |
| A y B offline venden última unidad | Conflicto/posible sobreventa, sin promesa de exclusión global |
| A pierde edición local pendiente frente a remoto antiguo con versiones comparables | PRODUCT_PENDING_EDIT_CONFLICT crítico solo si la pérdida está probada |

En todos los casos, verificar IDs, evidencia local/remota, etapa, asOf y
evidencia faltante. No se modifica stock para que el escenario “pase”.

## 5. Caja, reportes y retención

Usar fixtures con dos negocios, dos sucursales, un corte Z, gastos, pagos
de reparación/apartado, devolución parcial y ventas anteriores al límite
de retención local:

- Comparar la fórmula de caja existente con el conjunto de ventas filtrado
  por contexto; informar diferencias, no ajustar caja.
- La devolución sin método de reembolso da
  REFUND_SETTLEMENT_UNVERIFIABLE, no un egreso supuesto.
- Un impuesto calculado desde tasa actual sin tasa histórica da
  REPORT_TAX_UNVERIFIABLE.
- Una venta purgada del local con remoto no disponible da
  REPORT_HISTORY_PARTIAL o no verificable, no “sin ventas”.
- El dinero se compara con precisión declarada, no por igualdad de float.

Resultado esperado: cada caso tiene hallazgo y cobertura correctos, sin
mutar venta, caja, devolución ni reporte.

## 6. Rendimiento, privacidad y lectura humana

- Ejecutar 20 análisis repetidos de un fixture de hasta 1.000 productos,
  10.000 movimientos y 5.000 ventas en el equipo objetivo acordado;
  comprobar que al menos 19 terminan en ≤60 s.
- Incluir tokens, teléfonos, PIN de prueba e IMEI completo en datos de
  entrada controlados; comprobar que ninguno aparece en el informe.
- Entregar cinco informes sintéticos a usuarios autorizados. Al menos
  cuatro deben identificar operación/producto, etapa detenida y evidencia
  faltante en ≤3 min sin ayuda del implementador.

## Criterio de salida

El plan queda validado para implementación solo cuando las pruebas anteriores
demuestran los ocho criterios SC de [spec.md](spec.md), incluida cero mutación
y autorización remota. Un análisis “sin hallazgos” con cobertura incompleta
no es éxito: debe explicar qué no se pudo verificar. Cualquier necesidad de
reparar, cambiar esquema, modificar la UI actual o alterar el worker se
devuelve a una spec separada antes de ejecutarse.
