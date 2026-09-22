---

description: "Tareas de implementación de la conciliación diagnóstica de VentaRD"

---

# Tasks: Conciliación diagnóstica de datos

**Input**: `specs/001-diagnosticar-divergencias-datos/` (`spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`).

**Prerequisitos**: Respetar `.specify/memory/constitution.md` y el alcance de solo lectura. Esta lista planifica implementación futura; generarla no modifica el POS.

**Tests**: Obligatorios por FR-023 y SC-001–SC-008. En cada historia, escribir primero las pruebas y comprobar que fallan por la funcionalidad ausente antes de implementarla.

**Organización**: Fases por historia de usuario. Los adaptadores capturan evidencia; el núcleo puro analiza copias inmutables; el informe no repara ni sincroniza.

## Formato: `[ID] [P?] [Story] Descripción`

- `[P]`: trabajo en archivo distinto, sin dependencia de una tarea incompleta.
- `[USn]`: historia de usuario de `spec.md`; solo aparece dentro de su fase.
- Cada tarea identifica archivos concretos relativos a la raíz del repositorio.

## Convenciones de rutas

- Núcleo y pruebas: `src/lib/diagnostics/reconciliation/`.
- Lectores: `src/lib/diagnostics/reconciliation/readers/`.
- API de lectura: `src/app/api/diagnostics/remote-snapshot/route.ts`.
- Guía y evidencias: `specs/001-diagnosticar-divergencias-datos/`.
- Runner interno de soporte: `scripts/diagnostics/`; no introducir UI de producción.

## Phase 1: Setup (infraestructura compartida)

**Propósito**: Fijar el mapeo real de fuentes y límites antes de codificar reglas. No modificar flujos existentes.

- [X] T001 Documentar en `specs/001-diagnosticar-divergencias-datos/source-mapping.md` las columnas/índices reales y autoridad de venta activa, líneas, fiado, seriales, productos, movimientos, devoluciones, caja, Pro y reportes, contrastando `src/app/page.tsx`, `src/types/database.ts`, `src/lib/db/dexie.ts`, `src/lib/db/worker.ts`, `src/components/shared/CajaModal.tsx` y `src/lib/exports/queries.ts`; anotar campos ausentes, purga y diferencias entre esquemas locales/versiones sin cambiar esos archivos.
- [X] T002 [P] Documentar en `specs/001-diagnosticar-divergencias-datos/remote-scope.md` tabla/columna de tenant, relación de pertenencia, sucursal, rol dueño/admin y paginación admisible para cada entidad de `contracts/remote-read.md`; marcar como no disponible lo que no pueda probarse en el esquema de pruebas, sin presuponer que RLS del repositorio ya está desplegada.

---

## Phase 2: Foundational (prerrequisitos bloqueantes)

**Propósito**: Contratos 1.0, normalización, cobertura y ensamblado de informe compartidos por todas las historias.

**CRÍTICO**: Completar esta fase antes de implementar cualquier historia.

