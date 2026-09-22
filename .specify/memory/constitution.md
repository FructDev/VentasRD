<!--
Sync Impact Report (temporal para revisión; retirar antes del commit)
- Versión: plantilla sin ratificar → 1.0.0 (adopción inicial).
- Principios modificados: ninguno; la plantilla no contenía principios del proyecto.
- Principios añadidos: I–XX, conforme a los 20 requisitos de VentaRD.
- Secciones añadidas: Restricciones operativas; Flujo de desarrollo.
- Secciones eliminadas: ninguna; se sustituyeron marcadores de plantilla.
- TODO de seguimiento: ninguno.
-->
# VentaRD Constitution

## Core Principles

### I. Protección de datos de producción

Ventas, inventario, pagos, clientes, caja, comprobantes fiscales y movimientos
históricos MUST NOT alterarse destructivamente sin una migración explícita,
validada y reversible cuando sea razonablemente posible. Todo cambio MUST
preservar compatibilidad con datos y clientes existentes, o documentar una
transición controlada. Son datos de operaciones reales, no material descartable.

### II. Offline-first como requisito de producto

VentaRD MUST permitir operaciones autorizadas sin conexión, dentro de los
límites de datos y permisos disponibles localmente. La reconexión MUST tratarse
como sincronización de estados válidos, nunca como permiso para sobrescribir
cambios locales pendientes sin evaluación. Cada spec MUST indicar qué funciona
al iniciar la aplicación desde cero sin internet.

### III. Operaciones comerciales explícitas

Venta, devolución, pago, movimiento de inventario, apertura y cierre de caja
MUST representarse como operaciones explícitas del dominio con identidad y
efectos definidos. La UI MUST NOT modificar directamente balances, stock o
estados persistidos como sustituto de una operación de negocio.

### IV. Inventario basado en movimientos auditables

Todo cambio de stock MUST atribuirse a una operación o movimiento identificable.
El stock MAY materializarse para consultas rápidas, pero MUST existir evidencia
para explicar y conciliar su valor. Un movimiento remoto rechazado MUST NOT
marcarse como aplicado ni sincronizado.

### V. Sincronización recuperable

Toda operación que requiera sincronización MUST conservar identidad y estado
recuperable. El modelo MUST distinguir, como mínimo, pendiente, aplicado, error
recuperable y error que requiere intervención, aunque sus nombres técnicos
difieran. Un fallo MUST NOT retirarse de la cola tratándolo como éxito; MUST
existir una ruta de diagnóstico y recuperación.

### VI. Idempotencia

Toda operación susceptible de reintento MUST tener identidad estable para
reconocer reenvíos. Repetir una venta, movimiento o sincronización después de
una respuesta incierta MUST NOT duplicar efectos ya aceptados. Las pruebas
MUST cubrir reintentos tras timeout y reinicio.

### VII. Conflictos explícitos

Cada dato modificable desde dispositivos aislados MUST tener una política de
conflicto documentada. Para dinero, inventario e información comercial, la
última escritura gana MUST NOT descartar silenciosamente cambios válidos.
Un conflicto no resuelto MUST preservar evidencia de las versiones involucradas
y disponer de una resolución definida.

### VIII. Consistencia local de una venta

La confirmación local de una venta MUST mantener coherentes venta, líneas,
movimientos de stock, seriales, cargos de fiado y demás efectos obligatorios.
Una falla intermedia MUST dejar la operación sin confirmar o activar una
compensación explícita; MUST NOT dejar silenciosamente efectos incompletos.
El reintento MUST respetar la idempotencia.

### IX. Límites de consistencia durante aislamiento

VentaRD MUST NOT prometer exclusión global sobre la última unidad mientras
dos PCs no puedan comunicarse entre sí ni con el servidor, salvo que exista
una reserva previa válida. Cada spec de inventario multicaja MUST declarar
la política de sobreventa, rechazo o reconciliación durante el aislamiento.

### X. Carga remota no destructiva

Antes de reemplazar un dato local con uno remoto, la sincronización MUST evaluar
versión, estado pendiente y política de conflicto. Una carga MUST NOT
sobrescribir silenciosamente una edición local aún no confirmada. El resultado
MUST verificarse con pruebas de reconexión y cambios simultáneos.

### XI. Fuente de verdad explícita

Toda spec MUST identificar la autoridad para venta, líneas, inventario,
movimientos, pagos, caja, datos locales, estado remoto y sincronización que
afecte su alcance. También MUST distinguir autoridad, réplica, proyección
y caché. Una caché o réplica MUST NOT convertirse accidentalmente en autoridad.

### XII. Atomicidad donde corresponda

Los efectos multientidad de una única acción comercial MUST confirmarse
atómicamente dentro de la frontera tecnológica disponible. Si cruzan
fronteras sin transacción común, la spec MUST definir orden, idempotencia,
compensación, detección de parcialidad y recuperación. La atomicidad local
MUST NOT presentarse como atomicidad remota o multidispositivo.

### XIII. Observabilidad de divergencias

Los errores de sincronización capaces de causar divergencia MUST ser visibles
y diagnosticables mediante estado persistente, contexto de operación y una
señal operativa apropiada. Un fallo crítico MUST NOT quedar únicamente en
consola. La observabilidad MUST distinguir atraso normal, fallo recuperable
y necesidad de intervención sin exponer datos sensibles innecesarios.

