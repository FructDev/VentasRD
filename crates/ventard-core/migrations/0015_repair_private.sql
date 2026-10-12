-- Equipment credentials stay outside the public financial journal/feed.
-- These tables live inside the encrypted vault; native MANAGE guards apply.
CREATE TABLE IF NOT EXISTS native_repair_private_intents_v1 (
 operation_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,scope_key TEXT NOT NULL,
 actor_id TEXT NOT NULL,installation_id TEXT NOT NULL,device_id TEXT NOT NULL,writer_epoch TEXT NOT NULL,
 repair_id TEXT NOT NULL,request_hash TEXT NOT NULL,private_bytes TEXT NOT NULL,private_hash TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS native_repair_private_values_v1 (
 repair_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,scope_key TEXT NOT NULL,
 operation_id TEXT NOT NULL,repair_revision INTEGER NOT NULL,credential TEXT NOT NULL,
 remote_state TEXT NOT NULL CHECK(remote_state IN('PENDING','APPLIED','INTERVENTION'))
) STRICT;
CREATE TABLE IF NOT EXISTS native_repair_private_outbox_v1 (
 operation_id TEXT PRIMARY KEY REFERENCES operation_journal(operation_id),
 intent TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('PENDING','APPLIED','INTERVENTION'))
) STRICT;
