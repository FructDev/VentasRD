CREATE TABLE IF NOT EXISTS native_recovery_plans_v1(
 recovery_id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 context_key TEXT NOT NULL,
 custody_directory TEXT NOT NULL,
 custody_json TEXT NOT NULL,
 facts_json TEXT NOT NULL,
 review_json TEXT NOT NULL,
 request_json TEXT,
 request_hash TEXT,
 receipt TEXT,
 state TEXT NOT NULL CHECK(state IN('REVIEW','BLOCKED','PREPARED','ACTIVE','ABANDONED'))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_native_recovery_active_context ON native_recovery_plans_v1(context_key) WHERE state NOT IN('ACTIVE','ABANDONED');
-- Inline ciphertext keeps conserved ancestors in later portable backups.
CREATE TABLE IF NOT EXISTS native_recovery_assets_v1(
 custody_directory TEXT PRIMARY KEY,
 ciphertext BLOB NOT NULL CHECK(length(ciphertext)<=134217728)
) STRICT;
