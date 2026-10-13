-- Separate durable phases. Existing reports keep their frozen row-only plan.
ALTER TABLE legacy_web_observation_plans_v1 ADD COLUMN source_kind TEXT NOT NULL
 DEFAULT 'LEGACY_ROWS' CHECK(source_kind IN('LEGACY_ROWS','INVENTORY_LEDGER_V2'));
