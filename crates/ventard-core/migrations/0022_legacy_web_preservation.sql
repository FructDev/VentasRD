-- Isolated evidence. No operation, stock, cash, NCF or outbox effects.
CREATE TABLE IF NOT EXISTS legacy_web_packages_v1 (
 export_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
 body_hash TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
 summary TEXT NOT NULL CHECK(json_valid(summary)),
 state TEXT NOT NULL CHECK(state='PRESERVED_REVIEW_REQUIRED')
) STRICT;
CREATE INDEX IF NOT EXISTS legacy_web_packages_tenant_v1 ON legacy_web_packages_v1(tenant_id);
CREATE TABLE IF NOT EXISTS legacy_web_tables_v1 (
 export_id TEXT NOT NULL REFERENCES legacy_web_packages_v1(export_id),
 table_name TEXT NOT NULL, row_count INTEGER NOT NULL CHECK(row_count>=0),
 rows_json TEXT NOT NULL CHECK(json_valid(rows_json)), sha256 TEXT NOT NULL,
 PRIMARY KEY(export_id,table_name)
) STRICT;
