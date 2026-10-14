CREATE TABLE IF NOT EXISTS legacy_service_baselines_v1 (
 tenant_id TEXT NOT NULL, scope_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('repair','layaway')),
 service_id TEXT NOT NULL, envelope TEXT NOT NULL CHECK(json_valid(envelope)),
 PRIMARY KEY(tenant_id,scope_key,kind,service_id)
) STRICT;
-- Print attempts for an adopted source are distinct from native sale journal.
CREATE TABLE IF NOT EXISTS legacy_service_print_attempts_v1 (
 attempt_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,snapshot_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('UNKNOWN','FAILED'))
) STRICT;
CREATE TABLE IF NOT EXISTS legacy_service_printer_dispatch_v1 (
 attempt_id TEXT PRIMARY KEY REFERENCES legacy_service_print_attempts_v1(attempt_id),
 operation_id TEXT NOT NULL,context_key TEXT NOT NULL,snapshot_hash TEXT NOT NULL,
 target TEXT NOT NULL CHECK(json_valid(target)),wire_bytes BLOB NOT NULL,wire_hash TEXT NOT NULL,
 transport_receipt TEXT CHECK(transport_receipt IS NULL OR json_valid(transport_receipt))
) STRICT;
