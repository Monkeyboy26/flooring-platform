-- Vendors
INSERT INTO vendors (id, name, code, website) VALUES
('550e8400-e29b-41d4-a716-446655440001', 'MSI Surfaces', 'MSI', 'https://www.msisurfaces.com'),
('550e8400-e29b-41d4-a716-446655440002', 'Bedrosians Tile', 'BEDRO', 'https://www.bedrosians.com'),
('550e8400-e29b-41d4-a716-446655440003', 'Daltile', 'DAL', 'https://www.daltile.com'),
('550e8400-e29b-41d4-a716-446655440004', 'American Olean', 'AO', 'https://www.americanolean.com'),
('550e8400-e29b-41d4-a716-446655440005', 'Marazzi', 'MZ', 'https://www.marazziusa.com'),
('550e8400-e29b-41d4-a716-446655440006', 'Elysium Tile', 'ELY', 'http://elysiumtile.com'),
('550e8400-e29b-41d4-a716-446655440007', 'Arizona Tile', 'AZT', 'https://www.arizonatile.com'),
('550e8400-e29b-41d4-a716-446655440008', 'Tri-West', 'TW', 'https://www.triwestltd.com')
ON CONFLICT DO NOTHING;

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
('650e8400-e29b-41d4-a716-446655440082', '650e8400-e29b-41d4-a716-446655440080', 'Bathroom Faucets', 'bathroom-faucets', 2),
-- ── Laminate ──
('650e8400-e29b-41d4-a716-446655440090', NULL, 'Laminate', 'laminate', 9),
-- ── Carpet Tile ──
('650e8400-e29b-41d4-a716-446655440100', NULL, 'Carpet Tile', 'carpet-tile', 10),
-- ── Installation & Sundries ──
('650e8400-e29b-41d4-a716-446655440110', NULL, 'Installation & Sundries', 'installation-sundries', 11),
('650e8400-e29b-41d4-a716-446655440111', '650e8400-e29b-41d4-a716-446655440110', 'Adhesives & Sealants', 'adhesives-sealants', 1),
('650e8400-e29b-41d4-a716-446655440112', '650e8400-e29b-41d4-a716-446655440110', 'Underlayment', 'underlayment', 2),
('650e8400-e29b-41d4-a716-446655440113', '650e8400-e29b-41d4-a716-446655440110', 'Surface Prep & Levelers', 'surface-prep-levelers', 3),
('650e8400-e29b-41d4-a716-446655440114', '650e8400-e29b-41d4-a716-446655440110', 'Transitions & Moldings', 'transitions-moldings', 4),
('650e8400-e29b-41d4-a716-446655440115', '650e8400-e29b-41d4-a716-446655440110', 'Wall Base', 'wall-base', 5),
('650e8400-e29b-41d4-a716-446655440116', '650e8400-e29b-41d4-a716-446655440110', 'Rubber Flooring', 'rubber-flooring', 6),
('650e8400-e29b-41d4-a716-446655440117', '650e8400-e29b-41d4-a716-446655440110', 'Stair Treads & Nosing', 'stair-treads-nosing', 7),
('650e8400-e29b-41d4-a716-446655440118', '650e8400-e29b-41d4-a716-446655440110', 'Tools & Trowels', 'tools-trowels', 8);

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
('d50e8400-e29b-41d4-a716-446655440004', 'Size', 'size', 4),
('d50e8400-e29b-41d4-a716-446655440005', 'Shape', 'shape', 5),
('d50e8400-e29b-41d4-a716-446655440006', 'Country of Origin', 'country', 6),
('d50e8400-e29b-41d4-a716-446655440007', 'Shade Variation', 'shade_variation', 7),
('d50e8400-e29b-41d4-a716-446655440008', 'PEI Rating', 'pei_rating', 8),
('d50e8400-e29b-41d4-a716-446655440009', 'Application', 'application', 9),
('d50e8400-e29b-41d4-a716-446655440010', 'Thickness', 'thickness', 10),
('d50e8400-e29b-41d4-a716-446655440011', 'Edge', 'edge', 11),
('d50e8400-e29b-41d4-a716-446655440012', 'Look', 'look', 12),
('d50e8400-e29b-41d4-a716-446655440013', 'Water Absorption', 'water_absorption', 13),
('d50e8400-e29b-41d4-a716-446655440014', 'DCOF', 'dcof', 14)
ON CONFLICT DO NOTHING;

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

-- ==================== Additional SKU Variants ====================
-- Add 2-3 extra SKUs per product so siblings navigation works

-- Calacatta Gold: 18x18 Polished, 24x24 Honed
INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status) VALUES
('b50e8400-e29b-41d4-a716-446655440011', 'a50e8400-e29b-41d4-a716-446655440001',
 'MSI-CALG-1818-POL', 'CAL-GOLD-18X18-P', '18x18 Polished', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440012', 'a50e8400-e29b-41d4-a716-446655440001',
 'MSI-CALG-2424-HON', 'CAL-GOLD-24X24-H', '24x24 Honed', 'sqft', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs) VALUES
('b50e8400-e29b-41d4-a716-446655440011', 13.50, 6, 68.00),
('b50e8400-e29b-41d4-a716-446655440012', 16.00, 4, 82.00)
ON CONFLICT DO NOTHING;

INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES
('b50e8400-e29b-41d4-a716-446655440011', 9.25, 17.49, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440012', 10.50, 19.99, 'per_sqft')
ON CONFLICT DO NOTHING;

INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES
('b50e8400-e29b-41d4-a716-446655440011', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440011', 'd50e8400-e29b-41d4-a716-446655440002', 'Marble'),
('b50e8400-e29b-41d4-a716-446655440011', 'd50e8400-e29b-41d4-a716-446655440003', 'Polished'),
('b50e8400-e29b-41d4-a716-446655440011', 'd50e8400-e29b-41d4-a716-446655440004', '18x18'),
('b50e8400-e29b-41d4-a716-446655440012', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440012', 'd50e8400-e29b-41d4-a716-446655440002', 'Marble'),
('b50e8400-e29b-41d4-a716-446655440012', 'd50e8400-e29b-41d4-a716-446655440003', 'Honed'),
('b50e8400-e29b-41d4-a716-446655440012', 'd50e8400-e29b-41d4-a716-446655440004', '24x24')
ON CONFLICT DO NOTHING;

INSERT INTO inventory_snapshots (sku_id, warehouse, qty_on_hand, qty_in_transit, fresh_until) VALUES
('b50e8400-e29b-41d4-a716-446655440011', 'default', 32, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440012', 'default', 8, 0, NOW() + INTERVAL '24 hours')
ON CONFLICT DO NOTHING;

-- Silver Travertine: 12x24 Tumbled
INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status) VALUES
('b50e8400-e29b-41d4-a716-446655440013', 'a50e8400-e29b-41d4-a716-446655440002',
 'BED-STVR-1224-TUM', 'SIL-TRAV-12X24-T', '12x24 Tumbled', 'sqft', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs) VALUES
('b50e8400-e29b-41d4-a716-446655440013', 10.00, 5, 60.00)
ON CONFLICT DO NOTHING;

INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES
('b50e8400-e29b-41d4-a716-446655440013', 4.75, 8.99, 'per_sqft')
ON CONFLICT DO NOTHING;

INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES
('b50e8400-e29b-41d4-a716-446655440013', 'd50e8400-e29b-41d4-a716-446655440001', 'Gray'),
('b50e8400-e29b-41d4-a716-446655440013', 'd50e8400-e29b-41d4-a716-446655440002', 'Travertine'),
('b50e8400-e29b-41d4-a716-446655440013', 'd50e8400-e29b-41d4-a716-446655440003', 'Tumbled'),
('b50e8400-e29b-41d4-a716-446655440013', 'd50e8400-e29b-41d4-a716-446655440004', '12x24')
ON CONFLICT DO NOTHING;

INSERT INTO inventory_snapshots (sku_id, warehouse, qty_on_hand, qty_in_transit, fresh_until) VALUES
('b50e8400-e29b-41d4-a716-446655440013', 'default', 15, 0, NOW() + INTERVAL '24 hours')
ON CONFLICT DO NOTHING;

-- Essentials White Porcelain: 12x24 Matte
INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status) VALUES
('b50e8400-e29b-41d4-a716-446655440014', 'a50e8400-e29b-41d4-a716-446655440003',
 'MSI-EWHT-1224-MAT', 'ESS-WHT-12X24-M', '12x24 Matte', 'sqft', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs) VALUES
('b50e8400-e29b-41d4-a716-446655440014', 12.00, 6, 48.00)
ON CONFLICT DO NOTHING;

INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES
('b50e8400-e29b-41d4-a716-446655440014', 1.95, 3.99, 'per_sqft')
ON CONFLICT DO NOTHING;

INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES
('b50e8400-e29b-41d4-a716-446655440014', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440014', 'd50e8400-e29b-41d4-a716-446655440002', 'Porcelain'),
('b50e8400-e29b-41d4-a716-446655440014', 'd50e8400-e29b-41d4-a716-446655440003', 'Matte'),
('b50e8400-e29b-41d4-a716-446655440014', 'd50e8400-e29b-41d4-a716-446655440004', '12x24')
ON CONFLICT DO NOTHING;

INSERT INTO inventory_snapshots (sku_id, warehouse, qty_on_hand, qty_in_transit, fresh_until) VALUES
('b50e8400-e29b-41d4-a716-446655440014', 'default', 200, 0, NOW() + INTERVAL '24 hours')
ON CONFLICT DO NOTHING;

-- French Oak: 7.5x75 Wire-Brushed (longer plank)
INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status) VALUES
('b50e8400-e29b-41d4-a716-446655440015', 'a50e8400-e29b-41d4-a716-446655440004',
 'MSI-LBFK-775-WB', 'FOK-BLANC-75X75-W', '7.5x75 Wire-Brushed', 'sqft', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs) VALUES
('b50e8400-e29b-41d4-a716-446655440015', 27.15, 7, 52.00)
ON CONFLICT DO NOTHING;

INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES
('b50e8400-e29b-41d4-a716-446655440015', 5.25, 9.99, 'per_sqft')
ON CONFLICT DO NOTHING;

INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES
('b50e8400-e29b-41d4-a716-446655440015', 'd50e8400-e29b-41d4-a716-446655440001', 'Natural'),
('b50e8400-e29b-41d4-a716-446655440015', 'd50e8400-e29b-41d4-a716-446655440002', 'Oak'),
('b50e8400-e29b-41d4-a716-446655440015', 'd50e8400-e29b-41d4-a716-446655440003', 'Wire-Brushed'),
('b50e8400-e29b-41d4-a716-446655440015', 'd50e8400-e29b-41d4-a716-446655440004', '7.5x75')
ON CONFLICT DO NOTHING;

INSERT INTO inventory_snapshots (sku_id, warehouse, qty_on_hand, qty_in_transit, fresh_until) VALUES
('b50e8400-e29b-41d4-a716-446655440015', 'default', 18, 0, NOW() + INTERVAL '24 hours')
ON CONFLICT DO NOTHING;

-- ==================== Media Assets ====================
-- Product-level primary + alternate images using placeholder service

INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order) VALUES
-- Calacatta Gold Marble (product-level primary + SKU-level alternates)
('a50e8400-e29b-41d4-a716-446655440001', NULL, 'primary',
 'https://placehold.co/800x800/f5f0eb/292524?text=Calacatta+Gold\nMarble', 0),
('a50e8400-e29b-41d4-a716-446655440001', NULL, 'alternate',
 'https://placehold.co/800x800/e8e0d8/292524?text=Calacatta+Gold\nClose-Up', 1),
('a50e8400-e29b-41d4-a716-446655440001', NULL, 'lifestyle',
 'https://placehold.co/800x800/faf7f4/78716c?text=Calacatta+Gold\nInstalled', 2),
('a50e8400-e29b-41d4-a716-446655440001', 'b50e8400-e29b-41d4-a716-446655440011', 'primary',
 'https://placehold.co/800x800/f5f0eb/292524?text=Calacatta+Gold\n18x18+Polished', 0),
('a50e8400-e29b-41d4-a716-446655440001', 'b50e8400-e29b-41d4-a716-446655440012', 'primary',
 'https://placehold.co/800x800/eae4dc/292524?text=Calacatta+Gold\n24x24+Honed', 0),

-- Silver Travertine
('a50e8400-e29b-41d4-a716-446655440002', NULL, 'primary',
 'https://placehold.co/800x800/d6d0c8/292524?text=Silver\nTravertine', 0),
('a50e8400-e29b-41d4-a716-446655440002', NULL, 'alternate',
 'https://placehold.co/800x800/cfc9c0/292524?text=Silver+Travertine\nTexture', 1),
('a50e8400-e29b-41d4-a716-446655440002', NULL, 'lifestyle',
 'https://placehold.co/800x800/e0dbd4/78716c?text=Travertine\nBathroom', 2),
('a50e8400-e29b-41d4-a716-446655440002', 'b50e8400-e29b-41d4-a716-446655440013', 'primary',
 'https://placehold.co/800x800/c8c2b8/292524?text=Silver+Travertine\n12x24+Tumbled', 0),

-- Essentials White Porcelain
('a50e8400-e29b-41d4-a716-446655440003', NULL, 'primary',
 'https://placehold.co/800x800/f8f8f6/292524?text=Essentials\nWhite+Porcelain', 0),
('a50e8400-e29b-41d4-a716-446655440003', NULL, 'alternate',
 'https://placehold.co/800x800/f0f0ee/292524?text=White+Porcelain\nDetail', 1),
('a50e8400-e29b-41d4-a716-446655440003', 'b50e8400-e29b-41d4-a716-446655440014', 'primary',
 'https://placehold.co/800x800/f0f0ee/292524?text=Essentials+White\n12x24+Matte', 0),

-- French Oak Blanc
('a50e8400-e29b-41d4-a716-446655440004', NULL, 'primary',
 'https://placehold.co/800x800/ddd5c8/292524?text=French+Oak\nBlanc', 0),
('a50e8400-e29b-41d4-a716-446655440004', NULL, 'alternate',
 'https://placehold.co/800x800/d4ccbf/292524?text=French+Oak\nGrain+Detail', 1),
('a50e8400-e29b-41d4-a716-446655440004', NULL, 'lifestyle',
 'https://placehold.co/800x800/e8e0d4/78716c?text=French+Oak\nLiving+Room', 2),
('a50e8400-e29b-41d4-a716-446655440004', 'b50e8400-e29b-41d4-a716-446655440015', 'primary',
 'https://placehold.co/800x800/d8d0c3/292524?text=French+Oak\n7.5x75', 0),

-- Hickory Saddle
('a50e8400-e29b-41d4-a716-446655440005', NULL, 'primary',
 'https://placehold.co/800x800/b8a48c/292524?text=Hickory\nSaddle', 0),
('a50e8400-e29b-41d4-a716-446655440005', NULL, 'alternate',
 'https://placehold.co/800x800/af9b82/292524?text=Hickory+Saddle\nTexture', 1),

-- Red Oak Natural
('a50e8400-e29b-41d4-a716-446655440006', NULL, 'primary',
 'https://placehold.co/800x800/c8a882/292524?text=Red+Oak\nNatural', 0),
('a50e8400-e29b-41d4-a716-446655440006', NULL, 'alternate',
 'https://placehold.co/800x800/c0a078/292524?text=Red+Oak\nGrain', 1),

-- Woodland Hickory LVP
('a50e8400-e29b-41d4-a716-446655440007', NULL, 'primary',
 'https://placehold.co/800x800/b09878/292524?text=Woodland\nHickory+LVP', 0),
('a50e8400-e29b-41d4-a716-446655440007', NULL, 'alternate',
 'https://placehold.co/800x800/a89070/292524?text=Woodland+LVP\nPlank+Detail', 1),
('a50e8400-e29b-41d4-a716-446655440007', NULL, 'lifestyle',
 'https://placehold.co/800x800/c8b898/78716c?text=Woodland+LVP\nKitchen', 2),

-- Coastal Oak LVP
('a50e8400-e29b-41d4-a716-446655440008', NULL, 'primary',
 'https://placehold.co/800x800/c0b8a8/292524?text=Coastal\nOak+LVP', 0),
('a50e8400-e29b-41d4-a716-446655440008', NULL, 'alternate',
 'https://placehold.co/800x800/b8b0a0/292524?text=Coastal+Oak\nTexture', 1)
ON CONFLICT DO NOTHING;

-- Margin Tiers for Trade Pricing
INSERT INTO margin_tiers (name, discount_percent, spend_threshold, tier_level) VALUES
('Silver', 10.00, 0, 0),
('Gold', 15.00, 12500, 1),
('Platinum', 20.00, 25000, 2);

-- ==================== Extended Seed Data ====================
-- 15 more products across multiple categories for richer filtering

-- New Products
INSERT INTO products (id, vendor_id, name, collection, category_id, status, description_short) VALUES
-- Ceramic Tile (2)
('a50e8400-e29b-41d4-a716-446655440010', '550e8400-e29b-41d4-a716-446655440003',
 'Glacier White Ceramic', 'Keystones Collection', '650e8400-e29b-41d4-a716-446655440013',
 'active', 'Bright white ceramic wall and floor tile'),
('a50e8400-e29b-41d4-a716-446655440011', '550e8400-e29b-41d4-a716-446655440004',
 'Sahara Sand Ceramic', 'Desert Collection', '650e8400-e29b-41d4-a716-446655440013',
 'active', 'Warm sand-toned ceramic tile for versatile spaces'),

-- Wood Look Tile (2)
('a50e8400-e29b-41d4-a716-446655440012', '550e8400-e29b-41d4-a716-446655440001',
 'Savannah Driftwood', 'Carolina Timber Collection', '650e8400-e29b-41d4-a716-446655440015',
 'active', 'Porcelain wood-look tile with realistic grain texture'),
('a50e8400-e29b-41d4-a716-446655440013', '550e8400-e29b-41d4-a716-446655440003',
 'Urban Walnut Plank', 'Ember Wood Collection', '650e8400-e29b-41d4-a716-446655440015',
 'active', 'Dark walnut wood-look porcelain plank tile'),

-- Backsplash Tile (2)
('a50e8400-e29b-41d4-a716-446655440014', '550e8400-e29b-41d4-a716-446655440002',
 'Artisan Subway White', 'Metro Collection', '650e8400-e29b-41d4-a716-446655440051',
 'active', 'Hand-crafted look subway tile with slight undulation'),
('a50e8400-e29b-41d4-a716-446655440015', '550e8400-e29b-41d4-a716-446655440006',
 'Zellige Sage Green', 'Zellige Collection', '650e8400-e29b-41d4-a716-446655440051',
 'active', 'Moroccan-inspired zellige tile in sage green'),

-- Mosaic Tile (2)
('a50e8400-e29b-41d4-a716-446655440016', '550e8400-e29b-41d4-a716-446655440001',
 'Calacatta Hexagon Mosaic', 'Natural Stone Collection', '650e8400-e29b-41d4-a716-446655440014',
 'active', 'Marble hexagon mosaic on mesh-mounted sheets'),
('a50e8400-e29b-41d4-a716-446655440017', '550e8400-e29b-41d4-a716-446655440007',
 'Midnight Blue Penny Round', 'Artisan Collection', '650e8400-e29b-41d4-a716-446655440014',
 'active', 'Glazed porcelain penny round mosaic in deep blue'),

-- Porcelain Tile (2 more)
('a50e8400-e29b-41d4-a716-446655440018', '550e8400-e29b-41d4-a716-446655440005',
 'Statuario Polished Porcelain', 'Classici Collection', '650e8400-e29b-41d4-a716-446655440012',
 'active', 'Large format marble-look porcelain with dramatic veining'),
('a50e8400-e29b-41d4-a716-446655440019', '550e8400-e29b-41d4-a716-446655440003',
 'Slate Anthracite', 'Urban Edge Collection', '650e8400-e29b-41d4-a716-446655440012',
 'active', 'Dark slate-look porcelain for contemporary spaces'),

-- Luxury Vinyl (2 more)
('a50e8400-e29b-41d4-a716-446655440020', '550e8400-e29b-41d4-a716-446655440001',
 'Brookstone Ash LVP', 'Cyrus Collection', '650e8400-e29b-41d4-a716-446655440031',
 'active', 'Light gray ash luxury vinyl plank with SPC core'),
('a50e8400-e29b-41d4-a716-446655440021', '550e8400-e29b-41d4-a716-446655440002',
 'Chestnut Ridge LVP', 'Prescott Collection', '650e8400-e29b-41d4-a716-446655440031',
 'active', 'Rich chestnut brown waterproof vinyl plank'),

-- Quartz Countertop (1)
('a50e8400-e29b-41d4-a716-446655440022', '550e8400-e29b-41d4-a716-446655440001',
 'Calacatta Laza Quartz', 'Premium Quartz Collection', '650e8400-e29b-41d4-a716-446655440041',
 'active', 'Quartz countertop with calacatta marble veining'),

-- Stacked Stone (1)
('a50e8400-e29b-41d4-a716-446655440023', '550e8400-e29b-41d4-a716-446655440001',
 'Arctic White Stacked Stone', 'Rockmount Collection', '650e8400-e29b-41d4-a716-446655440061',
 'active', 'Natural quartzite stacked stone ledger panel'),

-- Engineered Hardwood (1 more)
('a50e8400-e29b-41d4-a716-446655440024', '550e8400-e29b-41d4-a716-446655440007',
 'European White Oak Herringbone', 'Heritage Collection', '650e8400-e29b-41d4-a716-446655440021',
 'active', 'Engineered white oak in herringbone pattern')
ON CONFLICT DO NOTHING;

-- SKUs for new products (2 per product = 30 SKUs)
INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name, sell_by, status) VALUES
-- Glacier White Ceramic
('b50e8400-e29b-41d4-a716-446655440020', 'a50e8400-e29b-41d4-a716-446655440010',
 'DAL-GLCW-1212-GL', 'GLC-WHT-12X12-G', '12x12 Glossy', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440021', 'a50e8400-e29b-41d4-a716-446655440010',
 'DAL-GLCW-4X16-GL', 'GLC-WHT-4X16-G', '4x16 Glossy', 'sqft', 'active'),
