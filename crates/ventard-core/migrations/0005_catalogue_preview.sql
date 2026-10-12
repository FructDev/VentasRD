-- Read-only catalogue preview. Never an operative stock base or sync receipt.
CREATE TABLE IF NOT EXISTS catalogue_preview_manifests_v1 (
 snapshot_id TEXT PRIMARY KEY,
 context_key TEXT NOT NULL,
 manifest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('DOWNLOADING','COMPLETE'))
) STRICT;
CREATE INDEX IF NOT EXISTS catalogue_preview_context_v1 ON catalogue_preview_manifests_v1(context_key);
CREATE TABLE IF NOT EXISTS catalogue_preview_pages_v1 (
 snapshot_id TEXT NOT NULL REFERENCES catalogue_preview_manifests_v1(snapshot_id),
 page_index INTEGER NOT NULL CHECK(page_index BETWEEN 0 AND 49),
 payload TEXT NOT NULL,
 PRIMARY KEY(snapshot_id,page_index)
) STRICT;
CREATE TABLE IF NOT EXISTS catalogue_preview_active_v1 (
 context_key TEXT PRIMARY KEY,
 snapshot_id TEXT NOT NULL REFERENCES catalogue_preview_manifests_v1(snapshot_id)
) STRICT;
