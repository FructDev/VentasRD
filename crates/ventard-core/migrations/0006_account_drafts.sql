-- Editable account drafts only. No journal/outbox/stock/payment effects.
CREATE TABLE IF NOT EXISTS account_drafts (
    context_key TEXT NOT NULL CHECK(length(context_key)=64),
    id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK(seq > 0),
    revision INTEGER NOT NULL CHECK(revision > 0),
    status TEXT NOT NULL CHECK(status IN ('ACTIVE','PAUSED','DISCARDED')),
    lines TEXT NOT NULL CHECK(json_valid(lines) AND json_type(lines)='array'),
    PRIMARY KEY(context_key,id),
    UNIQUE(context_key,seq)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS account_draft_active ON account_drafts(context_key) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS account_draft_paused ON account_drafts(context_key,status,seq);
CREATE TABLE IF NOT EXISTS account_draft_requests (
    context_key TEXT NOT NULL CHECK(length(context_key)=64),
    request_id TEXT NOT NULL,
    hash TEXT NOT NULL CHECK(length(hash)=64),
    result TEXT NOT NULL CHECK(json_valid(result)),
    PRIMARY KEY(context_key,request_id)
) STRICT;