-- Sahara Sand Ceramic
('b50e8400-e29b-41d4-a716-446655440022', 'a50e8400-e29b-41d4-a716-446655440011',
 'AO-SHSD-1212-MT', 'SAH-SND-12X12-M', '12x12 Matte', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440023', 'a50e8400-e29b-41d4-a716-446655440011',
 'AO-SHSD-1824-MT', 'SAH-SND-18X24-M', '18x24 Matte', 'sqft', 'active'),
-- Savannah Driftwood
('b50e8400-e29b-41d4-a716-446655440024', 'a50e8400-e29b-41d4-a716-446655440012',
 'MSI-SVDW-6X36-MT', 'SVN-DFT-6X36-M', '6x36 Matte', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440025', 'a50e8400-e29b-41d4-a716-446655440012',
 'MSI-SVDW-8X48-MT', 'SVN-DFT-8X48-M', '8x48 Matte', 'sqft', 'active'),
-- Urban Walnut Plank
('b50e8400-e29b-41d4-a716-446655440026', 'a50e8400-e29b-41d4-a716-446655440013',
 'DAL-UBWN-6X36-MT', 'URB-WLN-6X36-M', '6x36 Matte', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440027', 'a50e8400-e29b-41d4-a716-446655440013',
 'DAL-UBWN-8X48-MT', 'URB-WLN-8X48-M', '8x48 Matte', 'sqft', 'active'),
