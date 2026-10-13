CREATE TABLE IF NOT EXISTS native_inventory_import_v1 (
 operation_id TEXT PRIMARY KEY,
 context_key TEXT NOT NULL,
 input_hash TEXT NOT NULL,
 plan TEXT NOT NULL CHECK(json_valid(plan))
) STRICT;
