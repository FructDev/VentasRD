-- Preserve every serial and owner. LOST units remain auditable and cannot sell.
CREATE TABLE IF NOT EXISTS sale_serial_inventory_v2 (
 tenant_id TEXT NOT NULL,scope_key TEXT NOT NULL REFERENCES scopes(scope_key),producto_id TEXT NOT NULL REFERENCES products(producto_id),
 serial TEXT NOT NULL,revision TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('AVAILABLE','RESERVED','SOLD','LOST')),
 sale_operation_id TEXT REFERENCES operation_journal(operation_id),PRIMARY KEY(tenant_id,scope_key,serial)
) STRICT;
INSERT INTO sale_serial_inventory_v2 SELECT * FROM sale_serial_inventory_v1;
DROP TABLE sale_serial_inventory_v1;
ALTER TABLE sale_serial_inventory_v2 RENAME TO sale_serial_inventory_v1;
