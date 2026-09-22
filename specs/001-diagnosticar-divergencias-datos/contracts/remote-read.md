# Contract: authorized remote diagnostic read

**Version**: 1.0 (design only)  
**Operation**: GET /api/diagnostics/remote-snapshot  
**Property**: read-only; no repair, retry, sync trigger or persisted report.

This interface is the only proposed remote diagnostic surface. It is not a
business-write API. The reconciler can still operate locally if it is
unavailable or denied.

## Request

Authenticated request with bearer session token. Query parameters:

| Parameter | Required | Meaning |
|---|---|---|
| negocioId | yes | Business being inspected; must match verified ownership/admin role |
| entity | yes | One allowlisted diagnostic entity from snapshot contract |
| sucursalId | no | Branch context; verified to belong to negocioId |
| desde, hasta | for time-based scans | Bounded epoch-millisecond interval |
| id | optional | Exact row ID lookup, preferred for proof of presence/absence |
| cursor | optional | Opaque continuation token scoped to the same query |
| limit | optional | Page size, capped at 500 |
| asOf | yes | Explicit diagnostic reference instant; not a server snapshot promise |

The server rejects invalid ranges, unsupported entities, excessive scope
and malformed cursor/ID before any data read. A caller cannot ask for
unbounded data or change the tenant between cursor pages.

## Authorization and isolation

1. Verify bearer token on every request using server-side identity.
2. Verify that the user is owner or active admin of negocioId; a cached
   browser role or hidden button is not sufficient.
3. Verify sucursalId belongs to negocioId if present.
4. Apply negocioId filtering to every direct tenant table. For a table
   without direct negocioId, prove ownership through its related product,
   sale or branch before returning a row. Never return a row with
   unproven ownership.
5. Use user-scoped database reads where feasible. If a privileged client is
   indispensable, the same server checks and row-level scope are mandatory
   on every query; this is not permission to change RLS.
6. Emit only allowlisted diagnostic fields, not contacts, secrets, tokens,
   free-form customer notes or full serial/IMEI values.
7. Add no-store response semantics and a bounded request rate to reduce
   accidental disclosure and load.

## Successful response

```text
RemoteSnapshotPage {
  contractVersion: "1.0"
  entity: stableEntityName
  scope: { negocioId, sucursalId?, desde?, hasta?, id? }
  capture: { startedAt, finishedAt, temporalConsistency: "WINDOWED" }
  records: normalizedRecord[]
  coverage: {
    status: "COMPLETE" | "PARTIAL"
    rowsRead: integer
    pagesRead: integer
    exhausted: boolean
    reason?: stableReasonCode
  }
  nextCursor?: opaqueString
}
```

For exact ID lookup, COMPLETE plus zero records means the ID was not present
in that authorized remote view at the observed time. For range scans,
COMPLETE requires every page consumed; an individual page with nextCursor
is PARTIAL as a whole-scan evidence source. Cross-entity calls are not
atomic together. The caller records their windows and does not elevate
uncertain negative evidence to CRITICAL.

## Error response

| Status | Meaning | Reconciliation behavior |
|---|---|---|
| 400 | Invalid scope or query | Stop this remote read; no absence claim |
| 401 | No valid session | Remote coverage UNAVAILABLE |
| 403 | Not owner/admin or branch outside business | Remote coverage DENIED |
| 429 | Rate limit | PARTIAL/UNAVAILABLE; no retry initiated by core |
| 503 | Remote read unavailable or interrupted | PARTIAL/UNAVAILABLE with reason |

Errors contain stable codes and no database internals, tokens or personal
data. A retry is a separate operator action outside the reconciliation core.

## Non-mutation contract

- The handler performs only identity/role checks and SELECT-like reads.
- It never calls stock RPCs, sync worker functions, upsert, update, delete,
  insert or a reconciliation repair procedure.
- Read calls do not advance worker cursors or local sync flags.
- Integration tests use a controlled tenant and a second unauthorized tenant
  to prove isolation, then compare all business rows before/after.
- No production policy or schema migration is part of this contract.