- [X] T003 Escribir pruebas de contrato que fallen para versión 1.0, IDs/ámbito, una captura LOCAL obligatoria y máximo LOCAL A + REMOTE + LOCAL B, ventanas válidas y campos desconocidos en `src/lib/diagnostics/reconciliation/schema.test.ts`, usando `contracts/snapshot.md`.
- [X] T004 Definir `ReconciliationInput`, `SourceSnapshot`, `Coverage`, registros observados, `Finding` y `ReconciliationReport` con sus uniones cerradas y opcionalidad real en `src/lib/diagnostics/reconciliation/types.ts`; conservar literalmente `status = COMPLETE, PARTIAL, UNAVAILABLE o DENIED` y `overall = CONSISTENT_WITH_EVIDENCE, FINDINGS_PRESENT o INCOMPLETE_EVIDENCE` de `data-model.md`.
- [X] T005 Implementar validación runtime Zod 4 de `contracts/snapshot.md` y `contracts/report.md` en `src/lib/diagnostics/reconciliation/schema.ts`: “intervalo no invertido, mismo negocio en todas las fuentes, ámbito y tamaño acotados, asOf explícito”; rechazar versión/ID/ámbito inválidos antes de leer y nunca aceptar instrucciones de reparación.
- [X] T006 Escribir pruebas que fallen de precisión decimal, redondeo declarado, IDs estables, campos históricos faltantes y prohibición de completar impuesto/descuento/reembolso con valores actuales en `src/lib/diagnostics/reconciliation/normalize.test.ts`.
- [X] T007 Implementar normalización de dinero como decimal exacto y cantidad con precisión original, procedencia y `unknown` explícito en `src/lib/diagnostics/reconciliation/normalize.ts`; mantener `delta` distinto de `valorAbsoluto` y no crear IDs de negocio.
- [X] T008 Escribir pruebas que fallen para cobertura completa/parcial/denegada, página interrumpida, retención y lectura concurrente en `src/lib/diagnostics/reconciliation/coverage.test.ts`, incluyendo ausencia de fila ≠ ausencia de cobertura.
- [X] T009 Implementar decisiones de cobertura por entidad, ámbito, periodo e IDs en `src/lib/diagnostics/reconciliation/coverage.ts`: “COMPLETE solo si todas las páginas o IDs solicitados terminaron sin error y la autorización/ámbito fue comprobada”; cursor del worker, límite de página y fallo de lectura nunca prueban ausencia.
- [X] T010 Escribir pruebas que fallen para conteos, `overall`, códigos permitidos, severidades, IDs estables y orden de `contracts/report.md` en `src/lib/diagnostics/reconciliation/report.test.ts`; una fuente parcial con cero discrepancias no puede ser consistente.
- [X] T011 Implementar constructor puro del informe 1.0 en `src/lib/diagnostics/reconciliation/report.ts`: ordenar CRITICAL→ERROR→WARNING→INFO y luego categoría/código/entidad/ID/fuente, derivar `findingId` sin reloj/azar, y conservar cobertura/no verificables aun con hallazgos.

**Checkpoint**: Contratos y pruebas base pasan; aún no hay acceso a datos de negocio ni integración visual.

---

## Phase 3: User Story 1 — Diagnosticar una PC sin alterar datos (P1) 🎯 MVP

**Goal**: Capturar una PC ya desbloqueada, analizar ventas/stock/pendientes sin red y explicar límites de evidencia sin escribir ni activar el worker.

**Independent Test**: Venta válida, venta incompleta, movimiento pendiente y stock sin base en IndexedDB de prueba; desconectar red, ejecutar captura/análisis y comparar hash completo antes/después más callbacks de sync/retry no invocados.

### Pruebas — escribir primero y comprobar fallo

- [X] T012 [P] [US1] Escribir prueba `fake-indexeddb` de captura coherente `readonly`, cobertura de todas las entidades, retención y hashes antes/después sin invocar sync/retry en `src/lib/diagnostics/reconciliation/readers/local.test.ts`.
- [X] T013 [P] [US1] Escribir pruebas de venta válida, línea huérfana, efectos obligatorios faltantes (movimiento, serial/fiado si aplica) y total verificado/discrepante/no verificable por datos monetarios históricos en `src/lib/diagnostics/reconciliation/rules/sales.test.ts`.
- [X] T014 [P] [US1] Escribir pruebas de producto faltante, `delta` frente a conteo absoluto, base/orden/historial insuficientes, stock igual/divergente y duplicado sospechado frente a doble efecto probado en `src/lib/diagnostics/reconciliation/rules/inventory.test.ts`.
- [X] T015 [P] [US1] Escribir pruebas de estado local `sync=0` pendiente, umbral de cinco minutos condicionado a evidencia de conectividad, `sync=1` sin prueba remota y edición pendiente con historial comparable o insuficiente en `src/lib/diagnostics/reconciliation/rules/local-sync.test.ts`.
- [X] T016 [US1] Escribir prueba de aceptación offline desde arranque de diagnóstico con venta completa/incompleta y datos retenidos en `src/lib/diagnostics/reconciliation/offline.integration.test.ts`; exigir mismos hallazgos con red desactivada, cobertura parcial donde corresponde y cero mutación.