### XIV. Verificación antes de reparación

Antes de corregir datos históricos MUST existir un verificador o consulta de
conciliación que detecte y explique la discrepancia. Detección y reparación
MUST ser pasos separados. Los verificadores MUST ser de solo lectura por
defecto; cualquier reparación MUST tener alcance, respaldo y resultado
comprobables.

### XV. Cambios incrementales

Al haber usuarios reales, las mejoras MUST dividirse en incrementos pequeños,
verificables y reversibles cuando sea posible. Una reescritura general MUST NOT
elegirse si un cambio localizado satisface el requisito. Cada incremento MUST
identificar compatibilidad, activación y criterio de reversión.

### XVI. Caracterización antes de cambiar comportamiento

Antes de alterar comportamiento crítico existente MUST capturarse su contrato
actual mediante pruebas de caracterización y datos representativos. Esto
aplica como mínimo a venta, stock, sincronización, NCF, caja, devoluciones
y pagos. La prueba MUST documentar si el comportamiento se conserva o se
cambia deliberadamente.

### XVII. Migraciones versionadas

Todo cambio de esquema local/IndexedDB, Supabase, RPC, RLS o formato
sincronizado MUST tener migración versionada y compatibilidad documentada
entre versiones en circulación. Las migraciones de Supabase MUST residir en
supabase/migrations/, ser idempotentes cuando corresponda y acompañar al
código que las usa; ALTERs sueltos no las sustituyen. MUST preservarse y
verificarse los datos históricos.

### XVIII. Seguridad en la frontera de servidor

Ocultar un control en la UI MUST NOT considerarse autorización. Toda operación
privilegiada MUST comprobar identidad, negocio, rol y alcance en la frontera
de servidor o base de datos que ejecuta la escritura, incluidas rutas con
service_role y RPC. Los límites de autorización offline MUST documentarse
y validarse de nuevo al sincronizar cuando corresponda.

### XIX. Evidencia proporcional al riesgo

Una función que involucre Supabase, sincronización entre dispositivos o
permisos MUST NOT aceptarse solo con pruebas unitarias. MUST aportar evidencia
proporcional al riesgo: integración, RLS/RPC y/o escenarios multidispositivo,
incluidos fallos y reintentos pertinentes. La spec MUST fijar criterios de
aceptación observables antes de implementar.

### XX. No ocultar divergencia

Si no puede demostrarse que un dato llegó o se aplicó remotamente, VentaRD
MUST mostrarlo como pendiente, desactualizado o en conflicto según corresponda.
MUST NOT presentarlo engañosamente como confirmado. La interfaz MUST distinguir
confirmación local de remota cuando afecte decisiones comerciales.

## Restricciones operativas

- Las specs MUST identificar datos y clientes afectados, contrato persistido,
  frontera transaccional y fuente de verdad antes de proponer cambios.
- Verificación y migración MUST separar diagnóstico, respaldo, aplicación,
  validación posterior y reversión o compensación.
- El funcionamiento offline MUST evaluarse durante una caída con la app abierta
  y al iniciar desde cero sin conexión.
- Una corrección local MUST contemplar nube, otras PCs, reportes, caja,
  historial y módulos que comparten datos.
- Ninguna garantía de consistencia global durante aislamiento MUST NOT afirmarse
  sin un mecanismo que la haga demostrable.

## Flujo de desarrollo

1. Redactar una spec pequeña con invariantes, actores, compatibilidad,
   conflictos, fallos, criterios de aceptación y límites offline.
2. Caracterizar el comportamiento existente y preparar conciliación de
   solo lectura antes de alterar datos o reglas críticas.
3. Diseñar migraciones y despliegue para versiones coexistentes; revisar
   contratos locales, remotos, permisos e informes.
4. Implementar el cambio mínimo y verificarlo con pruebas unitarias,
   integración y escenarios multidispositivo proporcionales al riesgo.
5. Antes de liberar, revisar datos históricos, observabilidad, recuperación
   y reversión. No declarar completa una feature con divergencias críticas.

## Governance

Esta constitución prevalece sobre prácticas, plantillas y specs de menor
rango. Cada spec, plan, tarea y revisión de cambio MUST comprobar los
principios aplicables. Toda excepción MUST documentar principio afectado,
necesidad, alcance, riesgo para usuarios y datos, mitigación, responsable,
fecha de revisión y condición de salida; MUST aprobarse explícitamente
antes del cambio y no crea una excepción permanente.

Una enmienda MUST proponer texto, motivo, análisis de compatibilidad y Sync
Impact Report para revisión. El responsable del proyecto MUST aprobarla
antes de adoptarla. La versión sigue semantic versioning: MAJOR para
eliminación o redefinición incompatible de principios, MINOR para principios
o secciones nuevos o ampliación material, y PATCH para aclaraciones sin
cambio normativo. La fecha de última enmienda MUST actualizarse con cada
modificación aprobada; la de ratificación original MUST conservarse.
El cumplimiento MUST revisarse en planificación, código, pruebas y
despliegue; las desviaciones MUST resolverse o registrarse como excepción.

**Version**: 1.0.0 | **Ratified**: 2026-09-21 | **Last Amended**: 2026-09-21
