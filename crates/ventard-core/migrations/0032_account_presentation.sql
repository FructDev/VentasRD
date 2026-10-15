-- Disposable display metadata. This table never grants access or permissions.
CREATE TABLE IF NOT EXISTS native_account_presentation_v1 (
 tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,
 profile TEXT NOT NULL CHECK(json_valid(profile)),
 PRIMARY KEY(tenant_id,actor_id)
) STRICT;
