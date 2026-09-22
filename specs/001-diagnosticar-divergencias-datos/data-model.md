# Data Model: conciliación diagnóstica de datos

**Naturaleza**: modelo lógico de lectura. Ninguna entidad aquí añade columnas,
tablas ni autoridad a los datos de negocio existentes.

## Fronteras de autoridad

| Hecho consultado | Evidencia primaria para este diagnóstico | No constituye prueba suficiente |
|---|---|---|
| Venta confirmada en una PC | Venta local identificada y sus efectos locales persistidos | Estado visual del carrito o ticket impreso |
| Venta aceptada remotamente | Fila remota de venta bajo lectura completa del ID | Marca local de sincronizado |
| Movimiento aplicado remotamente | Movimiento remoto por ID y stock remoto contextual | Solo flag local 1 o número de stock |
| Stock mostrado en una PC | Producto local del negocio/sucursal | Kardex completo o estado de otra PC |
| Stock remoto | Producto global y, si existe, registro de sucursal del mismo ámbito | Exclusión global durante desconexión |
| Pago/caja | Venta, desglose de método, caja/corte y pagos registrados | Liquidación bancaria o reembolso no registrado |
| Reporte histórico | Datos históricos efectivamente conservados | Tasa o precio actual del catálogo |

La autoridad es contextual: una venta local prueba lo que esa PC guardó;
la nube prueba lo que recibió; ninguna fuente por sí sola prueba que la
otra PC ya actualizó su proyección.

## Entidades lógicas

### ReconciliationRequest

- **Campos**: negocioId; sucursalId opcional; periodo desde/hasta; asOf
  obligatorio; lista opcional de producto/venta/operación IDs; fuentes
  aportadas; umbral de pendiente; identidad del solicitante.
- **Validación**: intervalo no invertido, mismo negocio en todas las fuentes,
  ámbito y tamaño acotados, asOf explícito. No se aceptan instrucciones de
  reparación ni parámetros de escritura.
- **Relación**: produce exactamente un ReconciliationReport por ejecución.

### SourceSnapshot

- **Campos**: schemaVersion del contrato de diagnóstico; sourceId estable;
  kind = LOCAL o REMOTE; deviceLabel opcional; negocioId; sucursalId;
  captureStartedAt; captureEndedAt; asOf; coverage por entidad; rows
  normalizadas.
- **Validación**: todos los registros deben pertenecer al ámbito declarado
  o señalarse como discrepancia de ámbito. Una captura sin etiqueta de PC
  no puede atribuirse a PC A o B por inferencia. No se incorporan tokens,
  contraseñas ni campos personales innecesarios.
- **Relación**: una solicitud contiene al menos una captura local; puede
  incluir una remota y una segunda local etiquetada. Una captura es evidencia,
  no nueva fuente de verdad.

### Coverage

- **Campos**: entidad; periodo/IDs solicitados; startedAt; finishedAt;
  status = COMPLETE, PARTIAL, UNAVAILABLE o DENIED; pageCount y rowCount
  observados; razón de incompletitud; retentionHorizon conocido; indicador
  de posible cambio concurrente.
- **Validación**: COMPLETE solo si todas las páginas o IDs solicitados
  terminaron sin error y la autorización/ámbito fue comprobada. Un cursor
  histórico del worker no constituye cobertura. Una consulta fallida o
  lectura entre versiones no permite prueba negativa.
- **Relación**: cada regla consulta la cobertura de las entidades que usa.

### ObservedSale y ObservedSaleLine

- **Venta**: id, negocioId, sucursalId, cajaCodigo, fecha, total, método,
  desglose mixto y fiado, clienteId opcional, NCF opcional, syncFlag local.
- **Línea**: id, ventaId, productoId, cantidad, precioUnitario, subtotal,
  negocioId, sucursalId y syncFlag local.
- **Relaciones**: una venta tiene cero o más líneas observadas; cada línea
  debería referirse a una venta del mismo negocio. La ausencia de líneas
  solo es concluyente con cobertura histórica suficiente.
- **Regla de importe**: comparar el total con una reconstrucción únicamente
  cuando existan descuento e impuestos históricos suficientes. No inferirlos
  de la tasa actual. Sin esos datos, emitir no verificable.

### ObservedProduct y ObservedStockMovement

- **Producto**: id, negocioId, sucursalId o ámbito global, stockMaterializado,
  stockMinimo, fechaActualizacion, syncFlag y estado de eliminación.
- **Movimiento**: id, negocioId, sucursalId, productoId, delta o valorAbsoluto,
  tipo, referenciaOperacionId, fecha, syncFlag local y evidencia remota.
- **Relaciones**: muchos movimientos afectan un producto; un movimiento puede
  referir a venta, devolución, conteo, apartado o reparación. La referencia
  no prueba por sí sola que la operación exista o que otro movimiento sea
  duplicado.
- **Regla de reconstrucción**: un valor absoluto solo sirve como ancla si
  se conoce el orden causal y existe historial completo hasta la captura.
  Deltas no se suman sobre una base desconocida; en ese caso la cifra
  esperada es no verificable.

