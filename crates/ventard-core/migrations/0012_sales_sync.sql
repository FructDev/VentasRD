-- Operational evidence is separate from readonly catalogue previews.
CREATE TABLE IF NOT EXISTS native_sales_bootstrap_v1(
 context_key TEXT PRIMARY KEY,manifest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('DOWNLOADING','ACTIVE'))
) STRICT;
CREATE TABLE IF NOT EXISTS native_sales_pages_v1(
 context_key TEXT NOT NULL REFERENCES native_sales_bootstrap_v1(context_key),page_index INTEGER NOT NULL,payload TEXT NOT NULL,
 PRIMARY KEY(context_key,page_index)
) STRICT;
CREATE TABLE IF NOT EXISTS native_sales_cursor_v1(
 tenant_id TEXT NOT NULL,scope_key TEXT NOT NULL REFERENCES scopes(scope_key),namespace TEXT NOT NULL CHECK(namespace='NATIVE1'),
 sequence INTEGER NOT NULL CHECK(sequence>=0),PRIMARY KEY(tenant_id,scope_key)
) STRICT;
CREATE TABLE IF NOT EXISTS native_sales_receipts_v1(
 operation_id TEXT PRIMARY KEY REFERENCES operation_journal(operation_id),tenant_id TEXT NOT NULL,scope_key TEXT NOT NULL,
 remote_sequence INTEGER NOT NULL CHECK(remote_sequence>0),receipt TEXT NOT NULL,UNIQUE(tenant_id,remote_sequence)
) STRICT;
CREATE TABLE IF NOT EXISTS native_sales_failures_v1(
 operation_id TEXT PRIMARY KEY REFERENCES outbox(operation_id),code TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS native_sales_customer_pricing_v1(
 customer_id TEXT PRIMARY KEY REFERENCES sale_customer_accounts_v1(customer_id),tenant_id TEXT NOT NULL,
 tier INTEGER NOT NULL CHECK(tier IN(1,2,3))
) STRICT;
