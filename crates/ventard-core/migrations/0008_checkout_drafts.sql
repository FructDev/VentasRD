-- Preparation only: no sale, stock reservation, payment or dispatch.
CREATE TABLE IF NOT EXISTS checkout_drafts (
    operation_id TEXT PRIMARY KEY REFERENCES operation_journal(operation_id),
    context_key TEXT NOT NULL CHECK(length(context_key)=64),
    cart_id TEXT NOT NULL,
    cart_revision INTEGER NOT NULL CHECK(cart_revision>0),
    quote_hash TEXT NOT NULL CHECK(length(quote_hash)=64),
    FOREIGN KEY(context_key,cart_id) REFERENCES account_drafts(context_key,id)
) STRICT;
CREATE INDEX IF NOT EXISTS checkout_cart_state ON checkout_drafts(context_key,cart_id,cart_revision);
