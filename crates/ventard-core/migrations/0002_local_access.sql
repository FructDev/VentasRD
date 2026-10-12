-- Additive local authentication. No legacy PIN conversion/default; encrypted vault only.
CREATE TABLE IF NOT EXISTS local_access_runtime_v1 (
 tenant_id TEXT NOT NULL, installation_id TEXT NOT NULL, device_id TEXT NOT NULL,
 writer_epoch TEXT NOT NULL, highwater_ms INTEGER NOT NULL CHECK(highwater_ms BETWEEN 0 AND 9007199254740991),
 openings INTEGER NOT NULL DEFAULT 0 CHECK(openings BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(tenant_id,installation_id,device_id,writer_epoch)
) STRICT;
CREATE TABLE IF NOT EXISTS local_pin_credentials_v1 (
 tenant_id TEXT NOT NULL, installation_id TEXT NOT NULL, device_id TEXT NOT NULL,
 writer_epoch TEXT NOT NULL, scope_key TEXT NOT NULL, actor_id TEXT NOT NULL,
 pin_hash TEXT NOT NULL, grant_sequence INTEGER NOT NULL CHECK(grant_sequence>0), grant_hash TEXT NOT NULL CHECK(length(grant_hash)=64),
 failures INTEGER NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),
 blocked_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(blocked_until_ms BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(tenant_id,installation_id,device_id,writer_epoch,scope_key,actor_id),
 FOREIGN KEY(tenant_id,installation_id,device_id,writer_epoch)
 REFERENCES local_access_runtime_v1(tenant_id,installation_id,device_id,writer_epoch)
) STRICT;
