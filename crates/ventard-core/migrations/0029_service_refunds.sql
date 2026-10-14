CREATE TABLE IF NOT EXISTS native_service_refunds_v1 (
 operation_id TEXT PRIMARY KEY REFERENCES operation_journal(operation_id),
 tenant_id TEXT NOT NULL,scope_key TEXT NOT NULL REFERENCES scopes(scope_key),
 family TEXT NOT NULL CHECK(family IN('repair','layaway')),service_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 document TEXT NOT NULL CHECK(json_valid(document)),
 UNIQUE(tenant_id,scope_key,family,service_id,revision)
) STRICT;