### Implementación

- [X] T017 [US1] Implementar lector Dexie de una transacción `readonly` sobre las tablas relevantes en `src/lib/diagnostics/reconciliation/readers/local.ts`, filtrando negocio/sucursal/periodo/IDs, registrando ventana y retención; con identidad offline cacheada etiquetar que no hubo verificación del servidor y no llamar `src/lib/db/worker.ts`.
- [X] T018 [P] [US1] Implementar invariantes de venta/línea, relaciones opcionales con fiado/serial y total histórico sin inferir tasa actual en `src/lib/diagnostics/reconciliation/rules/sales.ts`; ausencia de línea solo es concluyente con cobertura histórica suficiente.
- [X] T019 [P] [US1] Implementar reglas de producto/movimiento y reconstrucción auditable en `src/lib/diagnostics/reconciliation/rules/inventory.ts`: “un valor absoluto solo sirve como ancla si se conoce el orden causal y existe historial completo hasta la captura”; no comparar sucursales ni declarar doble aplicación por referencias iguales.
- [X] T020 [P] [US1] Implementar interpretación local derivada `PENDING`, `PENDING_AGED` o `UNKNOWN`, y conflicto de edición solo con versiones comparables, en `src/lib/diagnostics/reconciliation/rules/local-sync.ts`; no persistir estados ni atribuir aplicación remota a `sync=1`.
- [X] T021 [US1] Conectar índices lineales por negocio/sucursal/ID, reglas US1 y constructor de informe en `src/lib/diagnostics/reconciliation/analyze.ts`, como función pura de capturas inmutables y `asOf` explícito; no leer reloj, red, IndexedDB ni estado visual dentro del núcleo.

**Checkpoint**: MVP local demostrable en entorno controlado, sin prometer consistencia remota ni alterar el cobro.

---

## Phase 4: User Story 2 — Localizar divergencia PC A → nube → PC B (P1)

**Goal**: Distinguir envío, aplicación remota y recepción en otra PC con evidencia aportada y lectura remota segura; no inferir datos de PC B.

**Independent Test**: Variar por separado cada etapa de una venta de una unidad; comprobar primera etapa detenida, falso sincronizado solo con ausencia remota concluyente, y no verificable ante red/página/permiso insuficiente.

### Pruebas — escribir primero y comprobar fallo

- [ ] T022 [P] [US2] Escribir pruebas de contrato de `GET /api/diagnostics/remote-snapshot` para bearer inválido, rol vendedor, tenant/sucursal ajenos, cursor inválido, `limit > 500`, rango excesivo, `no-store`, proyección de campos y cero escrituras/RPC en `src/app/api/diagnostics/remote-snapshot/route.test.ts`.
- [ ] T023 [P] [US2] Escribir pruebas del lector remoto: paginación hasta agotamiento, lookup por ID vacío COMPLETE, error 401/403/429/503, página incompleta y ventanas no atómicas sin elevar ausencia a prueba en `src/lib/diagnostics/reconciliation/readers/remote.test.ts`.
- [ ] T024 [P] [US2] Escribir fixtures PC A/REMOTO/PC B para pendiente, rechazo con `sync=1`, remoto aplicado/B atrasada, dos PCs aisladas y relojes desalineados en `src/lib/diagnostics/reconciliation/fixtures/two-devices.ts`.
- [ ] T025 [US2] Escribir pruebas que fallen para etapa detenida, `SYNC_FALSE_CONFIRMED` CRITICAL solo con consulta completa/autorizada/temporalmente válida, `DEVICE_PROPAGATION_GAP`, `SYNC_REMOTE_UNVERIFIABLE` y conflicto de edición local en `src/lib/diagnostics/reconciliation/rules/propagation.test.ts` usando los fixtures T024.
- [ ] T026 [US2] Escribir integración aislada con dos negocios sintéticos y roles dueño/admin/vendedor en `src/app/api/diagnostics/remote-snapshot/route.integration.test.ts`; exigir que A no reciba B, hash remoto igual antes/después y ausencia de RPC/sync, sin credenciales ni datos de producción.
- [ ] T027 [US2] Escribir aceptación PC A→remoto→PC B y fallos de conectividad/página/permiso en `src/lib/diagnostics/reconciliation/two-devices.integration.test.ts`, verificando códigos, severidad, etapa, cobertura y evidencia faltante de `quickstart.md`.

