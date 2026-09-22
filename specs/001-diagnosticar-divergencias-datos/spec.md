# Feature Specification: Conciliación diagnóstica de datos

**Feature Branch**: No creada (no hay hook de creación de rama)

**Created**: 2026-09-22

**Status**: Draft

**Input**: Solicitud de definir, detectar y explicar divergencias entre ventas, inventario,
sincronización, caja y reportes de VentaRD sin modificar ni reparar datos.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Diagnosticar una PC sin alterar sus datos (Priority: P1)

Como propietario o personal de soporte autorizado, quiero analizar el estado conocido
de una PC, incluso sin internet, para saber si sus ventas y movimientos justifican
el stock mostrado y qué operaciones siguen pendientes.

**Why this priority**: Permite encontrar fallos locales sin depender de la nube y
establece la garantía de solo lectura de la que dependen los demás escenarios.

**Independent Test**: Con un conjunto local que contiene una venta válida, otra
incompleta y movimientos pendientes, ejecutar el análisis sin conexión; comprobar
hallazgos explicados y comparar el estado íntegro antes y después.

**Acceptance Scenarios**:

1. **Given** una venta con líneas y movimientos coherentes, **When** se analiza,
   **Then** no se informa una inconsistencia confirmada para esa venta.
2. **Given** una venta sin una línea requerida, **When** se analiza,
   **Then** se identifica la venta, la evidencia disponible y la información faltante.
3. **Given** que falta el stock inicial o el historial necesario para reconstruirlo,
   **When** se analiza, **Then** la comparación se declara no verificable; no se
   inventa un stock esperado.
4. **Given** una operación pendiente sin internet, **When** se analiza,
   **Then** se informa como pendiente o no verificable según su evidencia, nunca
   como aplicada remotamente.
5. **Given** evidencia de una edición local pendiente reemplazada por un valor
   remoto antiguo, **When** se analiza, **Then** se identifica la pérdida
   demostrada; si falta el valor anterior, se declara no verificable.

---

### User Story 2 - Localizar la divergencia entre dos PCs (Priority: P1)

Como propietario, quiero saber en qué etapa se detuvo la propagación de una venta
de la PC A a la PC B para distinguir un retraso normal de un movimiento perdido,
un conflicto o una falsa confirmación.

**Why this priority**: Responde al problema observado por clientes: el stock
descontado en una PC tarda en aparecer correctamente en otra.

**Independent Test**: Con estados conocidos de PC A, nube y PC B para una venta
de una unidad, variar independientemente cada etapa y comprobar que el informe
señala la etapa detenida o indica que falta evidencia.

**Acceptance Scenarios**:

1. **Given** que PC A confirmó la venta y conserva el movimiento pendiente,
   **When** se comparan las fuentes disponibles, **Then** se señala la etapa
   pendiente de envío sin declarar corrupción remota.
2. **Given** evidencia completa de rechazo remoto y una marca local de aplicado,
   **When** se concilia, **Then** aparece un hallazgo CRITICAL de falsa confirmación.
3. **Given** movimiento aplicado remotamente y PC B todavía desactualizada,
   **When** se concilia, **Then** el informe ubica el atraso en la recepción o
   actualización de PC B sin atribuirlo al cobro de PC A.
4. **Given** que no hay acceso a la nube ni evidencia reciente de PC B,
   **When** se concilia, **Then** se declara qué etapas no son verificables.
5. **Given** dos PCs totalmente aisladas que venden la última unidad,
   **When** se analizan sus estados, **Then** se exponen las ventas concurrentes
   y el posible conflicto sin prometer exclusión global.

---

### User Story 3 - Explicar cifras de caja y reportes (Priority: P2)

Como propietario o responsable contable autorizado, quiero detectar diferencias
entre ventas, devoluciones, caja y reportes para identificar qué cifras puedo
verificar con los datos históricos disponibles.

**Why this priority**: Una cifra aparentemente correcta pero irreproducible puede
afectar decisiones de dinero y confianza en el POS.

**Independent Test**: Analizar casos con venta fuera del contexto de caja,
devolución, corte incompleto, tasa fiscal cambiada e histórico incompleto;
comprobar un diagnóstico separado para cada caso, sin recalcular ni guardar
valores nuevos.

**Acceptance Scenarios**:

1. **Given** una venta atribuida a un negocio, sucursal o turno distinto del
   cálculo de caja, **When** se analiza, **Then** se informa el contexto que
   explica la discrepancia.
2. **Given** una devolución con efecto monetario no representado en el cuadre
   cuando corresponde, **When** se analiza, **Then** se informa la evidencia
   faltante o la diferencia verificable, sin asumir cómo se entregó el dinero.