-- Artisan Subway White
('b50e8400-e29b-41d4-a716-446655440028', 'a50e8400-e29b-41d4-a716-446655440014',
 'BED-ARSW-3X6-GL', 'ART-SUB-3X6-G', '3x6 Glossy', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440029', 'a50e8400-e29b-41d4-a716-446655440014',
 'BED-ARSW-3X12-GL', 'ART-SUB-3X12-G', '3x12 Glossy', 'sqft', 'active'),
-- Zellige Sage Green
('b50e8400-e29b-41d4-a716-446655440030', 'a50e8400-e29b-41d4-a716-446655440015',
 'ELY-ZLSG-4X4-GL', 'ZLG-SGE-4X4-G', '4x4 Glossy', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440031', 'a50e8400-e29b-41d4-a716-446655440015',
 'ELY-ZLSG-2X6-GL', 'ZLG-SGE-2X6-G', '2x6 Glossy', 'sqft', 'active'),
-- Calacatta Hexagon Mosaic
('b50e8400-e29b-41d4-a716-446655440032', 'a50e8400-e29b-41d4-a716-446655440016',
 'MSI-CLHX-2IN-POL', 'CAL-HEX-2IN-P', '2" Hex Polished', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440033', 'a50e8400-e29b-41d4-a716-446655440016',
 'MSI-CLHX-2IN-HON', 'CAL-HEX-2IN-H', '2" Hex Honed', 'sqft', 'active'),
-- Midnight Blue Penny Round
('b50e8400-e29b-41d4-a716-446655440034', 'a50e8400-e29b-41d4-a716-446655440017',
 'AZT-MBPR-1IN-GL', 'MID-BLU-1IN-G', '1" Penny Glossy', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440035', 'a50e8400-e29b-41d4-a716-446655440017',
 'AZT-MBPR-1IN-MT', 'MID-BLU-1IN-M', '1" Penny Matte', 'sqft', 'active'),
-- Statuario Polished Porcelain
('b50e8400-e29b-41d4-a716-446655440036', 'a50e8400-e29b-41d4-a716-446655440018',
 'MZ-STPO-2424-POL', 'STA-POL-24X24-P', '24x24 Polished', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440037', 'a50e8400-e29b-41d4-a716-446655440018',
 'MZ-STPO-1224-POL', 'STA-POL-12X24-P', '12x24 Polished', 'sqft', 'active'),
-- Slate Anthracite
('b50e8400-e29b-41d4-a716-446655440038', 'a50e8400-e29b-41d4-a716-446655440019',
 'DAL-SLAT-1224-MT', 'SLT-ANT-12X24-M', '12x24 Matte', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440039', 'a50e8400-e29b-41d4-a716-446655440019',
 'DAL-SLAT-2424-MT', 'SLT-ANT-24X24-M', '24x24 Matte', 'sqft', 'active'),
-- Brookstone Ash LVP
('b50e8400-e29b-41d4-a716-446655440040', 'a50e8400-e29b-41d4-a716-446655440020',
 'MSI-BRKA-7X48-CL', 'BRK-ASH-7X48-C', '7x48 Click-Lock', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440041', 'a50e8400-e29b-41d4-a716-446655440020',
 'MSI-BRKA-9X60-CL', 'BRK-ASH-9X60-C', '9x60 Click-Lock', 'sqft', 'active'),
-- Chestnut Ridge LVP
('b50e8400-e29b-41d4-a716-446655440042', 'a50e8400-e29b-41d4-a716-446655440021',
 'BED-CHRD-7X48-CL', 'CHR-RDG-7X48-C', '7x48 Click-Lock', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440043', 'a50e8400-e29b-41d4-a716-446655440021',
 'BED-CHRD-9X60-CL', 'CHR-RDG-9X60-C', '9x60 Click-Lock', 'sqft', 'active'),
-- Calacatta Laza Quartz (per unit - per slab)
('b50e8400-e29b-41d4-a716-446655440044', 'a50e8400-e29b-41d4-a716-446655440022',
 'MSI-CQLZ-3CM-POL', 'CAL-QTZ-3CM-P', '3cm Polished Slab', 'unit', 'active'),
('b50e8400-e29b-41d4-a716-446655440045', 'a50e8400-e29b-41d4-a716-446655440022',
 'MSI-CQLZ-2CM-POL', 'CAL-QTZ-2CM-P', '2cm Polished Slab', 'unit', 'active'),
-- Arctic White Stacked Stone
('b50e8400-e29b-41d4-a716-446655440046', 'a50e8400-e29b-41d4-a716-446655440023',
 'MSI-AWSS-6X24-SPL', 'ARC-WHT-6X24-S', '6x24 Splitface', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440047', 'a50e8400-e29b-41d4-a716-446655440023',
 'MSI-AWSS-6X12-SPL', 'ARC-WHT-6X12-S', '6x12 Splitface Mini', 'sqft', 'active'),
-- European White Oak Herringbone
('b50e8400-e29b-41d4-a716-446655440048', 'a50e8400-e29b-41d4-a716-446655440024',
 'AZT-EWOH-5X24-NL', 'EUR-OAK-5X24-N', '5x24 Natural Lacquer', 'sqft', 'active'),
('b50e8400-e29b-41d4-a716-446655440049', 'a50e8400-e29b-41d4-a716-446655440024',
 'AZT-EWOH-5X24-SM', 'EUR-OAK-5X24-S', '5x24 Smoked', 'sqft', 'active')
ON CONFLICT DO NOTHING;

-- Packaging for new SKUs
INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, weight_per_box_lbs) VALUES
('b50e8400-e29b-41d4-a716-446655440020', 11.00, 11, 38.00),
('b50e8400-e29b-41d4-a716-446655440021', 10.67, 16, 32.00),
('b50e8400-e29b-41d4-a716-446655440022', 11.00, 11, 40.00),
('b50e8400-e29b-41d4-a716-446655440023', 12.00, 4, 44.00),
('b50e8400-e29b-41d4-a716-446655440024', 14.40, 10, 52.00),
('b50e8400-e29b-41d4-a716-446655440025', 21.33, 8, 68.00),
('b50e8400-e29b-41d4-a716-446655440026', 14.40, 10, 50.00),
('b50e8400-e29b-41d4-a716-446655440027', 21.33, 8, 66.00),
('b50e8400-e29b-41d4-a716-446655440028', 5.00, 40, 22.00),
('b50e8400-e29b-41d4-a716-446655440029', 8.00, 32, 28.00),
('b50e8400-e29b-41d4-a716-446655440030', 5.50, 50, 20.00),
('b50e8400-e29b-41d4-a716-446655440031', 4.00, 24, 16.00),
('b50e8400-e29b-41d4-a716-446655440032', 9.60, 1, 24.00),
('b50e8400-e29b-41d4-a716-446655440033', 9.60, 1, 24.00),
('b50e8400-e29b-41d4-a716-446655440034', 10.00, 1, 18.00),
('b50e8400-e29b-41d4-a716-446655440035', 10.00, 1, 18.00),
('b50e8400-e29b-41d4-a716-446655440036', 16.00, 4, 62.00),
('b50e8400-e29b-41d4-a716-446655440037', 12.00, 6, 48.00),
('b50e8400-e29b-41d4-a716-446655440038', 12.00, 6, 46.00),
('b50e8400-e29b-41d4-a716-446655440039', 16.00, 4, 58.00),
('b50e8400-e29b-41d4-a716-446655440040', 23.77, 10, 36.00),
('b50e8400-e29b-41d4-a716-446655440041', 30.00, 8, 42.00),
('b50e8400-e29b-41d4-a716-446655440042', 23.77, 10, 38.00),
('b50e8400-e29b-41d4-a716-446655440043', 30.00, 8, 44.00),
('b50e8400-e29b-41d4-a716-446655440044', 1.00, 1, 280.00),
('b50e8400-e29b-41d4-a716-446655440045', 1.00, 1, 190.00),
('b50e8400-e29b-41d4-a716-446655440046', 6.00, 1, 35.00),
('b50e8400-e29b-41d4-a716-446655440047', 3.00, 1, 18.00),
('b50e8400-e29b-41d4-a716-446655440048', 21.50, 26, 42.00),
('b50e8400-e29b-41d4-a716-446655440049', 21.50, 26, 42.00)
ON CONFLICT DO NOTHING;