### Implementación

- [ ] T028 [US2] Implementar guardia server-side por sesión vigente, dueño/admin activo y pertenencia de sucursal, más validación de entidad/rango/cursor/página, en `src/app/api/diagnostics/remote-snapshot/route.ts`; reutilizar `src/lib/api/guardia.ts` donde sea seguro y nunca confiar en rol cacheado del navegador.
- [ ] T029 [US2] Implementar SELECT paginado y allowlist por entidad/ID/negocio/sucursal en `src/lib/diagnostics/reconciliation/readers/remote-query.ts`, con `limit <= 500`, prueba de pertenencia para tablas sin `negocioId` directo y sin service_role sin guardia equivalente, writes, RPC ni cambios RLS.
- [ ] T030 [US2] Conectar el handler GET a T029 en `src/app/api/diagnostics/remote-snapshot/route.ts`, con cursor ligado a la consulta, respuesta `WINDOWED`, errores estables 400/401/403/429/503, `no-store` y límite de tasa acotado; página con `nextCursor` no es lectura completa del rango.
- [ ] T031 [US2] Implementar cliente de captura remota por entidad que consuma todas las páginas o declare PARTIAL/UNAVAILABLE/DENIED en `src/lib/diagnostics/reconciliation/readers/remote.ts`; un retry requiere acción separada del operador.
- [ ] T032 [US2] Implementar reglas de estados remotos y propagación por IDs y ámbito en `src/lib/diagnostics/reconciliation/rules/propagation.ts`: `sync=1` es afirmación local, fila remota es prueba de aceptación, ausencia remota exige cobertura completa y ventana confiable; nombrar primera etapa sin evidencia y el dato que falta.
- [ ] T033 [US2] Implementar comparación de edición pendiente con versión remota comparable y doble venta offline de última unidad en `src/lib/diagnostics/reconciliation/rules/conflicts.ts`; solo pérdida demostrada es CRITICAL y timestamps entre PCs no establecen orden causal.
- [ ] T034 [US2] Integrar opcionales REMOTE y LOCAL B etiquetadas en `src/lib/diagnostics/reconciliation/analyze.ts`, reutilizando índices por ID; no inferir PC B, no prometer exclusión global y mantener US1 funcional sin estas fuentes.

**Checkpoint**: Divergencias entre dispositivos diagnosticables con pruebas de aislamiento y sin lectura remota falsa cuando falta red.

---

## Phase 5: User Story 3 — Explicar caja, pagos y reportes (P2)

**Goal**: Comparar cifras existentes con su contexto y hechos históricos, sin corregir caja ni inventar impuestos o reembolsos.

**Independent Test**: Dos negocios/sucursales, corte Z, pago de reparación/apartado, devolución parcial, pago mixto y retención: cada caso obtiene hallazgo o no verificable específico con importes precisos y datos intactos.

### Pruebas — escribir primero y comprobar fallo

