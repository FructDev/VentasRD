# Research: conciliación diagnóstica de datos

**Fecha**: 2026-09-22  
**Alcance**: decisiones de diseño para una conciliación de solo lectura. No verifica el
esquema ni el estado real de producción.

## Decisión 1 — Núcleo puro sobre instantáneas explícitas

**Decision**: Separar captura de datos, normalización, reglas de conciliación y
presentación. El núcleo recibe instantáneas inmutables, un instante de referencia
explícito y una política de umbrales; devuelve un informe determinista. No conoce
almacenamientos ni inicia sincronización.

**Rationale**: Permite probar todas las divergencias sin tocar datos y evita que
una consulta fallida se confunda con consistencia. El worker puede operar mientras
se diagnostica; la captura local debe realizarse en una transacción de solo lectura
sobre las tablas relevantes, registrando inicio/fin y cobertura. Las capturas
remotas por varias tablas no forman una transacción global en el diseño actual:
se comparan con incertidumbre temporal explícita.

**Alternatives considered**: Reglas mezcladas con componentes de UI; descartadas
por falta de determinismo y riesgo de disparar efectos. Consultar cada tabla
durante cada regla; descartado por lecturas inconsistentes y latencia.

## Decisión 2 — Autoridad contextual, no un único stock verdadero

**Decision**: Interpretar la venta local como evidencia de lo confirmado en esa
PC; la venta y movimiento remoto como evidencia de lo aceptado en la nube; el
stock materializado local/remoto como proyección visible de su ámbito. Un
movimiento remoto identificado prueba aplicación mejor que un flag local. La
comparación se limita al mismo negocio, sucursal, producto y ventana temporal.

**Rationale**: El cobro activo confirma varias filas localmente y el worker
sube ventas, detalles y movimientos por separado
(`src/app/page.tsx:305-456`, `src/lib/db/worker.ts:598-767`). El flag local
0/1 no distingue rechazo, error recuperable e intervención; el worker puede
marcar un movimiento con error permanente como sincronizado
(`src/lib/db/worker.ts:735-744`). Por tanto, 1 no prueba aplicación remota.
El stock global y el inventario por sucursal también son contextos distintos
(`src/lib/db/worker.ts:220-255`).

**Alternatives considered**: Confiar solo en stock_actual o en el flag; ambas
ocultan divergencias. Sumar todo el kardex desde el origen; no es verificable
sin una base confiable, orden causal e historial completo.

## Decisión 3 — Cobertura y evidencia negativa conservadoras

**Decision**: Cada instantánea declara fuente, ámbito, periodo, fecha de captura,
estado de lectura, completitud, paginación y motivo de incompletitud. Un registro
ausente remotamente solo puede sostener hallazgo crítico si la consulta del ID
o del conjunto relevante terminó correctamente, fue autorizada, corresponde al
ámbito y no hay ambigüedad temporal material. En caso contrario: no verificable.

**Rationale**: Los cursores del worker usan timestamps por entidad en localStorage
y no son evidencia de una lectura completa por negocio/sucursal
(`src/lib/db/worker.ts:52-74,430-457`). La purga local elimina ventas/detalles
sincronizados tras 90 días y movimientos tras 30
(`src/lib/db/worker.ts:1038-1078`). No se puede inferir ausencia histórica
de una tabla local truncada.

**Alternatives considered**: Tratar una respuesta vacía o un cursor alto como
prueba de ausencia; se descarta por falsos críticos.

## Decisión 4 — Comparación entre PCs mediante evidencia aportada

**Decision**: PC A y PC B se representan como instantáneas separadas etiquetadas
con identidad de captura, no inferida de movimientos. La versión inicial no
recolecta automáticamente datos de otra PC ni crea un canal de escritura
compartido. La ruta diagnóstica acepta una segunda instantánea proporcionada
por un proceso de soporte autorizado.

**Rationale**: VentaLocal conserva caja_codigo, pero MovimientoStockLocal no
almacena device_id ni respuesta RPC persistida
(`src/types/database.ts:40-58,304-315`). El worker recibe eventos Realtime
solo para stock y puede omitir actualizaciones con cambios locales pendientes
(`src/lib/db/worker.ts:109-160`). Una etiqueta inferida sería engañosa.

**Alternatives considered**: Consultar automáticamente el IndexedDB de otra
PC; no es posible sin una nueva infraestructura/escritura o autorización
específica. Inferir origen por timestamp; los relojes pueden diferir.

