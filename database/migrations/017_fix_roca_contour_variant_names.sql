-- Fix Roca Contour variant names: 4 SKUs had identical variant_name
-- "Contour Mesh 8X12 MESH" but represent different colors (Alabaster, Burgundy, Cobalt, Mocha).
-- Color names sourced from rocatileusa.com/collections/contour.

UPDATE skus SET variant_name = 'Contour Alabaster Mesh 8X12 MESH' WHERE id = '8746dfc8-6688-4879-a5b1-e35221a54f05';
UPDATE skus SET variant_name = 'Contour Burgundy Mesh 8X12 MESH' WHERE id = 'c4beae46-73e0-4225-9912-1ffa3582c81c';
UPDATE skus SET variant_name = 'Contour Cobalt Mesh 8X12 MESH' WHERE id = '86fe1273-199c-43c7-a7c2-fcd359bab31e';
UPDATE skus SET variant_name = 'Contour Mocha Mesh 8X12 MESH' WHERE id = '6f134b18-bd19-479d-9003-3ef0d12992b7';
