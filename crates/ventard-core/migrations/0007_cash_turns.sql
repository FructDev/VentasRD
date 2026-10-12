-- Local TURN_OPEN substrate; activation/fencing remain separate gates.
CREATE TABLE IF NOT EXISTS cash_drawers (
    tenant_id TEXT NOT NULL,
    scope_key TEXT NOT NULL REFERENCES scopes(scope_key),
    revision INTEGER NOT NULL CHECK(revision>=0),
    PRIMARY KEY(tenant_id,scope_key)
) STRICT;
CREATE TABLE IF NOT EXISTS cash_turns (
    turn_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE REFERENCES operation_journal(operation_id),
    tenant_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    origin_device_id TEXT NOT NULL,
    origin_installation_id TEXT NOT NULL,
    writer_epoch INTEGER NOT NULL CHECK(writer_epoch>0),
    permission_grant_id TEXT NOT NULL,
    opening_cents INTEGER NOT NULL CHECK(opening_cents BETWEEN 0 AND 9007199254740991),
    opened_at_ms TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0),
    status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSING','CLOSED')),
    FOREIGN KEY(tenant_id,scope_key) REFERENCES cash_drawers(tenant_id,scope_key)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS cash_one_open_drawer ON cash_turns(tenant_id,scope_key) WHERE status IN ('OPEN','CLOSING');
CREATE INDEX IF NOT EXISTS cash_scope_history ON cash_turns(tenant_id,scope_key,opened_at_ms,turn_id);