## Decisión 5 — Adquisición remota autorizada y de solo lectura

**Decision**: Definir una interfaz remota de lectura estrecha, paginada y
autenticada, con verificación de dueño/admin y filtrado por negocio/sucursal
en servidor. Usar permisos del usuario para las lecturas cuando sea posible;
si un servicio privilegiado resulta imprescindible, aplicar guardia y ámbito
en cada consulta. La respuesta contiene solo campos diagnósticos y cobertura.
No altera RLS, RPC ni tablas.

**Rationale**: Existen helpers de usuario y rol en
`src/lib/api/guardia.ts:40-69`, pero las políticas SQL históricas por membresía
no demuestran restricción por rol operativo
(`scripts/sql/rls_blindaje.sql:51-87`). La política desplegada debe verificarse
en un entorno seguro; no se presupone desde el repositorio. Una página o botón
oculto no constituye autorización. El análisis local sin red se limita al
contexto cacheado de esa PC y nunca afirma verificación remota.

**Alternatives considered**: Lectura desde browser solo con control visual de
rol; rechazada para diagnósticos privilegiados. Exponer un endpoint con
service_role sin comprobación de tenant; prohibido. Cambiar RLS/RPC para esta
feature; fuera de alcance.

## Decisión 6 — Caracterizar fórmulas actuales antes de comparar

**Decision**: Reproducir por separado el resultado de las reglas actuales y
el resultado filtrado por contexto esperado; informar la diferencia sin
modificar la UI o la caja. En impuestos, descuentos y reembolsos monetarios,
preferir no verificable si faltan hechos históricos.

**Rationale**: Caja suma ventas posteriores a apertura sin filtrar negocio/
sucursal/caja en su consulta principal
(`src/components/shared/CajaModal.tsx:52-78`), mientras otros ingresos
siguen reglas diferentes. Reportes locales suman ventas brutas y reconstruyen
ITBIS con la tasa actual del producto
(`src/lib/exports/queries.ts:27-80,151-225`). VentaLocal no persiste
descuento/ITBIS por línea; DevolucionLocal no conserva forma de reembolso
(`src/types/database.ts:40-108`). No se puede inventar la fiscalidad histórica
ni un egreso de efectivo.

**Alternatives considered**: Cambiar fórmula de caja/reporte dentro del
diagnóstico; ocultaría el comportamiento desplegado y violaría el alcance.

## Decisión 7 — Entrega incremental sin modificar flujos de producción

**Decision**: Diseñar motor, adaptadores de lectura y contrato de informe como
capacidad diagnóstica aislada. No agregar controles al POS ni modificar cobro,
worker o pantallas actuales. La validación usa fixtures, datos sintéticos y
entornos controlados; el uso con datos reales requiere un procedimiento de
soporte autorizado y revisión de privacidad antes de habilitarlo.

**Rationale**: La spec prohíbe reparación y cambios de UI/comportamiento. El
contrato más reciente de confirmarVentaLocal existe pero no está integrado al
cobro activo (`src/lib/domain/ventas/confirmarVentaLocal.ts:75-183`); las
reglas diagnósticas deben caracterizar el flujo realmente usado.
Vitest/fake-indexeddb y CI ya ofrecen una base para pruebas locales
(`src/lib/domain/ventas/confirmarVentaLocal.test.ts`,
`.github/workflows/ci.yml`). No existen aún pruebas de esta conciliación
contra dos PCs o una base remota controlada.

**Alternatives considered**: Integrar una nueva pantalla de producción en el
mismo cambio; se difiere por el límite explícito de no cambiar la UI. Resolver
stock/worker mientras se construye el diagnóstico; prohibido por la spec.

## Incógnitas cerradas por política conservadora

- **Error remoto sin registro persistente**: no inferir rechazo por ausencia de
  log; marcar no verificable salvo evidencia completa del resultado remoto.
- **Orden de conteos absolutos y deltas**: reconstruir solo si la secuencia
  causal y base son suficientes; si no, no verificable.
- **Umbral de espera**: cinco minutos iniciales bajo conectividad, como alerta
  diagnóstica configurable, no SLA ni prueba automática de pérdida.
- **Esquema real de producción**: no confirmado por este plan. Los contratos
  deben tolerar campos ausentes y el despliegue requiere verificar lectura/RLS
  en staging antes de afirmar cobertura remota.
