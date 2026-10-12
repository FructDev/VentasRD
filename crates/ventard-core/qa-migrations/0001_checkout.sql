-- Seed/schema EXCLUSIVO del spike sintético; no schema comercial T026/T060.
CREATE TABLE qa_meta(version INTEGER PRIMARY KEY CHECK(version=1),checksum TEXT NOT NULL) STRICT;
CREATE TABLE qa_products(id TEXT PRIMARY KEY,name TEXT NOT NULL,code TEXT NOT NULL UNIQUE,
 price_cents INTEGER NOT NULL CHECK(price_cents>=0),stock INTEGER NOT NULL CHECK(stock BETWEEN 0 AND 2147483647),revision TEXT NOT NULL) STRICT;
CREATE TABLE qa_turn(id INTEGER PRIMARY KEY CHECK(id=1),status TEXT NOT NULL CHECK(status IN('OPEN','CLOSED'))) STRICT;
CREATE TABLE qa_sales(operation_id TEXT PRIMARY KEY REFERENCES operation_journal(operation_id),total_cents INTEGER NOT NULL,ticket TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE qa_sale_lines(operation_id TEXT NOT NULL REFERENCES qa_sales(operation_id),product_id TEXT NOT NULL REFERENCES qa_products(id),quantity INTEGER NOT NULL CHECK(quantity>0),price_cents INTEGER NOT NULL,PRIMARY KEY(operation_id,product_id)) STRICT;
CREATE TABLE qa_stock_movements(operation_id TEXT NOT NULL REFERENCES qa_sales(operation_id),product_id TEXT NOT NULL REFERENCES qa_products(id),delta INTEGER NOT NULL CHECK(delta<0),PRIMARY KEY(operation_id,product_id)) STRICT;
CREATE TABLE qa_payments(operation_id TEXT PRIMARY KEY REFERENCES qa_sales(operation_id),amount_cents INTEGER NOT NULL,tender_cents INTEGER NOT NULL,change_cents INTEGER NOT NULL CHECK(change_cents>=0)) STRICT;
CREATE TABLE qa_cash_entries(operation_id TEXT PRIMARY KEY REFERENCES qa_sales(operation_id),turn_id INTEGER NOT NULL REFERENCES qa_turn(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>=0)) STRICT;
CREATE TABLE qa_outbox(operation_id TEXT PRIMARY KEY REFERENCES qa_sales(operation_id),state TEXT NOT NULL CHECK(state='NOT_ENABLED')) STRICT;
CREATE TABLE qa_print_jobs(operation_id TEXT PRIMARY KEY REFERENCES qa_sales(operation_id),state TEXT NOT NULL CHECK(state='NOT_CONFIGURED'),snapshot TEXT NOT NULL) STRICT;
