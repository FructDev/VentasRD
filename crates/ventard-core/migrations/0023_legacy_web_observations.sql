-- Read-only migration evidence, independent of all operational journals.
CREATE TABLE IF NOT EXISTS legacy_web_reconciliations_v1 (
 report_id TEXT PRIMARY KEY, export_id TEXT NOT NULL REFERENCES legacy_web_packages_v1(export_id),
 tenant_id TEXT NOT NULL, context TEXT NOT NULL CHECK(json_valid(context)),
 source_hash TEXT NOT NULL, created_at_ms TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('PENDING','PENDING_ERROR','REVIEW_REQUIRED')),
 last_error TEXT, total_batches INTEGER NOT NULL CHECK(total_batches>=0)
) STRICT;
CREATE INDEX IF NOT EXISTS legacy_web_reconciliation_source_v1 ON legacy_web_reconciliations_v1(tenant_id,export_id);
CREATE UNIQUE INDEX IF NOT EXISTS legacy_web_reconciliation_pending_v1 ON legacy_web_reconciliations_v1(tenant_id,export_id,context) WHERE state IN('PENDING','PENDING_ERROR');
CREATE TABLE IF NOT EXISTS legacy_web_observation_plans_v1 (
 report_id TEXT NOT NULL REFERENCES legacy_web_reconciliations_v1(report_id),
 batch_index INTEGER NOT NULL CHECK(batch_index>=0), table_name TEXT NOT NULL,
 observation_id TEXT NOT NULL, ids TEXT NOT NULL CHECK(json_valid(ids)),
 local_rows TEXT NOT NULL CHECK(json_valid(local_rows)),
 PRIMARY KEY(report_id,batch_index)
) STRICT;
CREATE TABLE IF NOT EXISTS legacy_web_observations_v1 (
 report_id TEXT NOT NULL, batch_index INTEGER NOT NULL,
 response_hash TEXT NOT NULL, response TEXT NOT NULL CHECK(json_valid(response)),
 captured_at_ms TEXT NOT NULL,
 PRIMARY KEY(report_id,batch_index),
 FOREIGN KEY(report_id,batch_index) REFERENCES legacy_web_observation_plans_v1(report_id,batch_index)
) STRICT;
CREATE TABLE IF NOT EXISTS legacy_web_comparisons_v1 (
 report_id TEXT NOT NULL REFERENCES legacy_web_reconciliations_v1(report_id),
 table_name TEXT NOT NULL, row_id TEXT NOT NULL, status TEXT NOT NULL,
 result TEXT NOT NULL CHECK(json_valid(result)),
 PRIMARY KEY(report_id,table_name,row_id)
) STRICT;