-- Pricing for new SKUs
INSERT INTO pricing (sku_id, cost, retail_price, price_basis) VALUES
('b50e8400-e29b-41d4-a716-446655440020', 1.20, 2.49, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440021', 1.35, 2.79, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440022', 1.50, 2.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440023', 1.75, 3.49, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440024', 3.25, 5.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440025', 3.50, 6.49, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440026', 3.75, 6.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440027', 4.00, 7.49, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440028', 4.50, 8.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440029', 5.00, 9.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440030', 8.00, 15.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440031', 7.50, 14.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440032', 12.00, 22.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440033', 11.50, 21.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440034', 9.00, 17.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440035', 8.75, 16.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440036', 3.50, 6.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440037', 3.25, 6.49, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440038', 2.50, 4.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440039', 2.75, 5.49, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440040', 1.90, 3.79, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440041', 2.10, 4.19, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440042', 2.25, 4.49, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440043', 2.50, 4.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440044', 950.00, 1899.00, 'per_unit'),
('b50e8400-e29b-41d4-a716-446655440045', 750.00, 1499.00, 'per_unit'),
('b50e8400-e29b-41d4-a716-446655440046', 5.50, 10.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440047', 5.00, 9.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440048', 7.50, 13.99, 'per_sqft'),
('b50e8400-e29b-41d4-a716-446655440049', 8.00, 14.99, 'per_sqft')
ON CONFLICT DO NOTHING;

