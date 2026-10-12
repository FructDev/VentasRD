-- 0001_core.sql
-- Migración inicial del core de Ventard POS Nativo.
-- PRAGMAS esenciales (deben activarse por conexión en Rust, aquí se asumen o declaran explícitamente en el setup)
-- PRAGMA foreign_keys = ON;
-- PRAGMA journal_mode = WAL;
-- PRAGMA synchronous = FULL;

-- Metadatos del vault
CREATE TABLE IF NOT EXISTS vault_meta (
    vault_id TEXT PRIMARY KEY,
    negocio_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    build_origin TEXT NOT NULL,
    crypto_version TEXT NOT NULL,
    activation_state TEXT NOT NULL CHECK (activation_state IN ('IMPORTING', 'VERIFIED', 'ACTIVE', 'QUARANTINED', 'READ_ONLY', 'SHADOW', 'PAUSED')),
    local_seq INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Instalaciones e identidad del dispositivo
CREATE TABLE IF NOT EXISTS installations (
    installation_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    writer_epoch INTEGER NOT NULL,
    ticket_prefix TEXT NOT NULL,
    registered_at TEXT NOT NULL, -- UTC epoch-ms integer represented as string
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'PENDING_REPLACE'))
) STRICT;

-- Scopes/Sucursales
CREATE TABLE IF NOT EXISTS scopes (
    scope_key TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('GLOBAL', 'BRANCH', 'UNKNOWN_LEGACY')),
    sucursal_id TEXT,
    negocio_id TEXT NOT NULL
) STRICT;

-- Actores y permisos offline
CREATE TABLE IF NOT EXISTS offline_grants (
    actor_id TEXT PRIMARY KEY,
    roles TEXT NOT NULL, -- JSON array
    capabilities TEXT NOT NULL, -- JSON array
    grant_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT,
    signature TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PROVISIONED', 'VALID', 'EXPIRED', 'REVOKED', 'UNVERIFIABLE'))
) STRICT;

-- Journal de operaciones
CREATE TABLE IF NOT EXISTS operation_journal (
    operation_id TEXT PRIMARY KEY,
    protocol TEXT NOT NULL,
    kind TEXT NOT NULL,
    version INTEGER NOT NULL,
    canonical_bytes BLOB NOT NULL,
    hash TEXT NOT NULL,
    origin_actor TEXT NOT NULL,
    origin_scope TEXT NOT NULL,
    origin_device TEXT NOT NULL,
    origin_epoch INTEGER NOT NULL,
    prepared_at TEXT NOT NULL,
    local_seq INTEGER NOT NULL UNIQUE,
    local_state TEXT NOT NULL CHECK (local_state IN ('PREPARED', 'COMMITTED', 'ABANDONED')),
    result TEXT -- JSON
) STRICT;

-- Ventas consolidadas
CREATE TABLE IF NOT EXISTS sales (
    sale_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE REFERENCES operation_journal(operation_id),
    tenant_id TEXT NOT NULL,
    scope_key TEXT NOT NULL REFERENCES scopes(scope_key),
    turn_id TEXT NOT NULL,
    ticket TEXT NOT NULL,
    ncf TEXT,
    actor_id TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL,
    discount_cents INTEGER NOT NULL,
    calculation_version TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

-- Líneas de venta
CREATE TABLE IF NOT EXISTS sale_lines (
    line_id TEXT PRIMARY KEY,
    sale_id TEXT NOT NULL REFERENCES sales(sale_id),
    producto_id TEXT,
    nombre TEXT NOT NULL,
    precio_cents INTEGER NOT NULL,
    tasa_percent TEXT NOT NULL, -- exact ratio
    receta_ratio TEXT,
    costo_cents INTEGER NOT NULL,
    cantidad TEXT NOT NULL, -- ratio exacto
    serial TEXT
) STRICT;

-- Pagos/Tenders
CREATE TABLE IF NOT EXISTS payments (
    payment_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES operation_journal(operation_id),
    sale_id TEXT REFERENCES sales(sale_id),
    service_id TEXT,
    method TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    tender_cents INTEGER NOT NULL,
    change_cents INTEGER NOT NULL,
    turn_id TEXT NOT NULL
) STRICT;

-- Catálogo
CREATE TABLE IF NOT EXISTS products (
    producto_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    sku TEXT,
    barcode TEXT,
    name TEXT NOT NULL,
    price_tiers TEXT NOT NULL, -- JSON
    metadata TEXT NOT NULL, -- JSON
    tombstone INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Movimientos de inventario
CREATE TABLE IF NOT EXISTS inventory_movements (
    effect_id TEXT PRIMARY KEY,
    owner_operation_id TEXT NOT NULL REFERENCES operation_journal(operation_id),
    producto_id TEXT NOT NULL REFERENCES products(producto_id),
    scope_key TEXT NOT NULL REFERENCES scopes(scope_key),
    kind TEXT NOT NULL,
    delta_qty TEXT NOT NULL,
    absolute_qty TEXT,
    base_seq INTEGER,
    receipt_ref TEXT
) STRICT;

-- Proyecciones de stock
CREATE TABLE IF NOT EXISTS stock_projections (
    producto_id TEXT NOT NULL REFERENCES products(producto_id),
    scope_key TEXT NOT NULL REFERENCES scopes(scope_key),
    remote_base_qty TEXT NOT NULL,
    remote_seq INTEGER NOT NULL,
    pending_coverage TEXT NOT NULL,
    effective_stock TEXT NOT NULL,
    authority_state TEXT NOT NULL CHECK (authority_state IN ('VERIFIED', 'UNKNOWN', 'OVERRIDDEN')),
    PRIMARY KEY (producto_id, scope_key)
) STRICT;

-- Outbox / Sync
CREATE TABLE IF NOT EXISTS outbox (
    operation_id TEXT PRIMARY KEY REFERENCES operation_journal(operation_id),
    envelope BLOB NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'IN_FLIGHT', 'APPLIED', 'RETRYABLE_ERROR', 'CONFLICT', 'INTERVENTION')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0,
    claim_id TEXT,
    lease_expires INTEGER
) STRICT;

-- Archivo legacy
-- Sin restricciones STRICT o FK fuertes para tolerar historias rotas o incompletas
CREATE TABLE IF NOT EXISTS legacy_archive (
    import_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    table_name TEXT NOT NULL,
    raw_row TEXT NOT NULL, -- JSON
    checksum TEXT NOT NULL,
    provenance TEXT NOT NULL,
    findings TEXT, -- JSON anomalías detectadas
    checkpoint INTEGER NOT NULL,
    PRIMARY KEY (import_id, origin, table_name, checksum)
);

-- Índices de rendimiento
CREATE INDEX IF NOT EXISTS idx_sales_scope_time ON sales(scope_key, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_state_next ON outbox(state, next_attempt);
CREATE INDEX IF NOT EXISTS idx_inventory_product_scope ON inventory_movements(producto_id, scope_key);
CREATE INDEX IF NOT EXISTS idx_journal_local_seq ON operation_journal(local_seq);
