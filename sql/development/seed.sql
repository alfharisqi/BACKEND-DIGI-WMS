-- Synthetic sample. The launcher records its successful transaction and never replays it on restart.
INSERT INTO products (sku,name,category,unit_price,min_stock_threshold,current_stock) VALUES
  ('DEV-CABLE-01','Kabel Data Development','Elektronik',25000,1,2),
  ('DEV-MOUSE-01','Mouse Development','Elektronik',75000,0,1);
INSERT INTO locations (code,zone_code,name,location_type) VALUES
  ('DEV-A01','A1','Rak Development A01','RACK'),
  ('DEV-B01','B1','Rak Development B01','RACK'),
  ('DEV-PACK','PK','Meja Packing Development','PACKING_STATION');
INSERT INTO goods_receipts (po_number,supplier_name,total_qty,status) VALUES
  ('DEV-GRN-001','Pemasok Sintetis Development',3,'SELESAI');
INSERT INTO tags (epc,status) VALUES
  ('D00100000000000000000001','IN_STOCK'),
  ('D00100000000000000000002','IN_STOCK'),
  ('D00100000000000000000003','IN_STOCK'),
  ('D00100000000000000000004','ENCODED');
INSERT INTO items(tag_id,product_id,location_id,grn_id,status)
SELECT t.id,p.id,l.id,g.id,v.status
FROM (VALUES
  ('D00100000000000000000001','DEV-CABLE-01','DEV-A01','IN_STOCK'),
  ('D00100000000000000000002','DEV-CABLE-01','DEV-B01','IN_STOCK'),
  ('D00100000000000000000003','DEV-MOUSE-01','DEV-A01','IN_STOCK'),
  ('D00100000000000000000004','DEV-MOUSE-01',NULL,'ENCODED')) v(epc,sku,rack,status)
JOIN tags t ON t.epc=v.epc JOIN products p ON p.sku=v.sku
LEFT JOIN locations l ON l.code=v.rack JOIN goods_receipts g ON g.po_number='DEV-GRN-001';
INSERT INTO stock_movements(tx_code,movement_type,product_id,sku,tag_id,from_location,to_location,qty_change,qty_label,reference_doc,to_location_id)
SELECT 'DEV-SEED-'||right(t.epc,2),'PUTAWAY',p.id,p.sku,t.id,'Inbound Development',l.code,1,'1 unit','DEV-GRN-001',l.id
FROM items i JOIN tags t ON t.id=i.tag_id JOIN products p ON p.id=i.product_id JOIN locations l ON l.id=i.location_id
WHERE t.epc LIKE 'D0010000000000000000000_';
INSERT INTO picking_orders(order_number) VALUES ('DEV-PICK-001');
INSERT INTO picking_order_lines(order_id,product_id,requested_qty)
SELECT o.id,p.id,2 FROM picking_orders o JOIN products p ON p.sku='DEV-CABLE-01' WHERE o.order_number='DEV-PICK-001';