3. **Given** que un reporte usa la tasa actual sin conservar la histórica,
   **When** se analiza, **Then** se indica que el impuesto histórico exacto
   no es verificable con esos datos.
4. **Given** que falta histórico local por retención, **When** se analiza,
   **Then** el reporte se califica como potencialmente incompleto y se explican
   los límites de la comparación.
5. **Given** un importe de pago registrado distinto del ingreso atribuido a la
   caja, **When** se analiza, **Then** se explica la diferencia verificable;
   si falta evidencia de pago parcial o devolución, no se inventa liquidación.

---

### User Story 4 - Revisar un informe seguro y reproducible (Priority: P3)

Como personal autorizado de soporte, quiero un informe ordenado con códigos,
severidades y evidencia mínima para revisar o compartir el diagnóstico sin
filtrar secretos ni desencadenar reparaciones.

**Why this priority**: El análisis solo es útil si otra persona puede reproducir
y entender sus conclusiones.

**Independent Test**: Analizar dos veces las mismas instantáneas con el mismo
instante de referencia; comparar hallazgos y orden, inspeccionar el informe en
busca de secretos y verificar ausencia de escrituras o reintentos.

**Acceptance Scenarios**:

1. **Given** instantáneas e instante de referencia idénticos, **When** se repite
   el análisis, **Then** hallazgos, códigos, severidades y orden son idénticos.
2. **Given** un hallazgo, **When** se consulta, **Then** incluye explicación,
   entidades e IDs, evidencia disponible, evidencia faltante y siguiente paso
   diagnóstico, nunca una reparación automática.
3. **Given** datos con tokens o información personal no necesaria, **When** se
   produce el informe, **Then** esos valores no aparecen en él.
4. **Given** que un usuario no está autorizado para un negocio, **When**
   solicita su diagnóstico, **Then** no recibe datos de ese negocio.

### Edge Cases

- Una venta puede existir sin líneas porque el histórico fue purgado o porque
  nunca se registraron; el informe debe distinguir ambas posibilidades según
  la evidencia y no afirmar la causa sin pruebas.
- Dos movimientos pueden compartir operación y producto sin ser duplicados
  legítimos; la coincidencia de referencias por sí sola exige revisión, no
  confirmación automática de doble aplicación.
- Un ID marcado como sincronizado localmente no prueba aplicación remota; una
  ausencia remota solo es concluyente si la consulta fue completa y confiable.
- Relojes de PC A, PC B y nube pueden diferir; el orden causal no debe
  inferirse únicamente de timestamps locales.
- Un producto puede estar eliminado o una sucursal desactivada al analizar
  movimientos históricos; no se debe borrar ni reinterpretar el historial.
- Los conteos físicos pueden establecer stock absoluto; no equivalen a deltas.
- No debe compararse stock de sucursales distintas como si fuera el mismo
  inventario físico.
- La falta de permisos, de conectividad, de historial o un fallo de lectura
  debe producir cobertura parcial explícita, no un informe de consistencia.
- Un reporte de caja puede incluir ingresos de reparaciones y apartados;
  su ausencia en las ventas POS no demuestra por sí sola un error.
- Si una instantánea cambia durante el análisis, el resultado debe indicar
  que la comparación temporal no es concluyente o utilizar un corte coherente.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: El análisis MUST aceptar un negocio, una sucursal opcional, los
  dispositivos conocidos y un instante de referencia explícito; MUST indicar
  exactamente qué fuentes, periodos y entidades fueron evaluados.
- **FR-002**: MUST funcionar con evidencia local solamente. La falta de acceso
  remoto MUST producir cobertura parcial y estados no verificables, no un
  resultado falsamente saludable.
- **FR-003**: Toda vía de conciliación MUST ser de solo lectura: MUST NOT cambiar
  ventas, líneas, stock, movimientos, estados de sincronización, caja, reportes
  o datos remotos, ni iniciar reintentos o sincronización.
- **FR-004**: MUST documentar, para cada invariante, cuál evidencia local o
  remota es autoridad, cuál es proyección y cuál sería insuficiente.
- **FR-005**: MUST comprobar identidad estable y relaciones entre venta,
  líneas, movimientos, fiado y seriales cuando estén disponibles; MUST
  identificar elementos huérfanos o efectos obligatorios ausentes.
- **FR-006**: MUST clasificar la reproducibilidad del total de cada venta como
  verificado, discrepante o no verificable. MUST considerar datos históricos
  necesarios de precio, descuento e impuesto sin inferirlos del catálogo actual.
