-- Native-owned paths, no renderer paths or recovery key material.
CREATE TABLE IF NOT EXISTS native_backup_jobs_v1 (
 operation_id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL, installation_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 source TEXT NOT NULL CHECK(json_valid(source)),
 backup_path TEXT NOT NULL, key_path TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('PREPARED','VERIFIED','FAILED')),
 result TEXT CHECK(result IS NULL OR json_valid(result))
) STRICT;
