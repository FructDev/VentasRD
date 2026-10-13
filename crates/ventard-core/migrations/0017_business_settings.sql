CREATE TABLE IF NOT EXISTS native_business_settings_v1 (
 tenant_id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision>0),
 definition TEXT NOT NULL CHECK(json_valid(definition)),
 operation_id TEXT NOT NULL,
 remote_event TEXT CHECK(remote_event IS NULL OR json_valid(remote_event))
);
CREATE TABLE IF NOT EXISTS native_business_settings_protocol_v1(
 tenant_id TEXT PRIMARY KEY,version TEXT NOT NULL CHECK(version='ventard.business.settings.1')
);
