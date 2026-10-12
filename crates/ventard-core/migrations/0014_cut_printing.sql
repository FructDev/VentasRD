-- Local immutable cut printing attempts; no second cash operation on retry.
CREATE TABLE IF NOT EXISTS native_document_print_attempts_v1 (
 attempt_id TEXT PRIMARY KEY,
 operation_id TEXT NOT NULL REFERENCES operation_journal(operation_id),
 snapshot_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('UNKNOWN','FAILED'))
) STRICT;
INSERT OR IGNORE INTO native_document_print_attempts_v1 SELECT * FROM native_print_attempts_v1;
