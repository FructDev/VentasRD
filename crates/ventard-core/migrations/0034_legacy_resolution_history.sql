-- Read-only historical custody, never operational authority or active identity.
CREATE TABLE IF NOT EXISTS legacy_resolution_history_v1 (
 tenant_id TEXT NOT NULL, scope_key TEXT NOT NULL, history_hash TEXT NOT NULL,
 body TEXT NOT NULL CHECK(json_valid(body)),cutover_id TEXT NOT NULL,
 receipt TEXT NOT NULL CHECK(json_valid(receipt)),active INTEGER NOT NULL DEFAULT 0 CHECK(active IN(0,1)),
 PRIMARY KEY(tenant_id,scope_key,history_hash)
) STRICT;
