CREATE TABLE IF NOT EXISTS native_fiscal_settings_requests_v1 (
 request_id TEXT PRIMARY KEY,context_key TEXT NOT NULL,
 payload_bytes BLOB NOT NULL,payload_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('UNKNOWN','RECEIVED','ABANDONED')),
 receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS native_fiscal_settings_one_pending_v1 ON native_fiscal_settings_requests_v1(context_key) WHERE state='UNKNOWN';
CREATE TABLE IF NOT EXISTS native_fiscal_settings_cache_v1(context_key TEXT PRIMARY KEY,capture TEXT NOT NULL CHECK(json_valid(capture))) STRICT;