- [ ] T035 [P] [US3] Escribir pruebas de caracterización de la fórmula hoy usada por `src/components/shared/CajaModal.tsx` (incluidos ventas, gastos y módulos Pro) frente al subconjunto filtrado por negocio/sucursal/turno en `src/lib/diagnostics/reconciliation/rules/cash.test.ts`; probar caja superpuesta y corte incompleto.
- [ ] T036 [P] [US3] Escribir pruebas de pago registrado versus venta/caja, mixto/fiado/parcial y devolución sin método de reembolso en `src/lib/diagnostics/reconciliation/rules/payments.test.ts`; ninguna salida de efectivo se supone sin evidencia.
- [ ] T037 [P] [US3] Escribir pruebas de reportes de `src/lib/exports/queries.ts`: ITBIS calculado con tasa actual sin histórica, devolución omitida, venta purgada e histórico remoto no disponible en `src/lib/diagnostics/reconciliation/rules/reporting.test.ts`.
- [ ] T038 [US3] Escribir aceptación con fixtures de `quickstart.md` y hashes local/remoto antes/después en `src/lib/diagnostics/reconciliation/finance.integration.test.ts`; exigir contexto correcto, no verificables y cero modificación de ventas, devoluciones, caja o reportes.

### Implementación

- [ ] T039 [P] [US3] Implementar atribución de venta a caja por negocio, sucursal, ventana y vínculo disponible, y comparación entre fórmula observable y cifra contextual en `src/lib/diagnostics/reconciliation/rules/cash.ts`; si hay cajas superpuestas o falta vínculo, declarar atribución ambigua y no reescribir la caja.
- [ ] T040 [P] [US3] Implementar comparación monetaria decimal de método/desglose/importe con venta, caja, fiado y devolución en `src/lib/diagnostics/reconciliation/rules/payments.ts`; distinguir `PAYMENT_CASH_MISMATCH` probado de `REFUND_SETTLEMENT_UNVERIFIABLE`.
- [ ] T041 [P] [US3] Implementar `REPORT_TAX_UNVERIFIABLE`, `REPORT_REFUND_GAP` y `REPORT_HISTORY_PARTIAL` en `src/lib/diagnostics/reconciliation/rules/reporting.ts`, usando tasa/importe históricos solo si existen y retención/cobertura declaradas.
- [ ] T042 [US3] Conectar reglas de caja, pago y reporte al motor en `src/lib/diagnostics/reconciliation/analyze.ts`, manteniendo la salida US1/US2 y los nombres de módulos/ingresos Pro según `source-mapping.md`.

**Checkpoint**: Cifras explicadas sin declarar como exacto aquello que no conserva hechos históricos suficientes.

---

## Phase 6: User Story 4 — Informe seguro y reproducible (P3)

**Goal**: Entregar un informe legible, ordenado, reproducible y compartible solo por personal autorizado, sin secretos ni instrucciones ejecutables de reparación.

**Independent Test**: Ejecutar dos veces las mismas capturas/asOf y comparar bytes/códigos/orden; inyectar secretos y PII controlados; probar denegación de otro negocio y ausencia de mutaciones/reintentos.

### Pruebas — escribir primero y comprobar fallo

- [ ] T043 [P] [US4] Escribir pruebas de determinismo, `findingId`, severidades/categorías, `overall`, evidencia presente/faltante y orden estable bajo permutación de filas en `src/lib/diagnostics/reconciliation/report-contract.test.ts`.
- [ ] T044 [P] [US4] Escribir pruebas de filtrado de token, contraseña, PIN, teléfono, correo, notas libres e IMEI completo en entradas y evidencias del informe en `src/lib/diagnostics/reconciliation/privacy.test.ts`.
- [ ] T045 [P] [US4] Escribir pruebas de texto legible para operación/producto, etapa detenida y evidencia faltante, y de ausencia de comandos de reparación, en `src/lib/diagnostics/reconciliation/render.test.ts`.
- [ ] T046 [US4] Escribir aceptación de informe repetible, redacción, acceso denegado y cero mutación en `src/lib/diagnostics/reconciliation/report.integration.test.ts`, apoyándose en pruebas del endpoint US2 para autorización real.

### Implementación

