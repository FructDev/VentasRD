CREATE TABLE IF NOT EXISTS native_printer_targets_v1 (
 tenant_id TEXT NOT NULL,installation_id TEXT NOT NULL,
 profile TEXT NOT NULL CHECK(json_valid(profile)),PRIMARY KEY(tenant_id,installation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS native_printer_probes_v1 (
 attempt_id TEXT PRIMARY KEY,context_key TEXT NOT NULL,
 target TEXT NOT NULL CHECK(json_valid(target)),wire_bytes BLOB NOT NULL,
 wire_hash TEXT NOT NULL,transport_receipt TEXT CHECK(transport_receipt IS NULL OR json_valid(transport_receipt))
) STRICT;
CREATE TABLE IF NOT EXISTS native_printer_dispatch_v1 (
 attempt_id TEXT PRIMARY KEY REFERENCES native_document_print_attempts_v1(attempt_id),
 operation_id TEXT NOT NULL,context_key TEXT NOT NULL,snapshot_hash TEXT NOT NULL,
 target TEXT NOT NULL CHECK(json_valid(target)),wire_bytes BLOB NOT NULL,
 wire_hash TEXT NOT NULL,transport_receipt TEXT CHECK(transport_receipt IS NULL OR json_valid(transport_receipt))
) STRICT;
