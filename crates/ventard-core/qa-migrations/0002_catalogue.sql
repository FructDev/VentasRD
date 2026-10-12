-- Adición exclusivamente al vault sintético. No modifica 0001/checksum ni
-- historial, productos existentes, ventas ni schema remoto/comercial.
CREATE TABLE qa_inventory_adjustments (
 operation_id TEXT PRIMARY KEY REFERENCES operation_journal(operation_id),
 product_id TEXT NOT NULL REFERENCES qa_products(id),
 delta INTEGER NOT NULL CHECK(delta BETWEEN -2147483648 AND 2147483647 AND delta<>0),
 stock_before INTEGER NOT NULL CHECK(stock_before BETWEEN 0 AND 2147483647),
 stock_after INTEGER NOT NULL CHECK(stock_after BETWEEN 0 AND 2147483647),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 120),
 CHECK(stock_after=stock_before+delta)
) STRICT;
CREATE INDEX qa_inventory_adjustments_product ON qa_inventory_adjustments(product_id,operation_id);
