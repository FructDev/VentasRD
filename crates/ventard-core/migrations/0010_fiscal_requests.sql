-- Durable request identity before network I/O. No token, PIN or business effect.
CREATE TABLE IF NOT EXISTS fiscal_requests_v2 (
 context_key TEXT NOT NULL,
 request_id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('B01','B02')),
 payload_bytes BLOB NOT NULL,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 state TEXT NOT NULL CHECK(state IN ('UNKNOWN','ALLOCATED','NO_BLOCK')),
 receipt_bytes BLOB,
 CHECK((state='UNKNOWN' AND receipt_bytes IS NULL) OR
       (state<>'UNKNOWN' AND receipt_bytes IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS fiscal_request_pending_v2
 ON fiscal_requests_v2(context_key,kind) WHERE state='UNKNOWN';
