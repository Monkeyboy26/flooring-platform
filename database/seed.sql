-- Vendors
INSERT INTO vendors (id, name, code, website) VALUES
('550e8400-e29b-41d4-a716-446655440001', 'MSI Surfaces', 'MSI', 'https://www.msisurfaces.com'),
('550e8400-e29b-41d4-a716-446655440002', 'Bedrosians Tile', 'BEDRO', 'https://www.bedrosians.com');

-- Categories: 8 parents + 27 children (full MSI catalog)
INSERT INTO categories (id, parent_id, name, slug, sort_order) VALUES
-- ── Tile ──
('650e8400-e29b-41d4-a716-446655440010', NULL, 'Tile', 'tile', 1),
('650e8400-e29b-41d4-a716-446655440012', '650e8400-e29b-41d4-a716-446655440010', 'Porcelain Tile', 'porcelain-tile', 1),
('650e8400-e29b-41d4-a716-446655440013', '650e8400-e29b-41d4-a716-446655440010', 'Ceramic Tile', 'ceramic-tile', 2),
('650e8400-e29b-41d4-a716-446655440011', '650e8400-e29b-41d4-a716-446655440010', 'Natural Stone', 'natural-stone', 3),
('650e8400-e29b-41d4-a716-446655440015', '650e8400-e29b-41d4-a716-446655440010', 'Wood Look Tile', 'wood-look-tile', 4),
('650e8400-e29b-41d4-a716-446655440016', '650e8400-e29b-41d4-a716-446655440010', 'Large Format Tile', 'large-format-tile', 5),
('650e8400-e29b-41d4-a716-446655440017', '650e8400-e29b-41d4-a716-446655440010', 'Commercial Tile', 'commercial-tile', 6),
-- ── Luxury Vinyl ──
('650e8400-e29b-41d4-a716-446655440030', NULL, 'Luxury Vinyl', 'luxury-vinyl', 2),
('650e8400-e29b-41d4-a716-446655440031', '650e8400-e29b-41d4-a716-446655440030', 'LVP (Plank)', 'lvp-plank', 1),
-- ── Hardwood ──
('650e8400-e29b-41d4-a716-446655440020', NULL, 'Hardwood', 'hardwood', 3),
('650e8400-e29b-41d4-a716-446655440021', '650e8400-e29b-41d4-a716-446655440020', 'Engineered Hardwood', 'engineered-hardwood', 1),
('650e8400-e29b-41d4-a716-446655440022', '650e8400-e29b-41d4-a716-446655440020', 'Solid Hardwood', 'solid-hardwood', 2),
('650e8400-e29b-41d4-a716-446655440023', '650e8400-e29b-41d4-a716-446655440020', 'Waterproof Wood', 'waterproof-wood', 3),
-- ── Countertops ──
('650e8400-e29b-41d4-a716-446655440040', NULL, 'Countertops', 'countertops', 4),
('650e8400-e29b-41d4-a716-446655440041', '650e8400-e29b-41d4-a716-446655440040', 'Quartz Countertops', 'quartz-countertops', 1),
('650e8400-e29b-41d4-a716-446655440042', '650e8400-e29b-41d4-a716-446655440040', 'Granite Countertops', 'granite-countertops', 2),
('650e8400-e29b-41d4-a716-446655440043', '650e8400-e29b-41d4-a716-446655440040', 'Marble Countertops', 'marble-countertops', 3),
('650e8400-e29b-41d4-a716-446655440044', '650e8400-e29b-41d4-a716-446655440040', 'Quartzite Countertops', 'quartzite-countertops', 4),
('650e8400-e29b-41d4-a716-446655440045', '650e8400-e29b-41d4-a716-446655440040', 'Porcelain Slabs', 'porcelain-slabs', 5),
('650e8400-e29b-41d4-a716-446655440046', '650e8400-e29b-41d4-a716-446655440040', 'Prefabricated Countertops', 'prefab-countertops', 6),
('650e8400-e29b-41d4-a716-446655440047', '650e8400-e29b-41d4-a716-446655440040', 'Soapstone Countertops', 'soapstone-countertops', 7),
('650e8400-e29b-41d4-a716-446655440048', '650e8400-e29b-41d4-a716-446655440040', 'Vanity Tops', 'vanity-tops', 8),
-- ── Backsplash & Wall Tile ──
('650e8400-e29b-41d4-a716-446655440050', NULL, 'Backsplash & Wall Tile', 'backsplash-wall', 5),
('650e8400-e29b-41d4-a716-446655440051', '650e8400-e29b-41d4-a716-446655440050', 'Backsplash Tile', 'backsplash-tile', 1),
('650e8400-e29b-41d4-a716-446655440014', '650e8400-e29b-41d4-a716-446655440050', 'Mosaic Tile', 'mosaic-tile', 2),
('650e8400-e29b-41d4-a716-446655440052', '650e8400-e29b-41d4-a716-446655440050', 'Fluted Tile', 'fluted-tile', 3),
-- ── Hardscaping ──
('650e8400-e29b-41d4-a716-446655440060', NULL, 'Hardscaping', 'hardscaping', 6),
('650e8400-e29b-41d4-a716-446655440061', '650e8400-e29b-41d4-a716-446655440060', 'Stacked Stone', 'stacked-stone', 1),
('650e8400-e29b-41d4-a716-446655440062', '650e8400-e29b-41d4-a716-446655440060', 'Pavers', 'pavers', 2),
('650e8400-e29b-41d4-a716-446655440063', '650e8400-e29b-41d4-a716-446655440060', 'Artificial Turf', 'artificial-turf', 3),
-- ── Sinks (future scraper) ──
('650e8400-e29b-41d4-a716-446655440070', NULL, 'Sinks', 'sinks', 7),
('650e8400-e29b-41d4-a716-446655440071', '650e8400-e29b-41d4-a716-446655440070', 'Kitchen Sinks', 'kitchen-sinks', 1),
('650e8400-e29b-41d4-a716-446655440072', '650e8400-e29b-41d4-a716-446655440070', 'Bathroom Sinks', 'bathroom-sinks', 2),
-- ── Faucets (future scraper) ──
('650e8400-e29b-41d4-a716-446655440080', NULL, 'Faucets', 'faucets', 8),
('650e8400-e29b-41d4-a716-446655440081', '650e8400-e29b-41d4-a716-446655440080', 'Kitchen Faucets', 'kitchen-faucets', 1),
('650e8400-e29b-41d4-a716-446655440082', '650e8400-e29b-41d4-a716-446655440080', 'Bathroom Faucets', 'bathroom-faucets', 2);