- [ ] T047 [US4] Implementar allowlist de campos y sanitización previa a serializar `EvidenceRef`/explicaciones en `src/lib/diagnostics/reconciliation/privacy.ts`; nunca incluir secretos, contacto, IMEI completo ni notas libres, aun cuando estén en capturas.
- [ ] T048 [US4] Integrar sanitización y códigos estables de `contracts/report.md` en `src/lib/diagnostics/reconciliation/report.ts`; todo hallazgo debe contener entidad/IDs, explicación, evidencia local/remota o ausencia, estado conocido y siguiente paso solo diagnóstico.
- [ ] T049 [US4] Implementar representación humana y JSON versionado del informe en `src/lib/diagnostics/reconciliation/render.ts`, indicando asOf, fuente/dispositivo conocido, ámbito, cobertura, resumen y límites de inferencia sin añadir reloj actual.
- [ ] T050 [US4] Añadir runner interno que lea un informe JSON 1.0 ya generado y lo presente sin persistirlo ni llamar sync/red en `scripts/diagnostics/render-report.mjs`; no exportar capturas sensibles por defecto ni introducir una pantalla en el POS.

**Checkpoint**: Informe apto para revisión de soporte en entorno autorizado; uso con datos reales sujeto a procedimiento de privacidad.

---

## Phase 7: Polish & cross-cutting concerns

**Propósito**: Validar criterios SC, compatibilidad y puerta de salida en ambiente controlado.

- [ ] T051 [P] Construir fixture sintético de hasta 1.000 productos, 10.000 movimientos y 5.000 ventas y medición de 20 corridas en `src/lib/diagnostics/reconciliation/performance.test.ts`; exigir al menos 19 ≤60 s en equipo objetivo acordado y perfilar cualquier búsqueda cuadrática.
- [ ] T052 [P] Documentar en `specs/001-diagnosticar-divergencias-datos/support-procedure.md` captura autorizada de PC A/B, uso offline con identidad cacheada/no verificada por servidor, minimización/redacción, no almacenamiento por defecto y prohibición de datos/credenciales reales en fixtures.
- [ ] T053 Ejecutar `npm run typecheck` y `npm run test -- src/lib/diagnostics/reconciliation`, registrar comandos/resultados y los casos FR-023/SC-001–SC-005, SC-008 en `specs/001-diagnosticar-divergencias-datos/verification.md`; si fallan, corregir solo el módulo diagnóstico y repetir.
- [ ] T054 Ejecutar en staging aislado la prueba automática de rol/tenant/RLS real, paginación, ausencia de escrituras/RPC y dos dispositivos; registrar hashes antes/después, ventanas y resultado SC-002/SC-003 en `specs/001-diagnosticar-divergencias-datos/verification.md`, sin consultar ni modificar producción.
- [ ] T055 Medir SC-006 en el equipo acordado y evaluación SC-007 con cinco usuarios autorizados y cuatro respuestas ≤3 min; registrar metodología, tiempos y límites en `specs/001-diagnosticar-divergencias-datos/verification.md`, sin declarar aprobados criterios no ejecutados.
- [ ] T056 Revisar `specs/001-diagnosticar-divergencias-datos/quickstart.md` contra los artefactos implementados y anotar en `specs/001-diagnosticar-divergencias-datos/verification.md` compatibilidad de cobro, stock, sync, caja, pagos, devoluciones, NCF, permisos y reportes; cualquier necesidad de reparar, migrar o cambiar UI/worker exige otra spec antes de liberar.

---

## Dependencies & Execution Order

### Phase dependencies

- Phase 1 → Phase 2 → cualquiera de US1/US2/US3/US4 → Phase 7.
- Dentro de cada historia: pruebas rojas → reglas/lector → integración → checkpoint.
- US2/US3/US4 pueden desarrollarse tras Phase 2 con fixtures independientes; integrar en `analyze.ts`/`report.ts` secuencialmente para evitar conflictos de archivo. La ruta de captura real entre PCs reutiliza el lector local de US1.
- El release gate de US2 requiere T033–T034 y T054; el de toda la feature requiere SC-001–SC-008 verificados, no solo pruebas unitarias.

### User story dependencies