- **FR-007**: MUST distinguir stock materializado local, movimientos locales
  aplicados, pendientes y fallidos, stock remoto conocido y última evidencia
  remota. MUST declarar no verificable una reconstrucción sin base o historial
  suficiente.
- **FR-008**: MUST detectar movimientos con producto faltante o distinto,
  identidad repetida, posible duplicación de operación y stock que no concuerda
  con la secuencia auditable cuando existe una base suficiente.
- **FR-009**: MUST mapear los estados persistidos actuales a pendiente,
  aplicado, error recuperable, intervención y desconocido únicamente para
  diagnóstico. MUST NOT persistir el mapeo ni equiparar una marca local de
  sincronizado con prueba remota.
- **FR-010**: MUST clasificar un movimiento marcado aplicado localmente y
  rechazado o ausente remotamente como CRITICAL solo cuando exista evidencia
  remota completa y confiable; si no la hay, MUST indicar no verificable.
- **FR-011**: MUST distinguir atraso normal, pendiente vencido, fallo,
  conflicto, inconsistencia confirmada y no verificable usando el instante
  de referencia suministrado y una política de antigüedad explícita.
- **FR-012**: MUST rastrear la venta de PC A por las etapas venta local,
  movimiento local, envío, aplicación remota, recepción y actualización en
  PC B; MUST localizar la primera etapa sin evidencia suficiente.
- **FR-013**: MUST comparar local y remoto por entidad e ID cuando se
  disponga de acceso seguro, mostrando valores relevantes, contexto,
  estado local, actualización conocida y categoría de discrepancia.
- **FR-014**: MUST detectar, cuando sea verificable, ventas fuera del contexto
  esperado de caja, ventas omitidas, devoluciones sin reflejo correspondiente
  y cierres/cortes incompletos; MUST señalar datos insuficientes.
- **FR-015**: MUST identificar reportes históricamente irreproducibles por
  tasa fiscal actual, devoluciones omitidas, datos purgados o diferencias
  entre ventas persistidas y cifra reportada.
- **FR-016**: MUST producir un informe con fecha de análisis, negocio,
  sucursal y dispositivo conocidos, fuentes y entidades evaluadas, cobertura,
  hallazgos y resumen por severidad.
- **FR-017**: Cada hallazgo MUST incluir código estable, severidad, categoría,
  entidad, IDs relevantes, explicación comprensible, evidencia local,
  evidencia remota o su ausencia, estado conocido y recomendación
  diagnóstica sin ejecución automática.
- **FR-018**: Las severidades MUST incluir INFO, WARNING, ERROR y CRITICAL;
  las categorías MUST incluir SALE, INVENTORY, SYNC, PAYMENT, CASH,
  REPORTING, COMPATIBILITY y UNKNOWN. CRITICAL MUST reservarse para riesgo
  demostrado de stock incorrecto, pérdida, duplicación, dinero/caja o falsa
  confirmación; la mera espera dentro del plazo no es CRITICAL.
- **FR-019**: El informe MUST indicar explícitamente hallazgos no
  verificables y la evidencia que falta para resolverlos. MUST NOT presentar
  ausencia de hallazgos como garantía de consistencia de fuentes no examinadas.
- **FR-020**: Dadas las mismas instantáneas, reglas e instante de referencia,
  MUST producir los mismos hallazgos y orden, sin depender de reloj implícito,
  azar, estado visual ni orden incidental de las lecturas.
- **FR-021**: El acceso al análisis MUST respetar negocio y permisos vigentes.
  Los informes MUST excluir secretos, credenciales, tokens e información
  personal que no sea necesaria para explicar un hallazgo.
- **FR-022**: MUST preservar el comportamiento y formatos actuales de cobro,
  inventario, pagos, caja, NCF, permisos y sincronización. Cualquier apoyo
  adicional MUST ser aditivo y no alterar datos ni operaciones existentes.
- **FR-023**: La aceptación MUST cubrir con casos controlados venta válida e
  incompleta, stock igual y divergente, movimiento pendiente, falso
  sincronizado, rechazo remoto, duplicados, producto faltante, edición
  local pendiente, dos PCs, pagos, devoluciones, reportes, no mutación y
  determinismo.
- **FR-024**: MUST detectar una edición local pendiente que contradice la
  versión remota o que desapareció tras una carga, cuando existan versiones
  comparables. MUST clasificar como crítica la pérdida demostrada de la edición;
  sin historial suficiente MUST informar conflicto posible o no verificable.
- **FR-025**: MUST comparar, cuando existan datos suficientes, el importe y
  método de pago registrados con la venta y con el ingreso atribuido a caja.
  MUST indicar no verificable si faltan datos de pagos parciales, cancelación
  o devolución monetaria; MUST NOT inventar una liquidación.