-- Products: 8 products across categories, both vendors
-- 3 Tile (Natural Stone + Porcelain)
INSERT INTO products (id, vendor_id, name, collection, category_id, status, description_short) VALUES
('a50e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440001',
 'Calacatta Gold Marble', 'Natural Stone Collection', '650e8400-e29b-41d4-a716-446655440011',
 'active', 'Premium Italian marble with gold veining'),
('a50e8400-e29b-41d4-a716-446655440002', '550e8400-e29b-41d4-a716-446655440002',
 'Silver Travertine', 'Vero Collection', '650e8400-e29b-41d4-a716-446655440011',
 'active', 'Classic silver travertine with subtle texture'),
('a50e8400-e29b-41d4-a716-446655440003', '550e8400-e29b-41d4-a716-446655440001',
 'Essentials White Porcelain', 'Essentials Collection', '650e8400-e29b-41d4-a716-446655440012',
 'active', 'Clean white porcelain tile for modern spaces'),

-- 3 Hardwood (2 Engineered + 1 Solid)
('a50e8400-e29b-41d4-a716-446655440004', '550e8400-e29b-41d4-a716-446655440001',
 'French Oak Blanc', 'Ladson Collection', '650e8400-e29b-41d4-a716-446655440021',
 'active', 'Light wire-brushed engineered French oak'),
('a50e8400-e29b-41d4-a716-446655440005', '550e8400-e29b-41d4-a716-446655440002',
 'Hickory Saddle', 'Traditions Collection', '650e8400-e29b-41d4-a716-446655440021',
 'active', 'Rich hickory with hand-scraped texture'),
('a50e8400-e29b-41d4-a716-446655440006', '550e8400-e29b-41d4-a716-446655440001',
 'Red Oak Natural', 'Solid Hardwood Collection', '650e8400-e29b-41d4-a716-446655440022',
 'active', 'Classic 3/4" solid red oak strip flooring'),

-- 2 Luxury Vinyl
('a50e8400-e29b-41d4-a716-446655440007', '550e8400-e29b-41d4-a716-446655440001',
 'Woodland Hickory LVP', 'Cyrus Collection', '650e8400-e29b-41d4-a716-446655440031',
 'active', 'Waterproof luxury vinyl plank with attached pad'),
('a50e8400-e29b-41d4-a716-446655440008', '550e8400-e29b-41d4-a716-446655440002',
 'Coastal Oak LVP', 'Prescott Collection', '650e8400-e29b-41d4-a716-446655440031',
 'active', 'Realistic oak grain waterproof vinyl plank');

