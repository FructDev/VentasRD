# Implementation Plan: Conciliación diagnóstica de datos

**Branch**: main (rama actual; no se creó rama de feature) | **Date**: 2026-09-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from specs/001-diagnosticar-divergencias-datos/spec.md

**Note**: Este plan diseña una capacidad de diagnóstico; no autoriza reparación de datos,
migraciones, cambios del cobro ni modificación de la UI de producción.

## Summary

Construir una conciliación de solo lectura que capture evidencia local y, si está
autorizada y disponible, evidencia remota o de otra PC. Un núcleo determinista
evalúa invariantes de venta, movimientos/stock, sincronización, caja y reportes;
entrega hallazgos con evidencia y cobertura explícitas. La captura, el análisis
y el informe son fronteras separadas. La falta de historial, permiso,
conectividad o una lectura completa produce no verificable, no un falso éxito
ni una acusación de corrupción. Ninguna ruta diagnóstica reintenta o corrige.

## Technical Context

**Language/Version**: TypeScript 5; Next.js 16.2.4; React 19.2.4

**Primary Dependencies**: Dexie 4.4, Supabase JS 2.104, Zod 4.4; Zustand 5
solo para leer contexto existente, nunca para escribir resultados diagnósticos

**Storage**: IndexedDB/Dexie local y Supabase/Postgres remoto, ambos solo lectura
para esta feature; informe transitorio o exportado, no nueva tabla de negocio

**Testing**: Vitest 4, fake-indexeddb, pruebas de integración de navegador y
entorno Supabase controlado; comparación antes/después para demostrar cero
escrituras y cero reintentos

**Target Platform**: Navegador de PC con PWA VentaRD; endpoint de lectura Next
autenticado para evidencia remota cuando esté disponible

**Project Type**: Aplicación web POS offline-first con diagnóstico interno aislado

**Performance Goals**: Al menos 95 % de análisis de hasta 1.000 productos,
10.000 movimientos y 5.000 ventas en 60 s o menos en equipo objetivo acordado;
indexación lineal por ID y ámbito, sin búsquedas cuadráticas por entidad

**Constraints**: Cero mutaciones en fuentes locales/remotas y cero disparos de
sync; captura local coherente; lecturas remotas acotadas y paginadas; salida
determinista con instante explícito; sin cambios a cobro, worker, RLS, RPC,
NCF, caja, informes existentes o UI de producción; no suponer esquema
desplegado idéntico al repositorio

**Scale/Scope**: Una conciliación por negocio/sucursal/periodo y hasta dos
instantáneas de dispositivo aportadas; 25 requisitos funcionales, cuatro
jornadas de usuario y ocho criterios de éxito

## Constitution Check

*GATE: aprobado para investigación; re-evaluado después del diseño. Las
violaciones preexistentes del producto se diagnostican, no se corrigen aquí.*

| Principios | Gate previo | Evidencia del diseño / gate posterior |
|---|---|---|
| I, XIV, XV, XVII: datos, verificación, incremento, migración | PASS | Solo lectura, sin cambio de esquema ni reparación; informe distingue evidencia insuficiente. PASS |
| II, IX: offline y aislamiento | PASS | Núcleo funciona solo con captura local; PC B no se infiere ni se promete exclusión global. PASS |
| III, IV, VIII, XII: operaciones, kardex, venta, atomicidad | PASS | Lee identidades/efectos existentes; no modifica dominio y declara operaciones parciales. PASS |
| V, VI, VII, X, XI: sync, reintento, conflicto, carga, autoridad | PASS | Estado 0/1 se interpreta sin persistir; ausencia remota exige cobertura; cada fuente tiene procedencia. PASS |
| XIII, XX: observabilidad y divergencia | PASS | Hallazgo estable, severidad, etapa, evidencia faltante y no verificable. PASS |
| XVI, XIX: caracterización y pruebas proporcionales | PASS | Fixtures de cobro actual, fallos remotos, dos PCs, caja y reportes; integración controlada prevista. PASS |
| XVIII: seguridad | PASS | Lectura remota con identidad y rol verificados en servidor; ámbito por negocio/sucursal y redacción. PASS |
| Governance: excepciones | PASS | Ninguna excepción propuesta; cualquier nueva necesidad de escritura/schema detiene esta spec. PASS |

**Release gate pendiente, no violación de diseño**: verificar en staging la política
RLS real, autorización del endpoint, completitud de paginación y no mutación.
La base de producción no se consulta ni modifica en esta fase de planificación.

## Project Structure

### Documentation (this feature)

```text
specs/001-diagnosticar-divergencias-datos/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/requirements.md
└── contracts/
    ├── snapshot.md
    ├── report.md
    └── remote-read.md
```

### Source Code (repository root)

