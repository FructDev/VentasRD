-- Additive metadata and immutable operational records. No historical synthesis.
CREATE TABLE IF NOT EXISTS native_customer_metadata_v1 (
 customer_id TEXT PRIMARY KEY REFERENCES sale_customer_accounts_v1(customer_id),tenant_id TEXT NOT NULL,
 phone TEXT,price_tier INTEGER NOT NULL CHECK(price_tier IN(1,2,3)),wholesale INTEGER NOT NULL CHECK(wholesale IN(0,1)),
 revision INTEGER NOT NULL CHECK(revision>0)
) STRICT;
CREATE TABLE IF NOT EXISTS native_management_records_v1 (
 operation_id TEXT PRIMARY KEY REFERENCES operation_journal(operation_id),tenant_id TEXT NOT NULL,
 scope_key TEXT NOT NULL REFERENCES scopes(scope_key),kind TEXT NOT NULL,turn_id TEXT,customer_id TEXT,
 method TEXT,amount_cents INTEGER NOT NULL,concept TEXT NOT NULL,created_at_ms TEXT NOT NULL,
 document TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS native_management_scope_time ON native_management_records_v1(tenant_id,scope_key,created_at_ms);
CREATE INDEX IF NOT EXISTS native_management_customer ON native_management_records_v1(tenant_id,customer_id);
CREATE TABLE IF NOT EXISTS native_business_profile_v1(tenant_id TEXT PRIMARY KEY,profile TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS native_cash_baseline_v1(
 tenant_id TEXT NOT NULL,turn_id TEXT NOT NULL REFERENCES cash_turns(turn_id),net_cents INTEGER NOT NULL,
 remote_sequence INTEGER NOT NULL CHECK(remote_sequence>=0),authority TEXT NOT NULL CHECK(authority IN('VERIFIED','UNKNOWN')),
 PRIMARY KEY(tenant_id,turn_id)
) STRICT;
CREATE TABLE IF NOT EXISTS native_print_attempts_v1(
 attempt_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES sale_ticket_snapshots_v1(operation_id),
 snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),state TEXT NOT NULL CHECK(state IN('UNKNOWN','FAILED'))
) STRICT;