-- SKUs: 1 per product
INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status) VALUES
('b50e8400-e29b-41d4-a716-446655440001', 'a50e8400-e29b-41d4-a716-446655440001',
 'MSI-CALG-1212-POL', 'CAL-GOLD-12X12-P', '12x12 Polished', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440002', 'a50e8400-e29b-41d4-a716-446655440002',
 'BED-STVR-1824-HN', 'SIL-TRAV-18X24-H', '18x24 Honed', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440003', 'a50e8400-e29b-41d4-a716-446655440003',
 'MSI-EWHT-2424-MAT', 'ESS-WHT-24X24-M', '24x24 Matte', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440004', 'a50e8400-e29b-41d4-a716-446655440004',
 'MSI-LBFK-758-WB', 'FOK-BLANC-7X58-W', '7.5x58 Wire-Brushed', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440005', 'a50e8400-e29b-41d4-a716-446655440005',
 'BED-HKSD-5IN-HS', 'HIK-SADDLE-5-HS', '5" Hand-Scraped', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440006', 'a50e8400-e29b-41d4-a716-446655440006',
 'MSI-ROKN-225-NAT', 'ROK-NAT-225-N', '2.25" Natural', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440007', 'a50e8400-e29b-41d4-a716-446655440007',
 'MSI-WDHK-7X48-CY', 'WDH-LVP-7X48-C', '7x48 Click-Lock', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440008', 'a50e8400-e29b-41d4-a716-446655440008',
 'BED-COOK-7X48-PR', 'COK-LVP-7X48-P', '7x48 Click-Lock', 'sqft', 'active');

-- Packaging: 1 per SKU
INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs) VALUES
('b50e8400-e29b-41d4-a716-446655440001', 10.00, 10, 55.00),
('b50e8400-e29b-41d4-a716-446655440002', 12.00, 4, 72.00),
('b50e8400-e29b-41d4-a716-446655440003', 16.00, 4, 58.00),
('b50e8400-e29b-41d4-a716-446655440004', 23.31, 7, 44.00),
('b50e8400-e29b-41d4-a716-446655440005', 22.00, 9, 48.00),
('b50e8400-e29b-41d4-a716-446655440006', 20.00, 40, 50.00),
('b50e8400-e29b-41d4-a716-446655440007', 23.77, 10, 38.00),
('b50e8400-e29b-41d4-a716-446655440008', 23.77, 10, 36.00);

