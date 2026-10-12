-- Local allocation evidence. Never bootstrap from mutable settings or sales MAX.
CREATE TABLE IF NOT EXISTS fiscal_watermarks (
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('B01','B02')),
    last_accepted INTEGER NOT NULL CHECK(last_accepted BETWEEN 1 AND 99999999),
    PRIMARY KEY(tenant_id,kind)
) STRICT;
CREATE TABLE IF NOT EXISTS fiscal_blocks (
    tenant_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    writer_epoch TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('B01','B02')),
    first_number INTEGER NOT NULL CHECK(first_number BETWEEN 1 AND 99999999),
    last_number INTEGER NOT NULL CHECK(last_number BETWEEN first_number AND 99999999 AND last_number-first_number<20),
    next_number INTEGER NOT NULL CHECK(next_number BETWEEN first_number AND last_number+1),
    evidence_hash TEXT NOT NULL CHECK(length(evidence_hash)=64),
    evidence_bytes BLOB NOT NULL,
    PRIMARY KEY(tenant_id,request_id)
) STRICT;
CREATE INDEX IF NOT EXISTS fiscal_available ON fiscal_blocks(tenant_id,installation_id,writer_epoch,kind,first_number);
CREATE TABLE IF NOT EXISTS fiscal_reservations (
    operation_id TEXT PRIMARY KEY REFERENCES checkout_drafts(operation_id),
    tenant_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    context_key TEXT NOT NULL CHECK(length(context_key)=64),
    intention_hash TEXT NOT NULL CHECK(length(intention_hash)=64),
    kind TEXT NOT NULL CHECK(kind IN ('B01','B02')),
    number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 99999999),
    ncf TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('PREPARED','COMMITTED','ABANDONED')),
    UNIQUE(tenant_id,ncf),
    FOREIGN KEY(tenant_id,block_id) REFERENCES fiscal_blocks(tenant_id,request_id)
) STRICT;
CREATE TABLE IF NOT EXISTS ticket_sequences (
    tenant_id TEXT NOT NULL,
    installation_id TEXT NOT NULL REFERENCES installations(installation_id),
    device_id TEXT NOT NULL,
    writer_epoch TEXT NOT NULL,
    prefix TEXT NOT NULL,
    last_issued INTEGER NOT NULL CHECK(last_issued BETWEEN 0 AND 9007199254740991),
    evidence_hash TEXT NOT NULL CHECK(length(evidence_hash)=64),
    evidence_bytes BLOB NOT NULL,
    PRIMARY KEY(tenant_id,installation_id),
    UNIQUE(tenant_id,prefix)
) STRICT;
CREATE TABLE IF NOT EXISTS ticket_allocations (
    operation_id TEXT PRIMARY KEY REFERENCES operation_journal(operation_id),
    tenant_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    intention_hash TEXT NOT NULL CHECK(length(intention_hash)=64),
    number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 9007199254740991),
    ticket TEXT NOT NULL,
    UNIQUE(tenant_id,ticket),
    FOREIGN KEY(tenant_id,installation_id) REFERENCES ticket_sequences(tenant_id,installation_id)
) STRICT;