| Historia | Puede comenzar | Prueba aislada | Integración compartida |
|---|---|---|---|
| US1 (P1) | Tras Phase 2 | Captura local offline y hashes | `analyze.ts` inicial |
| US2 (P1) | Tras Phase 2 y `remote-scope.md` | Tres snapshots fixture y API aislada | Esperar T021 para editar `analyze.ts`; lector local T017 para captura real de B |
| US3 (P2) | Tras Phase 2 y `source-mapping.md` | Capturas financieras fixture | Esperar T034 para editar `analyze.ts` |
| US4 (P3) | Tras Phase 2 | Informe fixture determinista | Esperar T042 para cambios finales en `report.ts`/aceptación completa |

### Parallel opportunities

- Setup: T001 y T002, en documentos distintos.
- US1: T012–T015 (pruebas separadas); luego T018–T020 (reglas separadas) una vez disponibles contratos y cobertura.
- US2: T022–T024 (pruebas/fixtures separados); T025 tras T024; T028–T031 en cadena por guardia→query→handler→cliente.
- US3: T035–T037 (pruebas separadas); luego T039–T041 (reglas separadas).
- US4: T043–T045 (pruebas separadas); T047 antes de T048–T049.
- Polish: T051 y T052 en archivos distintos; T053–T056 son puertas secuenciales de evidencia.

### Parallel example: US1

```text
T012 local.test.ts  ||  T013 sales.test.ts  ||  T014 inventory.test.ts  ||  T015 local-sync.test.ts
Tras pruebas rojas: T018 sales.ts  ||  T019 inventory.ts  ||  T020 local-sync.ts
```

### Parallel example: US2

```text
T022 route.test.ts  ||  T023 remote.test.ts  ||  T024 fixtures/two-devices.ts
Tras T024: T025 propagation.test.ts; integrar endpoint T028 → T029 → T030 → T031
```

### Parallel example: US3

```text
T035 cash.test.ts  ||  T036 payments.test.ts  ||  T037 reporting.test.ts
Tras pruebas rojas: T039 cash.ts  ||  T040 payments.ts  ||  T041 reporting.ts
```

### Parallel example: US4

```text
T043 report-contract.test.ts  ||  T044 privacy.test.ts  ||  T045 render.test.ts
Después: T047 privacy.ts → T048 report.ts; T049 render.ts tras contrato y sanitización
```

## Implementation Strategy

### MVP first: US1

1. Completar Setup y Foundational.
2. Escribir pruebas US1 y comprobar fallo esperado.
3. Implementar solo captura local y reglas US1; probar inicio offline, no mutación y límites de evidencia.
4. Detenerse en el checkpoint. No liberar a clientes ni declarar nivel profesional solo por tener un informe local.

### Incremental delivery

1. US1 muestra lo verificable en una PC.
2. US2 añade evidencia remota/PC B con autorización y pruebas multidispositivo.
3. US3 añade explicación financiera sin rehacer cálculos productivos.
4. US4 hace el informe seguro y reproducible.
5. Phase 7 exige evidencia de staging, rendimiento, privacidad y comprensión humana antes de plantear liberación.

## Notes

- No modificar `src/app/page.tsx`, `src/lib/db/worker.ts`, `src/components/shared/CajaModal.tsx`, `src/lib/exports/queries.ts`, RPC, RLS ni formatos sincronizados dentro de esta feature; se usan para caracterizar lo existente.
- No hay migración prevista. Si un cambio de esquema resulta imprescindible, detener esta lista y definir una spec separada con migración versionada en `supabase/migrations/` según `AGENTS.md`.
- El diagnóstico puede arrancar offline desde contexto local desbloqueado; no confundirlo con autorización remota vigente ni con garantía de PC B.
- Cada CRITICAL necesita prueba directa; falta de red, permiso, historial o página solo produce cobertura incompleta/no verificable.
- Las tareas `[P]` no comparten archivo y no dependen de tareas incompletas dentro de su grupo paralelo.