### Scope Boundaries

Esta feature define y habilita diagnóstico. Quedan fuera corregir la sincronización,
reintentar operaciones, cambiar marcas de sincronización, modificar stock o
datos históricos, resolver conflictos automáticamente, introducir reservas,
rediseñar venta o pagos, sustituir el cobro, cambiar NCF, caja, reglas de
envío/recepción, autorización remota o consistencia fuerte entre PCs.
Cualquier corrección posterior requiere otra spec y revisión de compatibilidad.

### Key Entities *(include if feature involves data)*

- **Instantánea de conciliación**: Vista de una fuente en un instante conocido,
  con negocio, sucursal, dispositivo, cobertura, periodo y confiabilidad de la
  lectura. No es una copia con autoridad nueva.
- **Operación comercial**: Acción con identidad estable y efectos esperados,
  como venta, devolución, pago, conteo o movimiento.
- **Venta y línea**: Registro de cobro y sus artículos, importes y relaciones;
  el detalle histórico determina qué puede verificarse.
- **Producto y stock materializado**: Artículo y cifra visible en una fuente;
  la cifra es una proyección que requiere contexto de sucursal y movimientos.
- **Movimiento de stock**: Cambio identificado, relativo o absoluto, asociado
  a producto y operación, con estado y evidencia de aplicación.
- **Estado de sincronización interpretado**: Diagnóstico derivado del estado
  persistido y de la evidencia disponible; no sustituye ni modifica ese estado.
- **Caja, devolución y reporte**: Registros y cifras que deben poder
  relacionarse con operaciones de venta y pago según su contexto.
- **Hallazgo**: Divergencia, atraso, riesgo o límite de verificación con
  identidad estable, severidad, categoría, explicación y evidencia.
- **Informe de conciliación**: Resultado ordenado de instantáneas, cobertura
  y hallazgos, sin facultad de reparación.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El 100 % de los casos controlados obligatorios del FR-023
  produce la clasificación y explicación esperadas, incluidos los casos
  donde la conclusión correcta es no verificable.
- **SC-002**: En el 100 % de las pruebas de no mutación, las fuentes antes y
  después del análisis son idénticas y no se observa ningún reintento o
  sincronización desencadenado por la conciliación.
- **SC-003**: En el 100 % de los escenarios controlados PC A → nube → PC B,
  el informe identifica la primera etapa detenida o indica con precisión
  qué evidencia falta para identificarla.
- **SC-004**: Ningún caso de espera normal dentro del umbral declarado ni
  falta de conectividad se clasifica como inconsistencia confirmada.
- **SC-005**: Con las mismas entradas e instante de referencia, el 100 % de
  las ejecuciones repetidas entrega idénticos hallazgos y orden.
- **SC-006**: En una muestra representativa de hasta 1.000 productos,
  10.000 movimientos y 5.000 ventas, al menos el 95 % de los análisis
  termina en 60 segundos o menos en el equipo objetivo acordado.
- **SC-007**: En una evaluación con al menos cinco usuarios autorizados,
  cuatro de cada cinco pueden identificar producto u operación afectada,
  etapa detenida y evidencia faltante en tres minutos o menos.
- **SC-008**: El 100 % de los informes de prueba omite tokens, credenciales
  y datos personales innecesarios, aun cuando estén en las fuentes analizadas.

## Assumptions

- El análisis reutiliza la identidad y permisos actuales; no concede a un
  usuario acceso adicional a otro negocio o sucursal.
- Se acepta una instantánea local sin nube. Comparar PC B requiere evidencia
  proporcionada de ese dispositivo; no se presupone acceso automático.
- Como umbral diagnóstico inicial, una operación con más de cinco minutos
  pendiente mientras existe conectividad se señala para revisión. El umbral
  es configurable y no constituye promesa de sincronización en cinco minutos.
- Una marca local de sincronizado expresa la intención o creencia local;
  aplicación remota exige evidencia independiente. El stock visible es una
  proyección, no prueba suficiente de todos los movimientos.
- El historial puede ser incompleto por versiones anteriores o retención;
  sin base histórica suficiente se prefiere no verificable a una explicación
  inventada.
- Las lecturas remotas solo son concluyentes cuando su alcance y completitud
  pueden establecerse; fallos de acceso se reportan como cobertura parcial.
- La feature no requiere cambiar esquemas de producción. Si durante el plan
  surge una dependencia imprescindible de observabilidad adicional, deberá
  justificarse por separado como cambio aditivo y compatible antes de aprobarse.
