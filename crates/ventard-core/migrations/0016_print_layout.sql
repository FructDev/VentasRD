-- Device-local print presentation. No commercial facts or previous hashes change.
CREATE TABLE IF NOT EXISTS native_print_layout_v1 (
 tenant_id TEXT NOT NULL,installation_id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),
 PRIMARY KEY(tenant_id,installation_id)
) STRICT;