### ObservedSyncEvidence

- **Campos**: entidad, id, syncFlag local 0/1 o ausente, evidencia de fila
  remota, resultado de lectura remota, fecha de captura, evidencia explícita
  de error si existe, completitud de cobertura.
- **Interpretación derivada**:
  - 0 + sin evidencia remota: PENDING; si supera umbral bajo conectividad,
    PENDING_AGED, no pérdida confirmada.
  - 1 + fila remota por ID: APPLIED_VERIFIED para esa entidad.
  - 1 + ausencia remota comprobada bajo cobertura completa y ventana
    temporal válida: FALSE_CONFIRMED, potencial CRITICAL.
  - Error transitorio explícito: RECOVERABLE_ERROR; error permanente
    explícito: INTERVENTION_REQUIRED.
  - Evidencia incompleta o contradictoria: UNKNOWN/UNVERIFIABLE.
- **Restricción**: estos estados no se escriben a registros originales.
  El flag 1 por sí solo nunca transita a APPLIED_VERIFIED.

### ObservedCashContext

- **Campos**: cajaId, negocioId, sucursalId, apertura/cierre, montoApertura,
  montoEsperado y contado, corte X/Z, ventas por contexto, gastos,
  ingresos de reparaciones/apartados y devoluciones conocidas.
- **Relaciones**: una caja puede tener cortes; la atribución de una venta
  requiere negocio, sucursal, ventana y vínculo suficiente. Si hay cajas
  superpuestas o falta vínculo de dispositivo, la atribución se declara
  ambigua. La devolución no implica automáticamente salida de efectivo.
- **Regla**: comparar la fórmula actualmente observable con el subconjunto
  contextual esperado, sin reescribir ninguna cifra.

### ObservedReport

- **Campos**: tipo, ámbito, periodo, total publicado, datos de origen
  disponibles, regla de cálculo identificada, cobertura histórica.
- **Relación**: reportes derivados de ventas, líneas, devoluciones y stock.
- **Regla**: informar irreproducibilidad por tasa actual, devoluciones no
  incorporadas o histórico purgado; no recalcular la contabilidad oficial.

### Finding

- **Campos**: code estable; severity INFO/WARNING/ERROR/CRITICAL;
  category SALE/INVENTORY/SYNC/PAYMENT/CASH/REPORTING/COMPATIBILITY/UNKNOWN;
  entity; IDs; explanation; localEvidence; remoteEvidence; missingEvidence;
  interpretedSyncState; diagnosticRecommendation; verificability.
- **Validación**: ningún campo incluye secretos ni PII innecesaria. Los
  códigos y orden son deterministas con las mismas capturas/asOf.
  CRITICAL exige evidencia directa de riesgo o falsa confirmación, nunca
  mera ausencia de red.

### ReconciliationReport

- **Campos**: contractVersion; asOf; negocio/sucursal/dispositivos conocidos;
  period; source summaries; coverage; findings ordenados; count por
  severidad/categoría; overall = CONSISTENT_WITH_EVIDENCE,
  FINDINGS_PRESENT o INCOMPLETE_EVIDENCE.
- **Validación**: CONSISTENT_WITH_EVIDENCE solo se usa para las invariantes
  cubiertas; no garantiza consistencia universal. Un source denegado o
  incompleto obliga a explicitar INCOMPLETE_EVIDENCE aunque haya cero
  discrepancias detectadas. El reporte no contiene mutaciones ni comandos.

## Relaciones y cardinalidad

```text
ReconciliationRequest 1 ── 1 ReconciliationReport
ReconciliationRequest 1 ── 1..3 SourceSnapshot (local A, remoto, local B)
SourceSnapshot       1 ── N Coverage
SourceSnapshot       1 ── N ObservedSale/Product/Movement/Cash/Report
ObservedSale         1 ── 0..N ObservedSaleLine
ObservedProduct      1 ── 0..N ObservedStockMovement
ReconciliationReport 1 ── 0..N Finding
Finding              N ── 1..N EvidenceRef
```

El límite 1..3 describe el escenario principal; capturas adicionales
requerirían una ampliación explícita del contrato.

## Reglas de validación transversal

1. Negocio y sucursal deben coincidir antes de comparar dos hechos.
2. Timestamps de diferentes PCs no establecen por sí solos orden causal.
3. Falta de fila y falta de cobertura son estados diferentes.
4. Un mismo ID presente en local y remoto es correspondencia esperada,
   no duplicado. Posible doble efecto requiere IDs distintos y prueba
   del efecto repetido.
5. Valores monetarios se comparan con precisión decimal definida; tolerancia
   y redondeo se documentan por regla. Cantidades de stock usan la precisión
   histórica del producto/movimiento sin convertirlas en enteros.
6. El contenido del reporte se sanitiza por lista permitida de campos.
7. Todas las transiciones de estado aquí son interpretaciones del informe,
   nunca cambios de estado de la aplicación.
