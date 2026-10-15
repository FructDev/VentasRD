-- Private control requests; never part of sales/financial outbox or grants.
CREATE TABLE IF NOT EXISTS native_team_requests_v1(
 operation_id TEXT PRIMARY KEY,context TEXT NOT NULL,request TEXT NOT NULL,
 request_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('PREPARED','APPLIED','CANCELLED')),
 result TEXT CHECK(result IS NULL OR json_valid(result))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS native_team_one_pending_v1
 ON native_team_requests_v1(context) WHERE state='PREPARED';
