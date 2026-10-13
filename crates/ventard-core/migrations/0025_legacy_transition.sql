-- Immutable source material and audited reconciliation, separate from live effects.
CREATE TABLE IF NOT EXISTS legacy_cloud_captures_v1 (
 capture_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, context TEXT NOT NULL CHECK(json_valid(context)),
 body_hash TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), captured_at_ms TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS legacy_transition_runs_v1 (
 run_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, context TEXT NOT NULL CHECK(json_valid(context)),
 sources TEXT NOT NULL CHECK(json_valid(sources)), created_at_ms TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, report TEXT NOT NULL CHECK(json_valid(report)),
 history_published INTEGER NOT NULL DEFAULT 0 CHECK(history_published IN(0,1))
) STRICT;
CREATE TABLE IF NOT EXISTS legacy_transition_rows_v1 (
 run_id TEXT NOT NULL REFERENCES legacy_transition_runs_v1(run_id), table_name TEXT NOT NULL, row_id TEXT NOT NULL,
 variants TEXT NOT NULL CHECK(json_valid(variants)), selected TEXT CHECK(selected IS NULL OR json_valid(selected)),
 selected_variant TEXT, excluded INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN(0,1)), PRIMARY KEY(run_id,table_name,row_id)
) STRICT;
CREATE TABLE IF NOT EXISTS legacy_transition_docs_v1 (
 run_id TEXT NOT NULL REFERENCES legacy_transition_runs_v1(run_id), sale_id TEXT NOT NULL,
 variants TEXT NOT NULL CHECK(json_valid(variants)),
 state TEXT NOT NULL CHECK(state IN('CONSENSUS','CONFLICT','CHOSEN')), chosen_source TEXT,
 PRIMARY KEY(run_id,sale_id)
) STRICT;
CREATE TABLE IF NOT EXISTS legacy_transition_decisions_v1 (
 run_id TEXT NOT NULL REFERENCES legacy_transition_runs_v1(run_id), revision INTEGER NOT NULL,
 table_name TEXT NOT NULL, row_id TEXT NOT NULL, variant_id TEXT NOT NULL, actor_id TEXT NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY(run_id,revision)
) STRICT;
CREATE TABLE IF NOT EXISTS legacy_history_active_v1 (
 tenant_id TEXT NOT NULL, scope_key TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES legacy_transition_runs_v1(run_id),
 PRIMARY KEY(tenant_id,scope_key)
) STRICT;
