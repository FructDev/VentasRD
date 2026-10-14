CREATE TABLE IF NOT EXISTS native_product_media_cache_v1 (
 tenant_id TEXT NOT NULL,product_id TEXT NOT NULL REFERENCES products(producto_id),
 source TEXT NOT NULL,data TEXT NOT NULL,sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 PRIMARY KEY(tenant_id,product_id)
) STRICT;
