-- Evolve the prototype tables without inventing historical cost/turn facts.
CREATE TABLE IF NOT EXISTS sale_free_settings_v1 (
 tenant_id TEXT NOT NULL,scope_key TEXT NOT NULL REFERENCES scopes(scope_key),tax_rate TEXT NOT NULL,
 PRIMARY KEY(tenant_id,scope_key)
) STRICT;
CREATE TABLE IF NOT EXISTS sales_next (
 sale_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE REFERENCES operation_journal(operation_id),
 tenant_id TEXT NOT NULL,scope_key TEXT NOT NULL REFERENCES scopes(scope_key),turn_id TEXT,
 ticket TEXT NOT NULL,ncf TEXT,actor_id TEXT NOT NULL,total_cents INTEGER NOT NULL,
 tax_cents INTEGER NOT NULL,discount_cents INTEGER NOT NULL,calculation_version TEXT NOT NULL,created_at TEXT NOT NULL
) STRICT;
INSERT INTO sales_next SELECT * FROM sales;
CREATE TABLE IF NOT EXISTS sale_lines_next (
 line_id TEXT PRIMARY KEY,sale_id TEXT NOT NULL REFERENCES sales_next(sale_id),producto_id TEXT,
 nombre TEXT NOT NULL,precio_cents INTEGER NOT NULL,tasa_percent TEXT NOT NULL,receta_ratio TEXT,
 costo_cents INTEGER,cantidad TEXT NOT NULL,serial TEXT
) STRICT;
INSERT INTO sale_lines_next SELECT * FROM sale_lines;
CREATE TABLE IF NOT EXISTS payments_next (
 payment_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES operation_journal(operation_id),
 sale_id TEXT REFERENCES sales_next(sale_id),service_id TEXT,method TEXT NOT NULL,
 amount_cents INTEGER NOT NULL,tender_cents INTEGER NOT NULL,change_cents INTEGER NOT NULL,turn_id TEXT
) STRICT;
INSERT INTO payments_next SELECT * FROM payments;
DROP TABLE payments;
DROP TABLE sale_lines;
DROP TABLE sales;
ALTER TABLE sales_next RENAME TO sales;
ALTER TABLE sale_lines_next RENAME TO sale_lines;
ALTER TABLE payments_next RENAME TO payments;
CREATE INDEX IF NOT EXISTS idx_sales_scope_time ON sales(scope_key,created_at);

CREATE TABLE IF NOT EXISTS sale_customer_accounts_v1 (
 customer_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,scope_key TEXT NOT NULL REFERENCES scopes(scope_key),
 name TEXT NOT NULL,balance_cents INTEGER NOT NULL,limit_cents INTEGER,active INTEGER NOT NULL CHECK(active IN(0,1)),
 authority_state TEXT NOT NULL CHECK(authority_state IN('VERIFIED','UNKNOWN')),revision INTEGER NOT NULL CHECK(revision>0)
) STRICT;
CREATE TABLE IF NOT EXISTS sale_serial_inventory_v1 (
 tenant_id TEXT NOT NULL,scope_key TEXT NOT NULL REFERENCES scopes(scope_key),producto_id TEXT NOT NULL REFERENCES products(producto_id),
 serial TEXT NOT NULL,revision TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('AVAILABLE','RESERVED','SOLD')),
 sale_operation_id TEXT REFERENCES operation_journal(operation_id),PRIMARY KEY(tenant_id,scope_key,serial)
) STRICT;
CREATE TABLE IF NOT EXISTS sale_credit_entries_v1 (
 operation_id TEXT PRIMARY KEY REFERENCES operation_journal(operation_id),
 customer_id TEXT NOT NULL REFERENCES sale_customer_accounts_v1(customer_id),
 tenant_id TEXT NOT NULL,scope_key TEXT NOT NULL,amount_cents INTEGER NOT NULL,balance_before INTEGER NOT NULL,balance_after INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sale_cash_entries_v1 (
 operation_id TEXT PRIMARY KEY REFERENCES operation_journal(operation_id),
 turn_id TEXT NOT NULL REFERENCES cash_turns(turn_id),tenant_id TEXT NOT NULL,scope_key TEXT NOT NULL,amount_cents INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sale_cart_consumptions_v1 (
 operation_id TEXT PRIMARY KEY REFERENCES operation_journal(operation_id),context_key TEXT NOT NULL,cart_id TEXT NOT NULL,
 cart_revision INTEGER NOT NULL,FOREIGN KEY(context_key,cart_id) REFERENCES account_drafts(context_key,id),UNIQUE(context_key,cart_id)
) STRICT;
CREATE TABLE IF NOT EXISTS sale_ticket_snapshots_v1 (
 operation_id TEXT PRIMARY KEY REFERENCES operation_journal(operation_id),
 snapshot_bytes BLOB NOT NULL,snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64)
) STRICT;
CREATE TABLE IF NOT EXISTS sale_print_settings_v1 (
 tenant_id TEXT NOT NULL,installation_id TEXT NOT NULL,auto_print INTEGER NOT NULL CHECK(auto_print IN(0,1)),
 printer_profile_id TEXT,PRIMARY KEY(tenant_id,installation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS sale_print_jobs_v1 (
 job_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE REFERENCES sale_ticket_snapshots_v1(operation_id),
 snapshot_hash TEXT NOT NULL,printer_profile_id TEXT,
 state TEXT NOT NULL CHECK(state IN('QUEUED','WAITING_CONFIGURATION','SENT','UNKNOWN','FAILED'))
) STRICT;
