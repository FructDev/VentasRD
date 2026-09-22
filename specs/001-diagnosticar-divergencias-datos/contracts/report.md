# Contract: ReconciliationReport

**Version**: 1.0 (design only)  
**Direction**: analysis output; never an instruction to repair or retry.

## Shape

```text
ReconciliationReport {
  contractVersion: "1.0"
  asOf: epochMilliseconds
  scope: { negocioId, sucursalId?, desde, hasta, deviceLabels[] }
  overall: "CONSISTENT_WITH_EVIDENCE" |
           "FINDINGS_PRESENT" |
           "INCOMPLETE_EVIDENCE"
  sources: { sourceId, kind, captureWindow, coverageSummary }[]
  coverage: CoverageSummary[]
  counts: {
    bySeverity: { INFO, WARNING, ERROR, CRITICAL }
    byCategory: { SALE, INVENTORY, SYNC, PAYMENT, CASH,
                  REPORTING, COMPATIBILITY, UNKNOWN }
    unverifiable: nonnegativeInteger
  }
  findings: Finding[]
}

Finding {
  findingId: stableString
  code: stableCode
  severity: "INFO" | "WARNING" | "ERROR" | "CRITICAL"
  category: "SALE" | "INVENTORY" | "SYNC" | "PAYMENT" |
            "CASH" | "REPORTING" | "COMPATIBILITY" | "UNKNOWN"
  entity: stableEntityName
  ids: { saleId?, productId?, movementId?, cashId?,
         refundId?, operationId? }
  sources: sourceId[]
  explanation: sanitizedText
  localEvidence: EvidenceRef[]
  remoteEvidence: EvidenceRef[]
  missingEvidence: stableReasonCode[]
  interpretedSyncState?: "PENDING" | "PENDING_AGED" |
                         "APPLIED_VERIFIED" | "RECOVERABLE_ERROR" |
                         "INTERVENTION_REQUIRED" | "FALSE_CONFIRMED" |
                         "UNKNOWN"
  verificability: "VERIFIED" | "DISCREPANT" | "UNVERIFIABLE"
  diagnosticRecommendation: sanitizedText
}

EvidenceRef {
  sourceId: stableString
  entity: stableEntityName
  id: stableString
  field?: allowlistedField
  observedValue?: sanitizedScalar
  capturedAt: epochMilliseconds
  coverageStatus: "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | "DENIED"
}
```

## Stable finding codes (initial registry)

| Code | Category | Default level / condition |
|---|---|---|
| SALE_ORPHAN_LINE | SALE | ERROR only with complete sale coverage |
| SALE_MISSING_REQUIRED_EFFECT | SALE | ERROR with complete coverage; else UNVERIFIABLE |
| SALE_TOTAL_MISMATCH | SALE | ERROR only with complete historical monetary facts |
| SALE_TOTAL_UNVERIFIABLE | SALE | INFO or WARNING; missing historical tax/discount |
| STOCK_BASE_UNVERIFIABLE | INVENTORY | INFO/WARNING; no trusted baseline/order |
| STOCK_MATERIALIZED_MISMATCH | INVENTORY | ERROR/CRITICAL only with complete causal evidence |
| STOCK_PRODUCT_MISSING | INVENTORY | ERROR if product absence verified |
| MOVEMENT_DUPLICATE_SUSPECTED | INVENTORY | WARNING until double effect is proved |
| MOVEMENT_DOUBLE_APPLIED | INVENTORY | CRITICAL with verified duplicate effect |
| SYNC_PENDING | SYNC | INFO while within threshold |
| SYNC_PENDING_AGED | SYNC | WARNING after threshold with connectivity evidence |
| SYNC_FALSE_CONFIRMED | SYNC | CRITICAL when local applied claim conflicts with complete remote evidence |
| SYNC_REMOTE_UNVERIFIABLE | SYNC | INFO/WARNING for unavailable/incomplete remote read |
| PRODUCT_PENDING_EDIT_CONFLICT | SYNC | WARNING or CRITICAL if loss is proven |
| DEVICE_PROPAGATION_GAP | SYNC | WARNING/ERROR with stage and freshness context |
| PAYMENT_CASH_MISMATCH | PAYMENT | ERROR/CRITICAL with sufficient monetary evidence |
| CASH_CONTEXT_MISMATCH | CASH | ERROR/CRITICAL with confirmed wrong tenant/shift |
| CASH_CUT_INCOMPLETE | CASH | ERROR if closure/cut coverage complete |
| REFUND_SETTLEMENT_UNVERIFIABLE | CASH | INFO/WARNING; no refund method evidence |
| REPORT_TAX_UNVERIFIABLE | REPORTING | WARNING when historical rate unavailable |
| REPORT_REFUND_GAP | REPORTING | ERROR if omission verified |
| REPORT_HISTORY_PARTIAL | REPORTING | WARNING due to retention/incomplete coverage |
| SNAPSHOT_SCOPE_CONFLICT | COMPATIBILITY | ERROR; differing tenant/sucursal |
| SNAPSHOT_INCOMPLETE | UNKNOWN | INFO/WARNING with missing coverage details |

The code is stable across language changes. Default level is not a fixed
mapping: rules may lower certainty, never elevate to CRITICAL without direct
evidence. Adding/changing codes requires a contract-version review.

## Classification rules

1. `CONSISTENT_WITH_EVIDENCE` means no inconsistency found **within complete
   coverage for the evaluated invariants**. It is not a universal certificate.
2. `INCOMPLETE_EVIDENCE` applies whenever a required source, period or entity
   cannot be verified. It remains visible even when other findings exist;
   overall may be FINDINGS_PRESENT, with unverifiable count and coverage.
3. A pending operation inside the declared threshold is not corruption.
   Exceeding it is a review signal, not proof of loss.
4. A local sync flag of 1 is an assertion to check, not a remote receipt.
5. A CRITICAL finding needs direct proof of a lost/duplicated effect, a
   remotely absent operation despite complete valid lookup, or confirmed
   money/stock error. Missing network or partial pages preclude that proof.
6. For PC A → remote → PC B, the report names the first stage lacking
   sufficient evidence and lists the evidence needed to disambiguate it.

## Determinism, ordering and privacy

- Same request, snapshots, rules and asOf produce identical report fields,
  finding IDs and ordering. No generated-at clock or random ID is inserted.
- Sort findings by severity (CRITICAL, ERROR, WARNING, INFO), category,
  code, entity, primary ID and sourceId. Ties use stable lexical order.
- `findingId` derives from version + code + scope + sorted relevant IDs +
  sources, not from encounter order.
- Evidence values are allowlisted and redacted before serialization.
  Tokens, PINs, credentials, customer contacts, full IMEI, passwords and
  free-form notes must not appear.
- Recommendations may request a **diagnostic** next step (for example,
  obtain a complete remote reading) but cannot encode an automatic repair,
  retry, update or deletion.
