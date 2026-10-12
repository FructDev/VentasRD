-- Borradores locales del adaptador aislado. No reserva fiscal, salida remota,
-- autorización comercial ni movimiento de stock al guardar/pausar/retomar.
CREATE TABLE qa_carts (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 revision INTEGER NOT NULL CHECK(revision>0),
 status TEXT NOT NULL CHECK(status IN('ACTIVE','PAUSED','COMMITTED','DISCARDED')),
 lines TEXT NOT NULL CHECK(json_valid(lines)),
 sale_operation_id TEXT REFERENCES operation_journal(operation_id)
) STRICT;
CREATE UNIQUE INDEX qa_one_active_cart ON qa_carts(status) WHERE status='ACTIVE';
CREATE INDEX qa_carts_status_sequence ON qa_carts(status,seq);
CREATE TABLE qa_cart_requests (
 request_id TEXT PRIMARY KEY,
 hash TEXT NOT NULL,
 result TEXT NOT NULL CHECK(json_valid(result))
) STRICT;