```text
src/
├── types/database.ts                         # contratos persistidos existentes
├── lib/db/dexie.ts                            # tablas e índices locales existentes
├── lib/db/worker.ts                           # solo caracterizar, no modificar
├── lib/exports/queries.ts                     # fórmulas actuales a caracterizar
├── components/shared/CajaModal.tsx           # fórmula actual a caracterizar
├── lib/api/guardia.ts                         # guardias existentes para lectura remota
├── lib/diagnostics/reconciliation/            # propuesto: núcleo y adaptadores
│   ├── types.ts
│   ├── normalize.ts
│   ├── analyze.ts
│   ├── rules/
│   ├── readers/local.ts
│   ├── readers/remote.ts
│   └── *.test.ts
└── app/api/diagnostics/remote-snapshot/route.ts  # propuesto: GET solo lectura

scripts/diagnostics/                         # propuesto: runner interno de soporte
```

**Structure Decision**: Añadir un módulo aislado bajo src/lib, sin integrarlo a
las pantallas de cobro, caja o reportes. El runner de soporte obtiene instantáneas
en una sesión autorizada y produce el informe sin escribirlo en las tablas de
negocio. El endpoint remoto solo entrega evidencia limitada y autenticada;
no recibe operaciones para ejecutar. Una futura UI de diagnóstico sería otra
spec. Los paths propuestos son diseño, no archivos creados ahora.

## Design Boundaries

1. **Captura local**: una lectura Dexie de modo readonly que reúna ventas,
   detalles, productos, movimientos, clientes/fiado, seriales, devoluciones,
   cajas/cortes, gastos y pagos de módulos Pro dentro del ámbito elegido. El
   adaptador registra cobertura y ventana de captura; no usa llamadas al worker.
2. **Captura remota**: lecturas SELECT con filtro de negocio/sucursal, periodo,
   IDs y paginación exhaustiva. El servidor verifica usuario y rol antes de
   leer; respuesta denegada o incompleta no se convierte en evidencia de
   ausencia. Las tablas remotas no comparten snapshot atómico en este plan;
   se registra ventana temporal y se degrada la conclusión si cambia.
   Sin conexión, la captura local opera solo en el contexto ya cacheado y
   desbloqueado; esa identidad se etiqueta como no verificada por servidor,
   no habilita lecturas remotas ni compartir datos sensibles. La autorización
   remota se verifica de nuevo al recuperar conexión.
3. **Normalización**: conservar IDs, referencias y valores históricos, convertir
   importes a unidades exactas de dinero para comparar y etiquetar procedencia.
   No rellenar impuesto/descuento histórico con el catálogo actual ni inventar
   forma de reembolso. Redactar datos personales antes de producir informe.
4. **Análisis puro**: índices por entidad/ID y reglas independientes. Estabilidad
   del orden: severidad, categoría, código, entidad, ID. Cualquier edad usa
   asOf proporcionado; no usar reloj implícito. Un conteo absoluto solo ancla
   reconstrucción si hay secuencia causal y cobertura suficientes.
5. **Clasificación**: pendiente normal, vencido, fallo, conflicto, discrepancia
   confirmada y no verificable son estados distintos. Solo se asigna CRITICAL
   con prueba de pérdida/duplicación/falsa aplicación o riesgo monetario/stock
   confirmado; flags locales por sí solos no bastan.
6. **Reporte**: contrato versionado de salida con cobertura por fuente,
   hallazgos estables, evidencia mínima y recomendaciones diagnósticas. La
   salida no contiene acciones de reparación ni secretos. Una segunda PC solo
   participa si aporta una captura etiquetada; no se accede a ella por magia.
7. **Validación**: pruebas de caracterización de fórmulas actuales, fixtures de
   todos los casos del FR-023/024/025, comparación antes/después y controles de
   permisos en entorno aislado. El despliegue no modifica UI ni flujos activos.

## Phase 0 Research

Completada en [research.md](research.md). Las decisiones de adquisición,
autoridad, cobertura, seguridad, caracterización y entrega aislada resuelven
las incógnitas técnicas sin requerir cambio de esquema ni permiso de escritura.
No quedan marcadores NEEDS CLARIFICATION para este plan.

## Phase 1 Design

- [data-model.md](data-model.md) define instantáneas, relaciones, validación,
  hallazgos y estados interpretados sin alterar los contratos persistidos.
- [contracts/snapshot.md](contracts/snapshot.md) define entrada/cobertura.
- [contracts/report.md](contracts/report.md) define salida y códigos.
- [contracts/remote-read.md](contracts/remote-read.md) define la frontera GET
  autenticada, paginación, errores y ausencia de efectos.
- [quickstart.md](quickstart.md) describe validación local, multidispositivo,
  seguridad y no mutación en entornos controlados.