-- SKU Attributes for new products
INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES
-- Glacier White Ceramic 12x12
('b50e8400-e29b-41d4-a716-446655440020', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440020', 'd50e8400-e29b-41d4-a716-446655440002', 'Ceramic'),
('b50e8400-e29b-41d4-a716-446655440020', 'd50e8400-e29b-41d4-a716-446655440003', 'Glossy'),
('b50e8400-e29b-41d4-a716-446655440020', 'd50e8400-e29b-41d4-a716-446655440004', '12x12'),
-- Glacier White Ceramic 4x16
('b50e8400-e29b-41d4-a716-446655440021', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440021', 'd50e8400-e29b-41d4-a716-446655440002', 'Ceramic'),
('b50e8400-e29b-41d4-a716-446655440021', 'd50e8400-e29b-41d4-a716-446655440003', 'Glossy'),
('b50e8400-e29b-41d4-a716-446655440021', 'd50e8400-e29b-41d4-a716-446655440004', '4x16'),
-- Sahara Sand Ceramic 12x12
('b50e8400-e29b-41d4-a716-446655440022', 'd50e8400-e29b-41d4-a716-446655440001', 'Beige'),
('b50e8400-e29b-41d4-a716-446655440022', 'd50e8400-e29b-41d4-a716-446655440002', 'Ceramic'),
('b50e8400-e29b-41d4-a716-446655440022', 'd50e8400-e29b-41d4-a716-446655440003', 'Matte'),
('b50e8400-e29b-41d4-a716-446655440022', 'd50e8400-e29b-41d4-a716-446655440004', '12x12'),
-- Sahara Sand Ceramic 18x24
('b50e8400-e29b-41d4-a716-446655440023', 'd50e8400-e29b-41d4-a716-446655440001', 'Beige'),
('b50e8400-e29b-41d4-a716-446655440023', 'd50e8400-e29b-41d4-a716-446655440002', 'Ceramic'),
('b50e8400-e29b-41d4-a716-446655440023', 'd50e8400-e29b-41d4-a716-446655440003', 'Matte'),
('b50e8400-e29b-41d4-a716-446655440023', 'd50e8400-e29b-41d4-a716-446655440004', '18x24'),
-- Savannah Driftwood 6x36
('b50e8400-e29b-41d4-a716-446655440024', 'd50e8400-e29b-41d4-a716-446655440001', 'Beige'),
('b50e8400-e29b-41d4-a716-446655440024', 'd50e8400-e29b-41d4-a716-446655440002', 'Porcelain'),
('b50e8400-e29b-41d4-a716-446655440024', 'd50e8400-e29b-41d4-a716-446655440003', 'Matte'),
('b50e8400-e29b-41d4-a716-446655440024', 'd50e8400-e29b-41d4-a716-446655440004', '6x36'),
('b50e8400-e29b-41d4-a716-446655440024', 'd50e8400-e29b-41d4-a716-446655440012', 'Wood'),
-- Savannah Driftwood 8x48
('b50e8400-e29b-41d4-a716-446655440025', 'd50e8400-e29b-41d4-a716-446655440001', 'Beige'),
('b50e8400-e29b-41d4-a716-446655440025', 'd50e8400-e29b-41d4-a716-446655440002', 'Porcelain'),
('b50e8400-e29b-41d4-a716-446655440025', 'd50e8400-e29b-41d4-a716-446655440003', 'Matte'),
('b50e8400-e29b-41d4-a716-446655440025', 'd50e8400-e29b-41d4-a716-446655440004', '8x48'),
('b50e8400-e29b-41d4-a716-446655440025', 'd50e8400-e29b-41d4-a716-446655440012', 'Wood'),
-- Urban Walnut 6x36
('b50e8400-e29b-41d4-a716-446655440026', 'd50e8400-e29b-41d4-a716-446655440001', 'Brown'),
('b50e8400-e29b-41d4-a716-446655440026', 'd50e8400-e29b-41d4-a716-446655440002', 'Porcelain'),
('b50e8400-e29b-41d4-a716-446655440026', 'd50e8400-e29b-41d4-a716-446655440003', 'Matte'),
('b50e8400-e29b-41d4-a716-446655440026', 'd50e8400-e29b-41d4-a716-446655440004', '6x36'),
('b50e8400-e29b-41d4-a716-446655440026', 'd50e8400-e29b-41d4-a716-446655440012', 'Wood'),
-- Urban Walnut 8x48
('b50e8400-e29b-41d4-a716-446655440027', 'd50e8400-e29b-41d4-a716-446655440001', 'Brown'),
('b50e8400-e29b-41d4-a716-446655440027', 'd50e8400-e29b-41d4-a716-446655440002', 'Porcelain'),
('b50e8400-e29b-41d4-a716-446655440027', 'd50e8400-e29b-41d4-a716-446655440003', 'Matte'),
('b50e8400-e29b-41d4-a716-446655440027', 'd50e8400-e29b-41d4-a716-446655440004', '8x48'),
('b50e8400-e29b-41d4-a716-446655440027', 'd50e8400-e29b-41d4-a716-446655440012', 'Wood'),
-- Artisan Subway 3x6
('b50e8400-e29b-41d4-a716-446655440028', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440028', 'd50e8400-e29b-41d4-a716-446655440002', 'Ceramic'),
('b50e8400-e29b-41d4-a716-446655440028', 'd50e8400-e29b-41d4-a716-446655440003', 'Glossy'),
('b50e8400-e29b-41d4-a716-446655440028', 'd50e8400-e29b-41d4-a716-446655440004', '3x6'),
-- Artisan Subway 3x12
('b50e8400-e29b-41d4-a716-446655440029', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440029', 'd50e8400-e29b-41d4-a716-446655440002', 'Ceramic'),
('b50e8400-e29b-41d4-a716-446655440029', 'd50e8400-e29b-41d4-a716-446655440003', 'Glossy'),
('b50e8400-e29b-41d4-a716-446655440029', 'd50e8400-e29b-41d4-a716-446655440004', '3x12'),
-- Zellige Sage 4x4
('b50e8400-e29b-41d4-a716-446655440030', 'd50e8400-e29b-41d4-a716-446655440001', 'Green'),
('b50e8400-e29b-41d4-a716-446655440030', 'd50e8400-e29b-41d4-a716-446655440002', 'Ceramic'),
('b50e8400-e29b-41d4-a716-446655440030', 'd50e8400-e29b-41d4-a716-446655440003', 'Glossy'),
('b50e8400-e29b-41d4-a716-446655440030', 'd50e8400-e29b-41d4-a716-446655440004', '4x4'),
-- Zellige Sage 2x6
('b50e8400-e29b-41d4-a716-446655440031', 'd50e8400-e29b-41d4-a716-446655440001', 'Green'),
('b50e8400-e29b-41d4-a716-446655440031', 'd50e8400-e29b-41d4-a716-446655440002', 'Ceramic'),
('b50e8400-e29b-41d4-a716-446655440031', 'd50e8400-e29b-41d4-a716-446655440003', 'Glossy'),
('b50e8400-e29b-41d4-a716-446655440031', 'd50e8400-e29b-41d4-a716-446655440004', '2x6'),
-- Calacatta Hexagon Polished
('b50e8400-e29b-41d4-a716-446655440032', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440032', 'd50e8400-e29b-41d4-a716-446655440002', 'Marble'),
('b50e8400-e29b-41d4-a716-446655440032', 'd50e8400-e29b-41d4-a716-446655440003', 'Polished'),
('b50e8400-e29b-41d4-a716-446655440032', 'd50e8400-e29b-41d4-a716-446655440004', '2" Hex'),
('b50e8400-e29b-41d4-a716-446655440032', 'd50e8400-e29b-41d4-a716-446655440005', 'Hexagon'),
-- Calacatta Hexagon Honed
('b50e8400-e29b-41d4-a716-446655440033', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440033', 'd50e8400-e29b-41d4-a716-446655440002', 'Marble'),
('b50e8400-e29b-41d4-a716-446655440033', 'd50e8400-e29b-41d4-a716-446655440003', 'Honed'),
('b50e8400-e29b-41d4-a716-446655440033', 'd50e8400-e29b-41d4-a716-446655440004', '2" Hex'),
('b50e8400-e29b-41d4-a716-446655440033', 'd50e8400-e29b-41d4-a716-446655440005', 'Hexagon'),
-- Midnight Blue Penny Glossy
('b50e8400-e29b-41d4-a716-446655440034', 'd50e8400-e29b-41d4-a716-446655440001', 'Blue'),
('b50e8400-e29b-41d4-a716-446655440034', 'd50e8400-e29b-41d4-a716-446655440002', 'Porcelain'),
('b50e8400-e29b-41d4-a716-446655440034', 'd50e8400-e29b-41d4-a716-446655440003', 'Glossy'),
('b50e8400-e29b-41d4-a716-446655440034', 'd50e8400-e29b-41d4-a716-446655440004', '1" Penny'),
('b50e8400-e29b-41d4-a716-446655440034', 'd50e8400-e29b-41d4-a716-446655440005', 'Penny Round'),
-- Midnight Blue Penny Matte
('b50e8400-e29b-41d4-a716-446655440035', 'd50e8400-e29b-41d4-a716-446655440001', 'Blue'),
('b50e8400-e29b-41d4-a716-446655440035', 'd50e8400-e29b-41d4-a716-446655440002', 'Porcelain'),
('b50e8400-e29b-41d4-a716-446655440035', 'd50e8400-e29b-41d4-a716-446655440003', 'Matte'),
('b50e8400-e29b-41d4-a716-446655440035', 'd50e8400-e29b-41d4-a716-446655440004', '1" Penny'),
('b50e8400-e29b-41d4-a716-446655440035', 'd50e8400-e29b-41d4-a716-446655440005', 'Penny Round'),
-- Statuario 24x24
('b50e8400-e29b-41d4-a716-446655440036', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440036', 'd50e8400-e29b-41d4-a716-446655440002', 'Porcelain'),
('b50e8400-e29b-41d4-a716-446655440036', 'd50e8400-e29b-41d4-a716-446655440003', 'Polished'),
('b50e8400-e29b-41d4-a716-446655440036', 'd50e8400-e29b-41d4-a716-446655440004', '24x24'),
('b50e8400-e29b-41d4-a716-446655440036', 'd50e8400-e29b-41d4-a716-446655440012', 'Marble'),
-- Statuario 12x24
('b50e8400-e29b-41d4-a716-446655440037', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440037', 'd50e8400-e29b-41d4-a716-446655440002', 'Porcelain'),
('b50e8400-e29b-41d4-a716-446655440037', 'd50e8400-e29b-41d4-a716-446655440003', 'Polished'),
('b50e8400-e29b-41d4-a716-446655440037', 'd50e8400-e29b-41d4-a716-446655440004', '12x24'),
('b50e8400-e29b-41d4-a716-446655440037', 'd50e8400-e29b-41d4-a716-446655440012', 'Marble'),
-- Slate Anthracite 12x24
('b50e8400-e29b-41d4-a716-446655440038', 'd50e8400-e29b-41d4-a716-446655440001', 'Black'),
('b50e8400-e29b-41d4-a716-446655440038', 'd50e8400-e29b-41d4-a716-446655440002', 'Porcelain'),
('b50e8400-e29b-41d4-a716-446655440038', 'd50e8400-e29b-41d4-a716-446655440003', 'Matte'),
('b50e8400-e29b-41d4-a716-446655440038', 'd50e8400-e29b-41d4-a716-446655440004', '12x24'),
('b50e8400-e29b-41d4-a716-446655440038', 'd50e8400-e29b-41d4-a716-446655440012', 'Slate'),
-- Slate Anthracite 24x24
('b50e8400-e29b-41d4-a716-446655440039', 'd50e8400-e29b-41d4-a716-446655440001', 'Black'),
('b50e8400-e29b-41d4-a716-446655440039', 'd50e8400-e29b-41d4-a716-446655440002', 'Porcelain'),
('b50e8400-e29b-41d4-a716-446655440039', 'd50e8400-e29b-41d4-a716-446655440003', 'Matte'),
('b50e8400-e29b-41d4-a716-446655440039', 'd50e8400-e29b-41d4-a716-446655440004', '24x24'),
('b50e8400-e29b-41d4-a716-446655440039', 'd50e8400-e29b-41d4-a716-446655440012', 'Slate'),
-- Brookstone Ash 7x48
('b50e8400-e29b-41d4-a716-446655440040', 'd50e8400-e29b-41d4-a716-446655440001', 'Gray'),
('b50e8400-e29b-41d4-a716-446655440040', 'd50e8400-e29b-41d4-a716-446655440002', 'Vinyl'),
('b50e8400-e29b-41d4-a716-446655440040', 'd50e8400-e29b-41d4-a716-446655440003', 'Embossed'),
('b50e8400-e29b-41d4-a716-446655440040', 'd50e8400-e29b-41d4-a716-446655440004', '7x48'),
-- Brookstone Ash 9x60
('b50e8400-e29b-41d4-a716-446655440041', 'd50e8400-e29b-41d4-a716-446655440001', 'Gray'),
('b50e8400-e29b-41d4-a716-446655440041', 'd50e8400-e29b-41d4-a716-446655440002', 'Vinyl'),
('b50e8400-e29b-41d4-a716-446655440041', 'd50e8400-e29b-41d4-a716-446655440003', 'Embossed'),
('b50e8400-e29b-41d4-a716-446655440041', 'd50e8400-e29b-41d4-a716-446655440004', '9x60'),
-- Chestnut Ridge 7x48
('b50e8400-e29b-41d4-a716-446655440042', 'd50e8400-e29b-41d4-a716-446655440001', 'Brown'),
('b50e8400-e29b-41d4-a716-446655440042', 'd50e8400-e29b-41d4-a716-446655440002', 'Vinyl'),
('b50e8400-e29b-41d4-a716-446655440042', 'd50e8400-e29b-41d4-a716-446655440003', 'Embossed'),
('b50e8400-e29b-41d4-a716-446655440042', 'd50e8400-e29b-41d4-a716-446655440004', '7x48'),
-- Chestnut Ridge 9x60
('b50e8400-e29b-41d4-a716-446655440043', 'd50e8400-e29b-41d4-a716-446655440001', 'Brown'),
('b50e8400-e29b-41d4-a716-446655440043', 'd50e8400-e29b-41d4-a716-446655440002', 'Vinyl'),
('b50e8400-e29b-41d4-a716-446655440043', 'd50e8400-e29b-41d4-a716-446655440003', 'Embossed'),
('b50e8400-e29b-41d4-a716-446655440043', 'd50e8400-e29b-41d4-a716-446655440004', '9x60'),
-- Calacatta Laza Quartz 3cm
('b50e8400-e29b-41d4-a716-446655440044', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440044', 'd50e8400-e29b-41d4-a716-446655440002', 'Quartz'),
('b50e8400-e29b-41d4-a716-446655440044', 'd50e8400-e29b-41d4-a716-446655440003', 'Polished'),
('b50e8400-e29b-41d4-a716-446655440044', 'd50e8400-e29b-41d4-a716-446655440010', '3cm'),
-- Calacatta Laza Quartz 2cm
('b50e8400-e29b-41d4-a716-446655440045', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440045', 'd50e8400-e29b-41d4-a716-446655440002', 'Quartz'),
('b50e8400-e29b-41d4-a716-446655440045', 'd50e8400-e29b-41d4-a716-446655440003', 'Polished'),
('b50e8400-e29b-41d4-a716-446655440045', 'd50e8400-e29b-41d4-a716-446655440010', '2cm'),
-- Arctic White Stacked Stone 6x24
('b50e8400-e29b-41d4-a716-446655440046', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440046', 'd50e8400-e29b-41d4-a716-446655440002', 'Quartzite'),
('b50e8400-e29b-41d4-a716-446655440046', 'd50e8400-e29b-41d4-a716-446655440003', 'Splitface'),
('b50e8400-e29b-41d4-a716-446655440046', 'd50e8400-e29b-41d4-a716-446655440004', '6x24'),
-- Arctic White Stacked Stone 6x12
('b50e8400-e29b-41d4-a716-446655440047', 'd50e8400-e29b-41d4-a716-446655440001', 'White'),
('b50e8400-e29b-41d4-a716-446655440047', 'd50e8400-e29b-41d4-a716-446655440002', 'Quartzite'),
('b50e8400-e29b-41d4-a716-446655440047', 'd50e8400-e29b-41d4-a716-446655440003', 'Splitface'),
('b50e8400-e29b-41d4-a716-446655440047', 'd50e8400-e29b-41d4-a716-446655440004', '6x12'),
-- European White Oak 5x24 Natural
('b50e8400-e29b-41d4-a716-446655440048', 'd50e8400-e29b-41d4-a716-446655440001', 'Natural'),
('b50e8400-e29b-41d4-a716-446655440048', 'd50e8400-e29b-41d4-a716-446655440002', 'Oak'),
('b50e8400-e29b-41d4-a716-446655440048', 'd50e8400-e29b-41d4-a716-446655440003', 'Lacquered'),
('b50e8400-e29b-41d4-a716-446655440048', 'd50e8400-e29b-41d4-a716-446655440004', '5x24'),
-- European White Oak 5x24 Smoked
('b50e8400-e29b-41d4-a716-446655440049', 'd50e8400-e29b-41d4-a716-446655440001', 'Brown'),
('b50e8400-e29b-41d4-a716-446655440049', 'd50e8400-e29b-41d4-a716-446655440002', 'Oak'),
('b50e8400-e29b-41d4-a716-446655440049', 'd50e8400-e29b-41d4-a716-446655440003', 'Smoked'),
('b50e8400-e29b-41d4-a716-446655440049', 'd50e8400-e29b-41d4-a716-446655440004', '5x24')
ON CONFLICT DO NOTHING;

-- Inventory for new SKUs
INSERT INTO inventory_snapshots (sku_id, warehouse, qty_on_hand, qty_in_transit, fresh_until) VALUES
('b50e8400-e29b-41d4-a716-446655440020', 'default', 150, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440021', 'default', 80, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440022', 'default', 95, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440023', 'default', 40, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440024', 'default', 60, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440025', 'default', 45, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440026', 'default', 55, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440027', 'default', 30, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440028', 'default', 200, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440029', 'default', 120, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440030', 'default', 35, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440031', 'default', 25, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440032', 'default', 18, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440033', 'default', 22, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440034', 'default', 15, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440035', 'default', 12, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440036', 'default', 70, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440037', 'default', 90, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440038', 'default', 65, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440039', 'default', 50, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440040', 'default', 100, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440041', 'default', 75, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440042', 'default', 85, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440043', 'default', 5, 20, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440044', 'default', 4, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440045', 'default', 6, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440046', 'default', 40, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440047', 'default', 55, 0, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440048', 'default', 0, 30, NOW() + INTERVAL '24 hours'),
('b50e8400-e29b-41d4-a716-446655440049', 'default', 20, 0, NOW() + INTERVAL '24 hours')
ON CONFLICT DO NOTHING;

-- Media assets for new products (placeholder images)
INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order) VALUES
-- Glacier White Ceramic
('a50e8400-e29b-41d4-a716-446655440010', NULL, 'primary',
 'https://placehold.co/800x800/f0f0f0/292524?text=Glacier+White\nCeramic', 0),
('a50e8400-e29b-41d4-a716-446655440010', NULL, 'alternate',
 'https://placehold.co/800x800/e8e8e8/292524?text=Glacier+White\nDetail', 1),
-- Sahara Sand Ceramic
('a50e8400-e29b-41d4-a716-446655440011', NULL, 'primary',
 'https://placehold.co/800x800/e8ddd0/292524?text=Sahara+Sand\nCeramic', 0),
('a50e8400-e29b-41d4-a716-446655440011', NULL, 'lifestyle',
 'https://placehold.co/800x800/dfd4c6/78716c?text=Sahara+Sand\nBathroom', 1),
-- Savannah Driftwood
('a50e8400-e29b-41d4-a716-446655440012', NULL, 'primary',
 'https://placehold.co/800x800/d4c8b0/292524?text=Savannah\nDriftwood', 0),
('a50e8400-e29b-41d4-a716-446655440012', NULL, 'lifestyle',
 'https://placehold.co/800x800/ccc0a8/78716c?text=Driftwood\nLiving+Room', 1),
-- Urban Walnut
('a50e8400-e29b-41d4-a716-446655440013', NULL, 'primary',
 'https://placehold.co/800x800/8b7355/f5f0eb?text=Urban\nWalnut', 0),
('a50e8400-e29b-41d4-a716-446655440013', NULL, 'alternate',
 'https://placehold.co/800x800/7a6548/f5f0eb?text=Urban+Walnut\nGrain', 1),
-- Artisan Subway
('a50e8400-e29b-41d4-a716-446655440014', NULL, 'primary',
 'https://placehold.co/800x800/f5f5f0/292524?text=Artisan\nSubway+White', 0),
('a50e8400-e29b-41d4-a716-446655440014', NULL, 'lifestyle',
 'https://placehold.co/800x800/f0f0eb/78716c?text=Subway\nKitchen', 1),
-- Zellige Sage
('a50e8400-e29b-41d4-a716-446655440015', NULL, 'primary',
 'https://placehold.co/800x800/9cad8f/292524?text=Zellige\nSage+Green', 0),
('a50e8400-e29b-41d4-a716-446655440015', NULL, 'alternate',
 'https://placehold.co/800x800/8fa082/292524?text=Zellige\nTexture', 1),
-- Calacatta Hexagon Mosaic
('a50e8400-e29b-41d4-a716-446655440016', NULL, 'primary',
 'https://placehold.co/800x800/f5f0eb/292524?text=Calacatta\nHex+Mosaic', 0),
('a50e8400-e29b-41d4-a716-446655440016', NULL, 'alternate',
 'https://placehold.co/800x800/eae4dc/292524?text=Hex+Mosaic\nClose-Up', 1),
-- Midnight Blue Penny
('a50e8400-e29b-41d4-a716-446655440017', NULL, 'primary',
 'https://placehold.co/800x800/2c3e6b/f5f0eb?text=Midnight+Blue\nPenny+Round', 0),
('a50e8400-e29b-41d4-a716-446655440017', NULL, 'lifestyle',
 'https://placehold.co/800x800/354878/f5f0eb?text=Blue+Penny\nShower+Floor', 1),
-- Statuario Porcelain
('a50e8400-e29b-41d4-a716-446655440018', NULL, 'primary',
 'https://placehold.co/800x800/f5f0eb/292524?text=Statuario\nPolished', 0),
('a50e8400-e29b-41d4-a716-446655440018', NULL, 'lifestyle',
 'https://placehold.co/800x800/eee8e0/78716c?text=Statuario\nEntryway', 1),
-- Slate Anthracite
('a50e8400-e29b-41d4-a716-446655440019', NULL, 'primary',
 'https://placehold.co/800x800/4a4a4a/f5f0eb?text=Slate\nAnthracite', 0),
('a50e8400-e29b-41d4-a716-446655440019', NULL, 'lifestyle',
 'https://placehold.co/800x800/555555/f5f0eb?text=Slate\nModern+Bath', 1),
-- Brookstone Ash LVP
('a50e8400-e29b-41d4-a716-446655440020', NULL, 'primary',
 'https://placehold.co/800x800/c8c0b8/292524?text=Brookstone\nAsh+LVP', 0),
('a50e8400-e29b-41d4-a716-446655440020', NULL, 'alternate',
 'https://placehold.co/800x800/bfb7af/292524?text=Brookstone\nPlank+Detail', 1),
-- Chestnut Ridge LVP
('a50e8400-e29b-41d4-a716-446655440021', NULL, 'primary',
 'https://placehold.co/800x800/9a7b5a/f5f0eb?text=Chestnut\nRidge+LVP', 0),
('a50e8400-e29b-41d4-a716-446655440021', NULL, 'lifestyle',
 'https://placehold.co/800x800/8a6b4a/f5f0eb?text=Chestnut\nBedroom', 1),
-- Calacatta Laza Quartz
('a50e8400-e29b-41d4-a716-446655440022', NULL, 'primary',
 'https://placehold.co/800x800/f5f0eb/292524?text=Calacatta+Laza\nQuartz+Slab', 0),
('a50e8400-e29b-41d4-a716-446655440022', NULL, 'lifestyle',
 'https://placehold.co/800x800/eae4dc/78716c?text=Quartz\nKitchen+Counter', 1),
-- Arctic White Stacked Stone
('a50e8400-e29b-41d4-a716-446655440023', NULL, 'primary',
 'https://placehold.co/800x800/e0ddd8/292524?text=Arctic+White\nStacked+Stone', 0),
('a50e8400-e29b-41d4-a716-446655440023', NULL, 'lifestyle',
 'https://placehold.co/800x800/d8d5d0/78716c?text=Stacked+Stone\nFireplace', 1),
-- European White Oak Herringbone
('a50e8400-e29b-41d4-a716-446655440024', NULL, 'primary',
 'https://placehold.co/800x800/c8b898/292524?text=White+Oak\nHerringbone', 0),
('a50e8400-e29b-41d4-a716-446655440024', NULL, 'lifestyle',
 'https://placehold.co/800x800/bfaf88/78716c?text=Herringbone\nDining+Room', 1)
ON CONFLICT DO NOTHING;

-- ==================== Tri-West Vendor Sources ====================
INSERT INTO vendor_sources (vendor_id, source_type, name, base_url, config, scraper_key, schedule, is_active) VALUES
-- Portal scrapers (hub)
('550e8400-e29b-41d4-a716-446655440008', 'portal', 'Tri-West DNav - Catalog', 'https://tri400.triwestltd.com/danciko/d24', '{"discovery_mode": true}', 'triwest-catalog', '0 2 * * 0', true),
('550e8400-e29b-41d4-a716-446655440008', 'portal', 'Tri-West DNav - Pricing', 'https://tri400.triwestltd.com/danciko/d24', '{}', 'triwest-pricing', '0 3 * * 0', true),
('550e8400-e29b-41d4-a716-446655440008', 'portal', 'Tri-West DNav - Inventory', 'https://tri400.triwestltd.com/danciko/d24', '{"freshness_hours": 8}', 'triwest-inventory', '0 */8 * * *', true),
-- Brand enrichment scrapers (spokes)
('550e8400-e29b-41d4-a716-446655440008', 'website', 'Provenza', 'https://www.provenzafloors.com', '{}', 'triwest-provenza', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'Paradigm', 'https://www.paradigmflooring.net', '{}', 'triwest-paradigm', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'Quick-Step', 'https://www.us.quick-step.com', '{}', 'triwest-quickstep', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'Armstrong', 'https://www.armstrongflooring.com', '{}', 'triwest-armstrong', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'Metroflor', 'https://www.metroflor.com', '{}', 'triwest-metroflor', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'Mirage', 'https://www.miragefloors.com', '{}', 'triwest-mirage', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'California Classics', 'https://www.californiaclassicsfloors.com', '{}', 'triwest-calclassics', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'Grand Pacific', 'https://www.grandpacifichardwood.com', '{}', 'triwest-grandpacific', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'Bravada', 'https://www.bravadahardwood.com', '{}', 'triwest-bravada', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'Hartco', 'https://www.hartco.com', '{}', 'triwest-hartco', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'True Touch', 'https://www.truetouchfloors.com', '{}', 'triwest-truetouch', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'Citywide LVT', 'https://www.citywidelvt.com', '{}', 'triwest-citywide', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'AHF Contract', 'https://www.ahfcontract.com', '{}', 'triwest-ahf', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'Flexco', 'https://www.flexcofloors.com', '{}', 'triwest-flexco', '0 4 1 * *', true),
('550e8400-e29b-41d4-a716-446655440008', 'website', 'Opulux', 'https://www.opuluxfloors.com', '{}', 'triwest-opulux', '0 4 1 * *', true)
ON CONFLICT DO NOTHING;