-- Pricing: 1 per SKU
INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES
('b50e8400-e29b-41d4-a716-446655440001', 8.50, 15.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440002', 5.25, 9.49, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440003', 2.10, 4.29, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440004', 4.75, 8.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440005', 5.50, 10.49, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440006', 3.80, 6.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440007', 2.15, 4.19, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440008', 1.85, 3.79, 'per_sqft');

-- Attributes: 4 filterable attribute types
INSERT INTO attributes (id, name, slug, display_order) VALUES
('d50e8400-e29b-41d4-a716-446655440001', 'Color', 'color', 1),
('d50e8400-e29b-41d4-a716-446655440002', 'Material', 'material', 2),
('d50e8400-e29b-41d4-a716-446655440003', 'Finish', 'finish', 3),
('d50e8400-e29b-41d4-a716-446655440004', 'Size', 'size', 4);

-- SKU Attributes: values per product SKU
INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES
-- Calacatta Gold Marble
('b50e8400-e29b-41d4-a716-446655440001', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440001', 'd50e8400-e29b-41d4-a716-446655440002', 'Marble'),
('b50e8400-e29b-41d4-a716-446655440001', 'd50e8400-e29b-41d4-a716-446655440003', 'Polished'),
('b50e8400-e29b-41d4-a716-446655440001', 'd50e8400-e29b-41d4-a716-446655440004', '12x12'),
-- Silver Travertine
('b50e8400-e29b-41d4-a716-446655440002', 'd50e8400-e29b-41d4-a716-446655440001', 'Gray'),
('b50e8400-e29b-41d4-a716-446655440002', 'd50e8400-e29b-41d4-a716-446655440002', 'Travertine'),
('b50e8400-e29b-41d4-a716-446655440002', 'd50e8400-e29b-41d4-a716-446655440003', 'Honed'),
('b50e8400-e29b-41d4-a716-446655440002', 'd50e8400-e29b-41d4-a716-446655440004', '18x24'),
-- Essentials White Porcelain
('b50e8400-e29b-41d4-a716-446655440003', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440003', 'd50e8400-e29b-41d4-a716-446655440002', 'Porcelain'),
('b50e8400-e29b-41d4-a716-446655440003', 'd50e8400-e29b-41d4-a716-446655440003', 'Matte'),
('b50e8400-e29b-41d4-a716-446655440003', 'd50e8400-e29b-41d4-a716-446655440004', '24x24'),
-- French Oak Blanc
('b50e8400-e29b-41d4-a716-446655440004', 'd50e8400-e29b-41d4-a716-446655440001', 'Natural'),
('b50e8400-e29b-41d4-a716-446655440004', 'd50e8400-e29b-41d4-a716-446655440002', 'Oak'),
('b50e8400-e29b-41d4-a716-446655440004', 'd50e8400-e29b-41d4-a716-446655440003', 'Wire-Brushed'),
('b50e8400-e29b-41d4-a716-446655440004', 'd50e8400-e29b-41d4-a716-446655440004', '7.5x58'),
-- Hickory Saddle
('b50e8400-e29b-41d4-a716-446655440005', 'd50e8400-e29b-41d4-a716-446655440001', 'Brown'),
('b50e8400-e29b-41d4-a716-446655440005', 'd50e8400-e29b-41d4-a716-446655440002', 'Hickory'),
('b50e8400-e29b-41d4-a716-446655440005', 'd50e8400-e29b-41d4-a716-446655440003', 'Hand-Scraped'),
('b50e8400-e29b-41d4-a716-446655440005', 'd50e8400-e29b-41d4-a716-446655440004', '5 in'),
-- Red Oak Natural
('b50e8400-e29b-41d4-a716-446655440006', 'd50e8400-e29b-41d4-a716-446655440001', 'Natural'),
('b50e8400-e29b-41d4-a716-446655440006', 'd50e8400-e29b-41d4-a716-446655440002', 'Oak'),
('b50e8400-e29b-41d4-a716-446655440006', 'd50e8400-e29b-41d4-a716-446655440003', 'Natural'),
('b50e8400-e29b-41d4-a716-446655440006', 'd50e8400-e29b-41d4-a716-446655440004', '2.25 in'),
-- Woodland Hickory LVP
('b50e8400-e29b-41d4-a716-446655440007', 'd50e8400-e29b-41d4-a716-446655440001', 'Brown'),
('b50e8400-e29b-41d4-a716-446655440007', 'd50e8400-e29b-41d4-a716-446655440002', 'Vinyl'),
('b50e8400-e29b-41d4-a716-446655440007', 'd50e8400-e29b-41d4-a716-446655440003', 'Embossed'),
('b50e8400-e29b-41d4-a716-446655440007', 'd50e8400-e29b-41d4-a716-446655440004', '7x48'),
-- Coastal Oak LVP
('b50e8400-e29b-41d4-a716-446655440008', 'd50e8400-e29b-41d4-a716-446655440001', 'Gray'),
('b50e8400-e29b-41d4-a716-446655440008', 'd50e8400-e29b-41d4-a716-446655440002', 'Vinyl'),
('b50e8400-e29b-41d4-a716-446655440008', 'd50e8400-e29b-41d4-a716-446655440003', 'Embossed'),
('b50e8400-e29b-41d4-a716-446655440008', 'd50e8400-e29b-41d4-a716-446655440004', '7x48');

-- Inventory Snapshots: varied stock levels for demo
INSERT INTO inventory_snapshots (sku_id, warehouse, qty_on_hand, qty_in_transit, fresh_until) VALUES
-- In Stock (qty > 10)
('b50e8400-e29b-41d4-a716-446655440001', 'default', 48, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440003', 'default', 120, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440006', 'default', 35, 0, NOW() + INTERVAL '24 hours'),
-- Low Stock (qty 1-10)
('b50e8400-e29b-41d4-a716-446655440002', 'default', 6, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440005', 'default', 3, 0, NOW() + INTERVAL '24 hours'),
-- Out of Stock (qty = 0) — SKU 4 has transit stock
('b50e8400-e29b-41d4-a716-446655440004', 'default', 0, 15, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440008', 'default', 0, 0, NOW() + INTERVAL '24 hours'),
-- Stale snapshot (fresh_until in past) — tests "unknown" path
('b50e8400-e29b-41d4-a716-446655440007', 'default', 50, 0, NOW() - INTERVAL '2 hours');

-- Margin Tiers for Trade Pricing
INSERT INTO margin_tiers (name, discount_percent, spend_threshold, tier_level) VALUES
('Silver', 10.00, 0, 0),
('Gold', 15.00, 12500, 1),
('Platinum', 20.00, 25000, 2);
