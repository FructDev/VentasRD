CREATE TABLE IF NOT EXISTS legacy_cutovers_v1 (
 cutover_id TEXT PRIMARY KEY, context TEXT NOT NULL CHECK(json_valid(context)),
 run_id TEXT NOT NULL REFERENCES legacy_transition_runs_v1(run_id),
 input TEXT NOT NULL CHECK(json_valid(input)), intent TEXT NOT NULL CHECK(json_valid(intent)), intent_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('UNKNOWN','ADOPTED','ACTIVE','ABANDONED')),
 receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)), created_at_ms TEXT NOT NULL,
 CHECK((state='UNKNOWN' AND receipt IS NULL) OR (state IN('ADOPTED','ACTIVE','ABANDONED') AND receipt IS NOT NULL))
) STRICT;
