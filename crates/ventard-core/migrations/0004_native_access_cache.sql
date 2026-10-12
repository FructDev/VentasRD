CREATE TABLE IF NOT EXISTS native_access_grant_cache_v1 (
 tenant_id TEXT NOT NULL, installation_id TEXT NOT NULL, device_id TEXT NOT NULL,
 writer_epoch TEXT NOT NULL, scope_key TEXT NOT NULL, actor_id TEXT NOT NULL,
 grant_sequence INTEGER NOT NULL CHECK(grant_sequence BETWEEN 1 AND 9007199254740991),
 wire BLOB NOT NULL CHECK(length(wire)<=8192), wire_hash TEXT NOT NULL CHECK(length(wire_hash)=64),
 PRIMARY KEY(tenant_id,installation_id,device_id,writer_epoch,scope_key,actor_id)
) STRICT;
