# Contract: read-only diagnostic snapshot

**Version**: 1.0 (design only)  
**Producer**: local read adapter, authorized remote read adapter, or
authorized support-provided PC B capture.  
**Consumer**: deterministic reconciliation core.

## Input to reconciliation

```text
ReconciliationInput {
  contractVersion: "1.0"
  request: {
    negocioId: UUID
    sucursalId?: UUID
    desde: epochMilliseconds
    hasta: epochMilliseconds
    asOf: epochMilliseconds
    pendingThresholdMs: positiveInteger
    selectedIds?: { ventas?: UUID[], productos?: UUID[], operaciones?: UUID[] }
  }
  snapshots: SourceSnapshot[]    // local A required; remote and local B optional
}
```

The core accepts immutable copies. It never reads live databases, current
time, random values, browser state or network itself. `asOf` is supplied
explicitly. The caller must provide at least one LOCAL snapshot and may
provide REMOTE and a second LOCAL snapshot; a device label is an assertion
of provenance by the capture process, not inferred from rows.

## SourceSnapshot envelope

```text
SourceSnapshot {
  contractVersion: "1.0"
  source: {
    sourceId: stableString
    kind: "LOCAL" | "REMOTE"
    deviceLabel?: string
    negocioId: UUID
    sucursalId?: UUID
  }
  capture: {
    startedAt: epochMilliseconds
    finishedAt: epochMilliseconds
    asOf: epochMilliseconds
    temporalConsistency: "COHERENT" | "WINDOWED" | "UNKNOWN"
    observedAfterSourceIds?: stableString[] // orden de captura explícito; nunca deducido de relojes de PCs
  }
  coverage: Coverage[]
  records: {
    ventas: ObservedSale[]
    ventaDetalles: ObservedSaleLine[]
    productos: ObservedProduct[]
    movimientosStock: ObservedStockMovement[]
    transaccionesFiado: ObservedCreditTransaction[]
    seriales: ObservedSerial[]
    devoluciones: ObservedRefund[]
    cajas: ObservedCashRegister[]
    cortesCaja: ObservedCashCut[]
    gastos: ObservedExpense[]
    reparaciones: ObservedRepairPaymentSummary[]
    apartados: ObservedLayawayPaymentSummary[]
    reportes: ObservedReportValue[]
  }
}
```

Arrays may be empty only when their Coverage explicitly says COMPLETE with
zero rows, or else the missing area is PARTIAL/UNAVAILABLE. A report value
may come from a known current report calculation or a controlled fixture;
it is not silently manufactured by the reconciler.

## Coverage

```text
Coverage {
  entity: stableEntityName
  scope: { negocioId, sucursalId?, desde?, hasta?, requestedIds? }
  status: "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | "DENIED"
  startedAt: epochMilliseconds
  finishedAt: epochMilliseconds
  rowsRead: nonnegativeInteger
  pagesRead?: nonnegativeInteger
  exhausted?: boolean
  retentionHorizon?: epochMilliseconds
  concurrentChangePossible: boolean
  reason?: stableReasonCode
}
```

COMPLETE requires all requested IDs/pages examined without error and the
tenant/sucursal scope verified. A response with a default page limit reached,
an unknown total, a permission error or an interrupted read is not COMPLETE.
Cross-table remote reads are WINDOWED unless a coherent cut is independently
proven. Incomplete historical local retention is PARTIAL for the old period.

## Normalized record rules

- Stable IDs and operation references are copied exactly; no new business IDs
  are assigned by the analyzer.
- Monetary values use decimal strings with explicit currency and two-decimal
  comparison policy; original source precision is retained in the input
  adapter for audit but not exposed in the public report.
- Stock quantities use decimal strings with the source's precision. A
  valorAbsoluto is distinct from delta and requires causal ordering.
- Every record retains negocioId, available sucursalId, sourceId and
  observedAt/capture reference. Unknown source fields remain unknown, not
  defaulted to zero.
- The data allowlist excludes tokens, passwords, PINs, customer contact
  details, full IMEI and free-form notes unless strictly necessary for a
  specific approved diagnostic rule. IDs are sufficient for standard rules.
- The adapter never calls sync/retry/write methods. A local reader uses one
  read-only coherent capture where feasible; if that guarantee fails it sets
  temporalConsistency to UNKNOWN or WINDOWED.

## Error and compatibility behavior

- Invalid scope or malformed ID: reject input with no report or source read.
- Unsupported contract version: COMPATIBILITY finding or explicit rejection;
  never silently reinterpret fields.
- Missing legacy fields: represent as unknown and mark affected rule
  UNVERIFIABLE, not zero/false.
- Remote unavailable or access denied: local analysis may continue with
  coverage UNAVAILABLE/DENIED; no remote absence findings.
- Duplicate rows inside an input snapshot are a capture/compatibility issue.
  The same ID across local and remote is expected correspondence.
- The snapshot is transient. Persisting diagnostic captures, if later needed,
  requires a separate privacy/security decision and specification.

## Example envelope (illustrative, no personal data)

```json
{
  "contractVersion": "1.0",
  "source": {
    "sourceId": "pc-a-20260922-001",
    "kind": "LOCAL",
    "deviceLabel": "PC A",
    "negocioId": "00000000-0000-4000-8000-000000000001"
  },
  "capture": {
    "startedAt": 1790040000000,
    "finishedAt": 1790040000100,
    "asOf": 1790040000100,
    "temporalConsistency": "COHERENT"
  },
  "coverage": [
    {
      "entity": "movimientosStock",
      "scope": { "negocioId": "00000000-0000-4000-8000-000000000001" },
      "status": "COMPLETE",
      "startedAt": 1790040000000,
      "finishedAt": 1790040000100,
      "rowsRead": 0,
      "exhausted": true,
      "concurrentChangePossible": false
    }
  ],
  "records": { "movimientosStock": [] }
}
```

The abbreviated example omits the remaining record arrays for readability;
real inputs must include all arrays and matching coverage entries.
