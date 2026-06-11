/**
 * Siena Decor — Unified Scraper (Price List + Website Images)
 *
 * Primary source: Embedded PRICE_LIST constant (from 2024 FEB Z1 PDF)
 *   - 75 collections, ~300+ field tile products, ~200+ accessories
 *
 * Secondary source: sienadecor.com portfolio pages (WordPress)
 *   - Collection images with per-SKU color labels
 *   - Room scene / lifestyle images
 *
 * Strategy: products/SKUs/pricing/packaging from PRICE_LIST,
 *           images from the website, matched to SKUs by color label.
 *
 * Usage: docker compose exec api node scrapers/siena.js
 */
import pg from 'pg';
import {
  launchBrowser, delay,
  upsertProduct, upsertSku, upsertPricing, upsertPackaging,
  upsertMediaAsset, upsertSkuAttribute,
  isLifestyleUrl, saveProductImages, saveSkuImages,
} from './base.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const BASE_URL = 'https://sienadecor.com';

// ──────────────────────────────────────────────
// PRICE LIST — embedded from 2024 FEB Z1 PDF
// ──────────────────────────────────────────────
// Structure: collection → { desc, origin, material, usage, items[] }
// Items: field tiles have `colors`, accessories have `type`
// unit: 'sf' = per sqft (sell_by box), 'pc' = per piece (sell_by unit), 'sh' = per sheet (sell_by unit)

const PRICE_LIST = {
  'Blancos': {
    desc: 'White body Ceramic Wall tile', origin: 'Spain', material: 'ceramic', usage: 'wall',
    items: [
      { colors: ['Blanco Brillo', 'Palas Blanco Brillo'], size: '12x36', finish: 'Glossy', pcs: 5, sf: 14.52, lbs: 45.10, bxPl: 63, price: 3.79, unit: 'sf' },
      { type: 'bullnose', size: '3x36', pcs: 10, price: 5.99, unit: 'pc' },
    ],
  },
  'Bohemian': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Arena', 'Gris', 'Noce'], size: '6x25', pcs: 28, sf: 10.76, lbs: 39.00, bxPl: 54, price: 4.49, unit: 'sf' },
    ],
  },
  'Borneo': {
    desc: 'Woodlook Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Biondo', 'Natural'], size: '9x47', pcs: 4, sf: 11.62, lbs: 44.09, bxPl: 48, price: 4.49, unit: 'sf' },
    ],
  },
  'Bubble': {
    desc: 'Glossy Ceramic Wall tile', origin: 'Italy', material: 'ceramic', usage: 'wall',
    items: [
      { colors: ['Black', 'Coffee', 'Red', 'White'], size: '4x10', pcs: 44, sf: 11.84, lbs: 31.00, bxPl: 64, price: 12.95, unit: 'sf' },
      { colors: ['Mix Deco'], size: '4x10', pcs: 44, sf: 11.84, lbs: 31.00, bxPl: 64, price: 14.95, unit: 'sf' },
    ],
  },
  'Camber': {
    desc: 'Glossy Ceramic Wall tile', origin: 'Italy', material: 'ceramic', usage: 'wall',
    items: [
      { colors: ['Black', 'Moonlight', 'Taupe'], size: '7x7', pcs: 25, sf: 8.07, lbs: 22.00, bxPl: 80, price: 12.49, unit: 'sf' },
    ],
  },
  'Canet': {
    desc: 'White body Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Gris', 'Marfil'], size: '18x18', pcs: 6, sf: 13.13, lbs: 41.90, bxPl: 48, price: 3.99, unit: 'sf' },
    ],
  },
  'Canvas': {
    desc: 'Ceramic Wall tile', origin: 'Italy', material: 'ceramic', usage: 'wall',
    items: [
      { colors: ['Cenere', 'Terra'], size: '3x12', pcs: 22, sf: 5.16, lbs: 17.70, bxPl: 72, price: 8.99, unit: 'sf' },
      { colors: ['Decoro Mix'], size: '3x12', pcs: 22, sf: 5.16, lbs: 17.70, bxPl: 72, price: 15.99, unit: 'sf' },
    ],
  },
  'Carpet': {
    desc: 'White body Porcelain Floor / Red body Wall tile', origin: 'Spain', material: 'porcelain', usage: 'floor/wall',
    items: [
      { colors: ['Arena', 'Ceniza', 'Granate', 'Marengo'], size: '18x18', pcs: 6, sf: 13.13, lbs: 41.89, bxPl: 48, price: 4.99, unit: 'sf', note: 'Floor' },
      { colors: ['Arena', 'Ceniza'], size: '10x30', pcs: 8, sf: 16.58, lbs: 38.00, bxPl: 48, price: 4.29, unit: 'sf', note: 'Wall' },
      { colors: ['Arena Mix', 'Ceniza Mix'], size: '10x30', pcs: 8, sf: 16.58, lbs: 38.00, bxPl: 48, price: 5.99, unit: 'sf', note: 'Wall Deco' },
      { type: 'bullnose', size: '3x18', pcs: 10, price: 4.99, unit: 'pc' },
    ],
  },
  'Carrara': {
    desc: 'Glossy Wall / Floor tile', origin: 'Spain', material: 'ceramic', usage: 'wall/floor',
    items: [
      { colors: ['Blanco Brillo', 'Gris Brillo'], size: '10x30', finish: 'Glossy', pcs: 8, sf: 16.58, lbs: 38.00, bxPl: 48, price: 4.29, unit: 'sf', note: 'Wall' },
      { colors: ['Blanco'], size: '18x18', pcs: 6, sf: 13.13, lbs: 41.89, bxPl: 48, price: 4.29, unit: 'sf', note: 'Floor' },
      { type: 'london-base', size: '1x10', pcs: 20, price: 2.59, unit: 'pc' },
      { type: 'london-top', size: '1x10', pcs: 20, price: 2.59, unit: 'pc' },
      { type: 'torello', size: '1x10', pcs: 20, price: 2.59, unit: 'pc' },
      { type: 'bullnose', size: '3x10', pcs: 10, price: 4.99, unit: 'pc' },
    ],
  },
  'Cento Per Cento': {
    desc: 'Ceramic Wall tile', origin: 'Italy', material: 'ceramic', usage: 'wall',
    items: [
      { colors: ['Cenere', 'Cocco', 'Ferro', 'Fumo', 'Muschio', 'Notte', 'Pepe', 'Ruggine', 'Zucca'], size: '3x12', pcs: 22, sf: 5.16, lbs: 17.70, bxPl: 72, price: 7.99, unit: 'sf' },
    ],
  },
  'Chic': {
    desc: 'Ceramic Wall tile', origin: 'Spain', material: 'ceramic', usage: 'wall',
    items: [
      { colors: ['Cotton', 'Grey'], size: '10x30', pcs: 8, sf: 16.58, lbs: 38.00, bxPl: 48, price: 4.69, unit: 'sf' },
      { type: 'bullnose', size: '3x10', pcs: 10, price: 4.99, unit: 'pc' },
    ],
  },
  'Circe': {
    desc: 'Rectified White body Wall/Floor tile', origin: 'Spain', material: 'porcelain', usage: 'wall/floor',
    items: [
      { colors: ['Perla Natural', 'Perla Pulido'], size: '12x36', pcs: 5, sf: 14.52, lbs: 48.50, bxPl: 48, price: 6.29, unit: 'sf' },
      { type: 'mosaic', label: 'Perla Mosaico', size: '2x2', pcs: 10, sf: 10.76, lbs: 39.60, price: 12.99, unit: 'sh' },
      { type: 'bullnose', size: '3x36', pcs: 10, price: 7.49, unit: 'pc' },
    ],
  },
  'Color Collection': {
    desc: 'Ceramic Wall tile', origin: 'Brazil', material: 'ceramic', usage: 'wall',
    items: [
      { colors: ['Tender Grey', 'White Ice'], size: '4x4', pcs: 100, sf: 11.11, lbs: 26.45, bxPl: 80, price: 6.49, unit: 'sf' },
      { colors: ['Tender Grey', 'White Ice'], size: '6x6', pcs: 44, sf: 10.76, lbs: 26.45, bxPl: 64, price: 5.49, unit: 'sf' },
      { colors: ['Tender Grey', 'White Ice'], size: '3x6', pcs: 44, sf: 5.38, lbs: 14.99, bxPl: 100, price: 5.49, unit: 'sf' },
      { colors: ['Tender Grey', 'White Ice'], size: '4x16', pcs: 11, sf: 4.83, lbs: 13.84, bxPl: 100, price: 5.99, unit: 'sf' },
      { type: 'bullnose', size: '3x6', pcs: 44, price: 2.79, unit: 'pc' },
      { type: 'quarter-round', size: '1x6', pcs: 36, price: 1.39, unit: 'pc' },
      { type: 'corner', size: '1x1', pcs: 12, price: 1.49, unit: 'pc' },
    ],
  },
  'Colorgloss': {
    desc: 'Ceramic Wall tile', origin: 'Spain', material: 'ceramic', usage: 'wall',
    items: [
      { colors: ['Black', 'Black & White'], size: '10x30', pcs: 8, sf: 16.58, lbs: 38.00, bxPl: 48, price: 4.69, unit: 'sf' },
      { colors: ['White'], size: '10x30', pcs: 8, sf: 16.58, lbs: 38.00, bxPl: 48, price: 4.29, unit: 'sf' },
      { type: 'bullnose', size: '3x10', pcs: 10, price: 4.99, unit: 'pc' },
    ],
  },
  'Corina': {
    desc: 'Polished/Matte Porcelain tile', origin: 'Vietnam', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Brown Polished', 'Grey Polished', 'Pearl Polished'], size: '24x24', pcs: 4, sf: 16.00, lbs: 55.12, bxPl: 40, price: 3.49, unit: 'sf' },
      { colors: ['Brown Polished', 'Grey Polished', 'Pearl Polished'], size: '12x24', pcs: 8, sf: 16.00, lbs: 55.12, bxPl: 40, price: 3.49, unit: 'sf' },
      { colors: ['Grey Matte'], size: '12x24', pcs: 8, sf: 16.00, lbs: 55.12, bxPl: 40, price: 2.99, unit: 'sf' },
      { colors: ['Grey Matte'], size: '24x24', pcs: 4, sf: 16.00, lbs: 55.12, bxPl: 40, price: 2.99, unit: 'sf' },
      { type: 'bullnose', size: '3x24', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Country': {
    desc: 'Ceramic Wall tile', origin: 'Spain', material: 'ceramic', usage: 'wall',
    items: [
      { colors: ['Almond', 'Azure', 'Blue', 'Dark Grey', 'Grafito', 'Green', 'Grey', 'Mostaza', 'Musgo', 'Natural', 'Red', 'Sky Blue', 'Snow', 'White'], size: '2.5x8', pcs: 46, sf: 6.24, lbs: 17.92, bxPl: 96, price: 7.49, unit: 'sf' },
      { colors: ['Almond', 'Azure', 'Blue', 'Dark Grey', 'Grafito', 'Green', 'Grey', 'Mostaza', 'Natural', 'Red', 'Sky Blue', 'Snow', 'White'], size: '2.5x16', pcs: 9, sf: 2.50, lbs: 7.56, bxPl: 180, price: 8.49, unit: 'sf' },
      { type: 'london-base', size: '1x8', pcs: 20, price: 2.29, unit: 'pc' },
      { type: 'london-top', size: '1x8', pcs: 20, price: 2.29, unit: 'pc' },
      { type: 'quarter-round', size: '1x8', pcs: 20, price: 2.29, unit: 'pc' },
      { type: 'corner-qr', size: '1x1', pcs: 2, price: 2.79, unit: 'pc' },
      { type: 'jolly', size: '0.5x8', pcs: 20, price: 2.29, unit: 'pc' },
      { type: 'torello', size: '1x8', pcs: 20, price: 2.29, unit: 'pc' },
    ],
  },
  'Crosswood': {
    desc: 'Woodlook Color body Porcelain tile', origin: 'Italy', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Bone', 'Buff', 'Cinder', 'Dust'], size: '8x48', pcs: 4, sf: 10.33, lbs: 39.68, bxPl: 48, price: 6.49, unit: 'sf' },
      { type: 'bullnose', size: '4x48', pcs: 3, price: 8.99, unit: 'pc' },
    ],
  },
  'Daino': {
    desc: 'Glossy Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor/wall',
    items: [
      { colors: ['Crema Brillo', 'Gris Brillo'], size: '12x24', finish: 'Glossy', pcs: 8, sf: 15.50, lbs: 52.91, bxPl: 40, price: 4.49, unit: 'sf' },
      { colors: ['Crema Natural', 'Gris Natural'], size: '12x24', finish: 'Matte', pcs: 8, sf: 15.50, lbs: 52.91, bxPl: 40, price: 4.49, unit: 'sf' },
      { colors: ['Crema Natural'], size: '18x18', finish: 'Matte', pcs: 6, sf: 13.13, lbs: 46.30, bxPl: 48, price: 3.99, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
      { type: 'mosaic', label: 'Crema Mosaico', size: '2x2', pcs: 10, sf: 10.76, lbs: 39.60, price: 9.99, unit: 'sh' },
    ],
  },
  'De Brick': {
    desc: 'Ceramic Wall tile', origin: 'Brazil', material: 'ceramic', usage: 'wall',
    items: [
      { colors: ['Black Matte', 'White Glossy', 'White Matte'], size: '2.5x8', pcs: 44, sf: 5.38, lbs: 14.99, bxPl: 100, price: 6.99, unit: 'sf' },
    ],
  },
  'Devon': {
    desc: 'White body Porcelain Floor / Red body Wall tile', origin: 'Spain', material: 'porcelain', usage: 'floor/wall',
    items: [
      { colors: ['Grey', 'Taupe'], size: '13x13', pcs: 12, sf: 14.53, lbs: 44.00, bxPl: 44, price: 3.99, unit: 'sf', note: 'Floor' },
      { colors: ['Grey', 'Taupe'], size: '10x30', pcs: 8, sf: 16.58, lbs: 38.00, bxPl: 48, price: 4.29, unit: 'sf', note: 'Wall' },
      { colors: ['Grey Decor', 'Taupe Decor'], size: '10x30', pcs: 8, sf: 16.58, lbs: 38.00, bxPl: 48, price: 5.99, unit: 'sf', note: 'Wall Deco' },
      { type: 'bullnose', size: '3x10', pcs: 10, price: 4.99, unit: 'pc' },
    ],
  },
  'Dimsey': {
    desc: 'Ceramic Wall tile', origin: 'Spain', material: 'ceramic', usage: 'wall',
    items: [
      { colors: ['Gris', 'Sage', 'White'], size: '2.6x13', pcs: 40, sf: 8.87, lbs: 27.80, bxPl: 72, price: 8.99, unit: 'sf', note: 'Flat' },
      { colors: ['Gris', 'Sage', 'White'], size: '2.6x13', pcs: 40, sf: 8.87, lbs: 27.80, bxPl: 72, price: 8.99, unit: 'sf', note: 'Textured' },
      { type: 'jolly', size: '0.4x13', pcs: 20, price: 3.49, unit: 'pc' },
    ],
  },
  'Ecoluxe': {
    desc: 'Glossy Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'wall',
    items: [
      { colors: ['White Brillo'], size: '12x36', finish: 'Glossy', pcs: 5, sf: 14.52, lbs: 45.10, bxPl: 63, price: 5.99, unit: 'sf' },
      { type: 'bullnose', size: '3x36', pcs: 10, price: 7.49, unit: 'pc' },
    ],
  },
  'Elementi': {
    desc: 'Color body Porcelain tile', origin: 'Italy', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Tobacco'], size: '12x24', pcs: 6, sf: 11.62, lbs: 43.65, bxPl: 40, price: 5.99, unit: 'sf' },
      { colors: ['Tobacco Decoro'], size: '12x24', pcs: 6, sf: 11.62, lbs: 43.65, bxPl: 40, price: 7.99, unit: 'sf' },
      { type: 'bullnose', size: '3x24', pcs: 12, price: 5.99, unit: 'pc' },
      { type: 'mosaic', label: 'Tobacco Mosaico', size: '2x2', pcs: 6, sf: 6.46, lbs: 26.46, price: 12.99, unit: 'sh' },
      { type: 'mosaic', label: 'Tobacco Mosaico', size: '2x6', pcs: 6, sf: 6.46, lbs: 26.46, price: 12.99, unit: 'sh' },
    ],
  },
  'Factory': {
    desc: 'Through body Porcelain tile', origin: 'Italy', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Avorio', 'Cenere', 'Ferro', 'Polvere', 'Sabbia'], size: '12x24', pcs: 6, sf: 11.62, lbs: 43.65, bxPl: 40, price: 5.99, unit: 'sf' },
      { colors: ['Avorio', 'Cenere', 'Ferro', 'Polvere', 'Sabbia'], size: '24x24', pcs: 4, sf: 15.50, lbs: 55.12, bxPl: 30, price: 5.99, unit: 'sf' },
      { colors: ['Avorio', 'Cenere', 'Ferro', 'Sabbia'], size: '24x48', pcs: 2, sf: 15.83, lbs: 55.12, bxPl: 24, price: 7.49, unit: 'sf' },
      { type: 'bullnose', size: '3x24', pcs: 12, price: 5.99, unit: 'pc' },
      { type: 'mosaic', label: 'Mosaico', size: '2x2', pcs: 6, sf: 6.46, lbs: 26.46, price: 12.99, unit: 'sh' },
      { type: 'mosaic', label: 'Mosaico', size: '2x6', pcs: 6, sf: 6.46, lbs: 26.46, price: 12.99, unit: 'sh' },
    ],
  },
  'Factoryhex': {
    desc: 'Elongated Hexagon Color body Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Cendra', 'Cream', 'Grafito', 'Taupe', 'White'], size: '9x10', pcs: 20, sf: 11.19, lbs: 37.48, bxPl: 54, price: 6.99, unit: 'sf' },
    ],
  },
  'Flagstone': {
    desc: 'Color body Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Borgona', 'Canyon', 'Esla', 'Filita'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
    ],
  },
  'Forest': {
    desc: 'Woodlook Rectified Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Greige', 'Silver', 'Walnut', 'White'], size: '8x48', pcs: 5, sf: 12.92, lbs: 45.20, bxPl: 36, price: 5.49, unit: 'sf' },
    ],
  },
  'Formworks': {
    desc: 'Semi-Polished Color body Porcelain tile', origin: 'Italy', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Cenere', 'Ferro'], size: '24x24', pcs: 4, sf: 15.50, lbs: 55.12, bxPl: 30, price: 6.99, unit: 'sf' },
      { type: 'liner', label: 'Stainless Steel Strip', size: '1.5x24', pcs: 1, price: 6.99, unit: 'pc' },
    ],
  },
  'Fossil': {
    desc: 'Woodlook Color body Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Beige', 'Smoke'], size: '10x40', pcs: 7, sf: 18.83, lbs: 55.00, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x40', pcs: 10, price: 5.99, unit: 'pc' },
      { type: 'mosaic', label: 'Mosaico', size: '2x2', pcs: 10, sf: 10.76, lbs: 39.60, price: 9.99, unit: 'sh' },
    ],
  },
  'Garda': {
    desc: 'Porcelain tile', origin: 'Italy', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Bianco', 'Grafito', 'Gris'], size: '12x24', pcs: 6, sf: 11.62, lbs: 43.65, bxPl: 40, price: 5.99, unit: 'sf' },
      { colors: ['Bianco', 'Grafito', 'Gris'], size: '24x24', pcs: 4, sf: 15.50, lbs: 55.12, bxPl: 30, price: 5.99, unit: 'sf' },
      { type: 'bullnose', size: '3x24', pcs: 12, price: 5.99, unit: 'pc' },
      { type: 'mosaic', label: 'Mosaico', size: '2x2', pcs: 6, sf: 6.46, lbs: 26.46, price: 12.99, unit: 'sh' },
    ],
  },
  'Geoblanco': {
    desc: 'Glossy Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'wall',
    items: [
      { colors: ['Blanco Brillo'], size: '12x36', finish: 'Glossy', pcs: 5, sf: 14.52, lbs: 45.10, bxPl: 63, price: 5.49, unit: 'sf' },
      { colors: ['Blanco Natural'], size: '12x36', finish: 'Matte', pcs: 5, sf: 14.52, lbs: 45.10, bxPl: 63, price: 5.49, unit: 'sf' },
      { colors: ['Geo Brillo'], size: '12x36', finish: 'Glossy', pcs: 5, sf: 14.52, lbs: 45.10, bxPl: 63, price: 6.99, unit: 'sf' },
      { type: 'bullnose', size: '3x36', pcs: 10, price: 7.49, unit: 'pc' },
    ],
  },
  'H-Stone': {
    desc: 'Color body Porcelain tile', origin: 'Italy', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Dark Beige', 'Dark Grey', 'Light Grey'], size: '12x24', pcs: 6, sf: 11.62, lbs: 43.65, bxPl: 40, price: 5.49, unit: 'sf' },
      { type: 'bullnose', size: '3x24', pcs: 12, price: 5.99, unit: 'pc' },
      { type: 'mosaic', label: 'Dark Beige Mosaico', size: '2x2', pcs: 6, sf: 6.46, lbs: 26.46, price: 12.99, unit: 'sh' },
      { type: 'mosaic', label: 'Dark Grey Mosaico', size: '2x2', pcs: 6, sf: 6.46, lbs: 26.46, price: 12.99, unit: 'sh' },
      { type: 'mosaic', label: 'Mix Beige-Grey Mosaico', size: '2x2', pcs: 6, sf: 6.46, lbs: 26.46, price: 14.99, unit: 'sh' },
    ],
  },
  'Hexagon': {
    desc: 'Color body Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Black', 'Gris', 'White'], size: '8x10', pcs: 20, sf: 10.76, lbs: 35.27, bxPl: 60, price: 5.99, unit: 'sf' },
    ],
  },
  'Industrial': {
    desc: 'Ceramic Wall tile', origin: 'Spain', material: 'ceramic', usage: 'wall',
    items: [
      { colors: ['Grey', 'White'], size: '4x8', pcs: 46, sf: 9.89, lbs: 27.80, bxPl: 72, price: 6.99, unit: 'sf' },
      { colors: ['Deco Grey', 'Deco White'], size: '4x8', pcs: 46, sf: 9.89, lbs: 27.80, bxPl: 72, price: 9.99, unit: 'sf' },
    ],
  },
  'Kehl': {
    desc: 'Color body Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Beige', 'Black', 'Grey'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.99, unit: 'sf' },
      { type: 'liner', label: 'Stainless Steel Strip', size: '0.5x24', pcs: 1, price: 4.99, unit: 'pc' },
      { type: 'liner', label: 'Stainless Steel Strip', size: '1.5x24', pcs: 1, price: 6.99, unit: 'pc' },
    ],
  },
  'Ledgestone': {
    desc: 'White body Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'wall',
    items: [
      { colors: ['British Bone', 'British Gris'], size: '6x21', pcs: 14, sf: 11.32, lbs: 40.79, bxPl: 60, price: 6.49, unit: 'sf' },
    ],
  },
  'Levante': {
    desc: 'White body Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'wall',
    items: [
      { colors: ['Gris', 'Iceberg', 'Marfil'], size: '12x36', finish: 'Matte', pcs: 5, sf: 14.52, lbs: 45.10, bxPl: 63, price: 5.49, unit: 'sf' },
      { colors: ['Deco Blanco'], size: '12x36', pcs: 5, sf: 14.52, lbs: 45.10, bxPl: 63, price: 7.99, unit: 'sf' },
      { type: 'bullnose', size: '3x36', pcs: 10, price: 7.49, unit: 'pc' },
    ],
  },
  'Limestone': {
    desc: 'White body Porcelain tile', origin: 'Italy', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Ash', 'Beige', 'Coal'], size: '12x24', pcs: 6, sf: 11.62, lbs: 43.65, bxPl: 40, price: 5.49, unit: 'sf' },
      { type: 'bullnose', size: '3x24', pcs: 12, price: 5.99, unit: 'pc' },
      { type: 'mosaic', label: 'Beige Mosaico', size: '2x2', pcs: 6, sf: 6.46, lbs: 26.46, price: 12.99, unit: 'sh' },
    ],
  },
  'Look Kliff': {
    desc: 'Wall tile', origin: 'Spain', material: 'ceramic', usage: 'wall',
    items: [
      { colors: ['Greige', 'Pearl', 'Sand'], size: '12x36', pcs: 5, sf: 14.52, lbs: 45.10, bxPl: 63, price: 5.49, unit: 'sf' },
      { type: 'bullnose', size: '3x36', pcs: 10, price: 7.49, unit: 'pc' },
    ],
  },
  'Lux': {
    desc: 'Porcelain tile', origin: 'India', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Crema Polished', 'Grey Polished', 'White Polished'], size: '24x24', finish: 'Polished', pcs: 4, sf: 16.00, lbs: 55.12, bxPl: 40, price: 3.99, unit: 'sf' },
    ],
  },
  'Madison': {
    desc: 'White body Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor/wall',
    items: [
      { colors: ['Bone', 'Grey'], size: '12x24', pcs: 8, sf: 15.50, lbs: 52.91, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x24', pcs: 15, price: 4.99, unit: 'pc' },
      { type: 'mosaic', label: 'Bone Mosaico', size: '2x2', pcs: 10, sf: 10.76, lbs: 39.60, price: 9.99, unit: 'sh' },
    ],
  },
  'Marble Carrara': {
    desc: 'Porcelain Wall tile', origin: 'Spain', material: 'porcelain', usage: 'wall',
    items: [
      { colors: ['Blanco Brillo'], size: '10x30', finish: 'Glossy', pcs: 8, sf: 16.58, lbs: 38.00, bxPl: 48, price: 5.49, unit: 'sf' },
      { colors: ['Hexagon Brillo'], size: '10x11', pcs: 14, sf: 9.80, lbs: 29.76, bxPl: 60, price: 7.99, unit: 'sf' },
      { colors: ['Ondas Brillo'], size: '10x30', finish: 'Glossy', pcs: 8, sf: 16.58, lbs: 38.00, bxPl: 48, price: 6.99, unit: 'sf' },
      { type: 'bullnose', size: '3x10', pcs: 10, price: 5.99, unit: 'pc' },
    ],
  },
  'Marmo': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor/wall',
    items: [
      { colors: ['Blanco Brillo', 'Gris Brillo'], size: '10x30', finish: 'Glossy', pcs: 8, sf: 16.58, lbs: 38.00, bxPl: 48, price: 4.99, unit: 'sf', note: 'Wall' },
      { colors: ['Blanco Natural', 'Gris Natural'], size: '18x18', finish: 'Matte', pcs: 6, sf: 13.13, lbs: 41.89, bxPl: 48, price: 4.49, unit: 'sf', note: 'Floor' },
      { type: 'bullnose', size: '3x10', pcs: 10, price: 4.99, unit: 'pc' },
    ],
  },
  'Marquina': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor/wall',
    items: [
      { colors: ['Black Polished'], size: '12x24', finish: 'Polished', pcs: 8, sf: 15.50, lbs: 52.91, bxPl: 40, price: 5.99, unit: 'sf' },
      { colors: ['Black Natural'], size: '12x24', finish: 'Matte', pcs: 8, sf: 15.50, lbs: 52.91, bxPl: 40, price: 5.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 5.99, unit: 'pc' },
    ],
  },
  'Mash-Up': {
    desc: 'Color body Porcelain tile', origin: 'Italy', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Graphite'], size: '12x24', pcs: 6, sf: 11.62, lbs: 43.65, bxPl: 40, price: 5.99, unit: 'sf' },
      { colors: ['Graphite'], size: '24x24', pcs: 4, sf: 15.50, lbs: 55.12, bxPl: 30, price: 5.99, unit: 'sf' },
    ],
  },
  'Materica': {
    desc: 'Porcelain tile', origin: 'Italy', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Cenere', 'Sabbia'], size: '12x24', pcs: 6, sf: 11.62, lbs: 43.65, bxPl: 40, price: 5.99, unit: 'sf' },
      { colors: ['Cenere', 'Sabbia'], size: '24x24', pcs: 4, sf: 15.50, lbs: 55.12, bxPl: 30, price: 5.99, unit: 'sf' },
      { type: 'bullnose', size: '3x24', pcs: 12, price: 5.99, unit: 'pc' },
      { type: 'mosaic', label: 'Mosaico', size: '2x2', pcs: 6, sf: 6.46, lbs: 26.46, price: 12.99, unit: 'sh' },
    ],
  },
  'Monochrome Wave': {
    desc: 'Porcelain Wall tile', origin: 'Spain', material: 'porcelain', usage: 'wall',
    items: [
      { colors: ['White Brillo'], size: '12x36', finish: 'Glossy', pcs: 5, sf: 14.52, lbs: 45.10, bxPl: 63, price: 6.49, unit: 'sf' },
    ],
  },
  'Nativa': {
    desc: 'Color body Porcelain tile', origin: 'Italy', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Avorio', 'Cenere', 'Grafito', 'Perla'], size: '12x24', pcs: 6, sf: 11.62, lbs: 43.65, bxPl: 40, price: 5.99, unit: 'sf' },
      { colors: ['Avorio', 'Cenere', 'Grafito', 'Perla'], size: '24x24', pcs: 4, sf: 15.50, lbs: 55.12, bxPl: 30, price: 5.99, unit: 'sf' },
      { type: 'bullnose', size: '3x24', pcs: 12, price: 5.99, unit: 'pc' },
      { type: 'mosaic', label: 'Mosaico', size: '2x2', pcs: 6, sf: 6.46, lbs: 26.46, price: 12.99, unit: 'sh' },
    ],
  },
  'Nolan': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Bianco', 'Grey', 'Miele', 'Natural'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.99, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Opal': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor/wall',
    items: [
      { colors: ['Beige Polished', 'Grey Polished'], size: '24x24', finish: 'Polished', pcs: 4, sf: 16.00, lbs: 55.12, bxPl: 40, price: 4.99, unit: 'sf' },
      { colors: ['Beige Natural', 'Grey Natural'], size: '12x24', finish: 'Matte', pcs: 8, sf: 15.50, lbs: 52.91, bxPl: 40, price: 4.49, unit: 'sf' },
      { colors: ['Beige Natural', 'Grey Natural'], size: '24x24', finish: 'Matte', pcs: 4, sf: 16.00, lbs: 55.12, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
      { type: 'mosaic', label: 'Beige Mosaico', size: '2x2', pcs: 10, sf: 10.76, lbs: 39.60, price: 11.99, unit: 'sh' },
    ],
  },
  'Orchestra': {
    desc: 'Color body Porcelain tile', origin: 'Italy', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Arena', 'Cenere', 'Grafito', 'Sand'], size: '12x24', pcs: 6, sf: 11.62, lbs: 43.65, bxPl: 40, price: 5.99, unit: 'sf' },
      { type: 'bullnose', size: '3x24', pcs: 12, price: 5.99, unit: 'pc' },
      { type: 'mosaic', label: 'Mosaico', size: '2x2', pcs: 6, sf: 6.46, lbs: 26.46, price: 12.99, unit: 'sh' },
    ],
  },
  'Orlando': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Cream', 'White'], size: '18x18', pcs: 6, sf: 13.13, lbs: 41.89, bxPl: 48, price: 3.99, unit: 'sf' },
      { type: 'bullnose', size: '3x18', pcs: 10, price: 4.99, unit: 'pc' },
    ],
  },
  'Oxford 948': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Bone', 'Grey', 'Taupe'], size: '9x48', pcs: 4, sf: 11.62, lbs: 44.09, bxPl: 48, price: 5.49, unit: 'sf' },
    ],
  },
  'Paddington': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Black', 'Grey', 'Navy Blue', 'Putty', 'White'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Patchwork': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Color'], size: '18x18', pcs: 6, sf: 13.13, lbs: 41.89, bxPl: 48, price: 4.99, unit: 'sf' },
    ],
  },
  'Peak': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Dark', 'Gris', 'Medium', 'Tropical', 'White'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Picket': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'wall',
    items: [
      { colors: ['White'], size: '3x12', pcs: 40, sf: 9.69, lbs: 34.00, bxPl: 72, price: 6.49, unit: 'sf' },
    ],
  },
  'Pierre': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Bone', 'Grey', 'Sand'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Pietra': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor/wall',
    items: [
      { colors: ['Bone', 'Grey'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { colors: ['Bone Decor', 'Grey Decor'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 5.99, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Powder': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Bone', 'Grey', 'Sand'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.99, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Pulpis': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor/wall',
    items: [
      { colors: ['Gris Polished'], size: '12x24', finish: 'Polished', pcs: 8, sf: 15.50, lbs: 52.91, bxPl: 40, price: 5.99, unit: 'sf' },
      { colors: ['Gris Natural'], size: '12x24', finish: 'Matte', pcs: 8, sf: 15.50, lbs: 52.91, bxPl: 40, price: 5.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 5.99, unit: 'pc' },
    ],
  },
  'Rock': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Bone', 'Grey', 'Sand'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Romani': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Bone', 'Grey', 'Sand'], size: '13x13', pcs: 12, sf: 14.53, lbs: 44.00, bxPl: 44, price: 3.99, unit: 'sf' },
    ],
  },
  'Sabina': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Bone', 'Grey'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Saverne': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Bone', 'Grey', 'Sand'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Selkis': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Beige', 'Grey'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Stony': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Bone', 'Grey'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Super White': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor/wall',
    items: [
      { colors: ['Super White Polished'], size: '24x24', finish: 'Polished', pcs: 4, sf: 16.00, lbs: 55.12, bxPl: 40, price: 4.49, unit: 'sf' },
      { colors: ['Super White Polished'], size: '12x24', finish: 'Polished', pcs: 8, sf: 15.50, lbs: 52.91, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x24', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Terra': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Beige', 'Grey', 'Sand'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Terrazo': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Grey', 'White'], size: '24x24', pcs: 4, sf: 16.00, lbs: 55.12, bxPl: 40, price: 4.99, unit: 'sf' },
    ],
  },
  'Timeless': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Beige', 'Grey'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Torp': {
    desc: 'Woodlook Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Grey', 'Moka', 'Natural', 'White'], size: '8x48', pcs: 5, sf: 12.92, lbs: 45.20, bxPl: 36, price: 5.49, unit: 'sf' },
    ],
  },
  'Toulouse': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Beige', 'Grey', 'Sand'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Victorian': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Avorio', 'Bianco', 'Blue', 'Nero', 'Perla', 'Porpora', 'Tortora'], size: '10x10', pcs: 44, sf: 10.76, lbs: 35.27, bxPl: 60, price: 6.99, unit: 'sf' },
      { colors: ['Deco Blue Perla', 'Deco Tortora Avorio'], size: '10x10', pcs: 44, sf: 10.76, lbs: 35.27, bxPl: 60, price: 8.99, unit: 'sf' },
    ],
  },
  'Viena': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor/wall',
    items: [
      { colors: ['Beige', 'Grey', 'Sand'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Vinyle': {
    desc: 'Woodlook Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Brown', 'Grey', 'Natural'], size: '8x48', pcs: 5, sf: 12.92, lbs: 45.20, bxPl: 36, price: 5.49, unit: 'sf' },
    ],
  },
  'Vulcani': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Avorio', 'Bianco', 'Grigio', 'Multicolor'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.99, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Wales': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor',
    items: [
      { colors: ['Beige', 'Grey'], size: '12x24', pcs: 7, sf: 13.56, lbs: 45.20, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
  'Zafiro': {
    desc: 'Porcelain tile', origin: 'Spain', material: 'porcelain', usage: 'floor/wall',
    items: [
      { colors: ['Beige Polished', 'Grey Polished'], size: '24x24', finish: 'Polished', pcs: 4, sf: 16.00, lbs: 55.12, bxPl: 40, price: 4.99, unit: 'sf' },
      { colors: ['Beige Natural', 'Grey Natural'], size: '12x24', finish: 'Matte', pcs: 8, sf: 15.50, lbs: 52.91, bxPl: 40, price: 4.49, unit: 'sf' },
      { type: 'bullnose', size: '3x12', pcs: 15, price: 4.99, unit: 'pc' },
    ],
  },
};

// ──────────────────────────────────────────────
// Website slug mapping — collection name → portfolio-items slug
// ──────────────────────────────────────────────

const COLLECTION_SLUG_MAP = {
  'Blancos': 'blancos',
  'Bohemian': 'bohemian',
  'Borneo': 'borneo',
  'Bubble': 'bubble',
  'Camber': 'camber',
  'Canet': 'canet',
  'Canvas': 'canvas',
  'Carpet': 'carpet',
  'Carrara': 'carrara',
  'Cento Per Cento': 'cento-per-cento',
  'Chic': 'chic',
  'Circe': 'circe',
  'Color Collection': 'color-collection',
  'Colorgloss': 'colorgloss',
  'Corina': 'corina',
  'Country': 'country',
  'Crosswood': 'cross-wood',
  'Daino': 'daino',
  'De Brick': 'de-brick',
  'Devon': 'devon',
  'Dimsey': 'dimsey',
  'Ecoluxe': 'ecoluxe',
  'Elementi': 'elementi',
  'Factory': 'factory',
  'Factoryhex': 'factoryhex',
  'Flagstone': 'flagstone',
  'Forest': 'forest',
  'Formworks': 'formworks',
  'Fossil': 'fossil',
  'Garda': 'garda',
  'Geoblanco': 'geoblanco',
  'H-Stone': 'h-stone',
  'Hexagon': 'hexagon',
  'Industrial': 'industrial',
  'Kehl': 'kehl',
  'Ledgestone': 'ledgestone',
  'Levante': 'levante',
  'Limestone': 'limestone',
  'Look Kliff': 'look-kliff',
  'Lux': 'lux',
  'Madison': 'madison',
  'Marble Carrara': 'marble-carrara',
  'Marmo': 'marmo',
  'Marquina': 'marquina',
  'Mash-Up': 'mash-up',
  'Materica': 'materica',
  'Monochrome Wave': 'monochrome-wave',
  'Nativa': 'nativa',
  'Nolan': 'nolan',
  'Opal': 'opal',
  'Orchestra': 'orchestra',
  'Orlando': 'orlando',
  'Oxford 948': 'oxford',
  'Paddington': 'paddington',
  'Patchwork': 'patchwork',
  'Peak': 'peak',
  'Picket': 'picket',
  'Pierre': 'pierre',
  'Pietra': 'pietra',
  'Powder': 'powder',
  'Pulpis': 'pulpis',
  'Rock': 'rock',
  'Romani': 'romani',
  'Sabina': 'sabina',
  'Saverne': 'saverne',
  'Selkis': 'selkis',
  'Stony': 'stony',
  'Super White': 'super-white',
  'Terra': 'terra',
  'Terrazo': 'terrazo',
  'Timeless': 'timeless',
  'Torp': 'torp',
  'Toulouse': 'toulouse',
  'Victorian': 'victorian',
  'Viena': 'viena',
  'Vinyle': 'vinyle',
  'Vulcani': 'vulcani',
  'Wales': 'wales',
  'Zafiro': 'zafiro',
};

// ──────────────────────────────────────────────
// Website caption → PRICE_LIST color mapping
// For collections where the website uses different color names
// ──────────────────────────────────────────────

// Explicit caption→color mappings for collections where website labels differ
// from PRICE_LIST color names. Only confident mappings — better no image than wrong.
// IMPORTANT: Do NOT map decorative captions (Deco/Fibre/Inlay/Bend/Grid) to
// plain-tile colors. Only map deco→deco or plain→plain.
const CAPTION_TO_COLOR = {
  'Bohemian': {
    'Sand Natural': 'Arena',
  },
  'Borneo': {
    'STRAW': 'Biondo',
  },
  'Bubble': {
    // Plain tiles now match PRICE_LIST directly (Black, Coffee, Red, White)
    // All deco variants → Mix Deco (deco→deco)
    'Black Decor': 'Mix Deco', 'Red Decor': 'Mix Deco',
    'Coffee Decor': 'Mix Deco', 'White Decor': 'Mix Deco',
    'Gold Decor': 'Mix Deco', 'Platinum Decor': 'Mix Deco',
    'CofFee Time Decor': 'Mix Deco', 'Tea Decor': 'Mix Deco',
    'Mr Decor': 'Mix Deco', 'Mrs Decor': 'Mix Deco',
  },
  'Camber': {
    // Plain tiles now match PRICE_LIST directly (Black, Moonlight, Taupe)
  },
  'Canet': {
    'BEIGE': 'Marfil',
    'JET GRIS': 'Gris',
  },
  'Canvas': {
    'Argento': 'Cenere', 'Avio': 'Cenere', 'Perla': 'Cenere',
    'Corda': 'Terra', 'Tobacco': 'Terra',
  },
  'Carpet': {
    'CARPET SAND 24\u00d740': 'Arena', 'CARPET SAND 10\u00d730': 'Arena',
  },
  'Carrara': {
    'CARRARA (Flat)': 'Blanco Brillo',
    'CARRARA (Ondas)': 'Blanco',
  },
  'Cento Per Cento': {
    'GREY': 'Fumo', 'DARK GREY': 'Notte', 'DARK BROWN': 'Pepe', 'YELLOW': 'Zucca',
    'CACAO  GREY': 'Fumo', 'CACAO DARK GREY': 'Notte',
    'CACAO  DARK BROWN': 'Pepe', 'CACAO  YELLOW': 'Zucca',
    // Alternate spacing (website sometimes has single space)
    'CACAO GREY': 'Fumo', 'CACAO DARK BROWN': 'Pepe', 'CACAO YELLOW': 'Zucca',
  },
  'Circe': {
    'CREMA MARFIL': 'Perla Pulido',
    'CREMA MARFIL RELIEVE': 'Perla Natural',
  },
  'Color Collection': {
    'WHITE GLOSSY 6 X 18': 'White Ice', 'WHITE GLOSSY 4 1/4 X 16': 'White Ice',
    'WHITE GLOSSY 4 1/4 X 10': 'White Ice', 'WHITE GLOSSY 3 X 6': 'White Ice',
    'WHITE GLOSSY  4 1/4 X 4 1/4 , 3 X 3, 6 X 6': 'White Ice',
  },
  'Crosswood': {
    // Plain tiles now match PRICE_LIST directly (Bone, Buff, Cinder, Dust)
  },
  'Country': {
    'ANTHRACITE': 'Dark Grey',
    'ASH BLUE': 'Azure',
    'BLANCO': 'White',
    'GRAPHITE': 'Grafito',
    'GREY PEARL': 'Grey',
    'GRIS CLARO': 'Grey',
    'IVORY': 'Almond',
    'MIST GREEN': 'Green',
    'TOBACCO': 'Natural',
  },
  'Daino': {
    'CREMA ONDAS': 'Crema Brillo',
    'MARFIL ONDAS': 'Crema Natural',
  },
  'De Brick': {
    'CAMBRIDGE WHITE': 'White Glossy', 'LUTON WHITE': 'White Matte',
    'LUTON ASH': 'Black Matte',
    'YORKSHIRE LIGHT': 'White Glossy',
  },
  'Devon': {
    // Inlay = decorative pattern → map to Decor variants
    'INLAY GREY': 'Grey Decor', 'INLAY TAUPE': 'Taupe Decor',
  },
  'Dimsey': {
    'Antrahite': 'Gris', 'Antrachite 3D': 'Gris', 'Grey': 'Gris', 'Grey 3D': 'Gris',
    'Jade': 'Sage', 'Jade 3D': 'Sage',
    'White': 'White', 'White 3D': 'White',
  },
  'Elementi': {
    'BERLIN': 'Tobacco', 'LONDON': 'Tobacco', 'NEW YORK': 'Tobacco Decoro',
    'PARIS': 'Tobacco Decoro', 'RIO DE JANEIRO': 'Tobacco', 'ROMA': 'Tobacco Decoro',
    'SYDNEY': 'Tobacco',
  },
  'Ecoluxe': {
    'SNOW': 'White Brillo',
  },
  'Factory': {
    'ANTRACITE': 'Ferro', 'WHITE': 'Avorio',
  },
  'Flagstone': {
    // Plain tiles now match PRICE_LIST directly (Borgona, Canyon, Esla, Filita)
  },
  'Garda': {
    'BORDOLINO': 'Bianco', 'TORBOLE': 'Bianco',
    'LAZISE': 'Grafito',
    'RIVA': 'Gris',
  },
  'Geoblanco': {
    'DANTE': 'Blanco Brillo', 'SWING': 'Blanco Brillo',
  },
  'Formworks': {
    'ANTRACITE': 'Ferro', 'GREY': 'Cenere',
  },
  'Industrial': {
    'SILVER': 'Grey',
  },
  'Ledgestone': {
    'CANADA GRIS': 'British Gris',
    'BRITISH  BEIGE': 'British Bone', 'BRITISH BEIGE': 'British Bone',
  },
  'Levante': {
    '(Corfu) GRIS (Nplus/Matte)': 'Gris',
    '(Corfu) MARFIL (Nplus/ Matte)': 'Marfil',
    'ICEBERG (Nplus/ Matte)': 'Iceberg',
    'FENIX BLANCO (Nplus)': 'Deco Blanco',
  },
  'Lux': {
    'ANTY SKY': 'Crema Polished', 'CLASSIC CORAL': 'Crema Polished',
    'BIANCO STONE': 'White Polished', 'BLONZE BIANCO': 'White Polished',
    'CALCUTTA WHITE': 'White Polished',
    'GLAIER BAY': 'Grey Polished', 'PROTLAND BIANCO GREY': 'Grey Polished',
  },
  'Madison': {
    'BEIGE': 'Bone', 'GRIS': 'Grey',
  },
  'Marble Carrara': {
    'ELONGED GLOSSY 4X8': 'Blanco Brillo',
    'HEXAGON MATTE/GLOSSY 6X7': 'Hexagon Brillo',
    'WAVE GLOSSY 3X12': 'Ondas Brillo',
  },
  'Marmo': {
    'AGAVE 12X24 (Pol)': 'Gris Brillo',
    'CALCATTA BIANCO 32X32 (Pol)': 'Blanco Brillo',
    'CREMA MARFIL 12X24 (Pol)': 'Blanco Brillo', 'CREMA MARFIL 24X24 (Pol)': 'Blanco Brillo',
    'CAVELANO 12X24 (Mat/Pol)': 'Gris Natural', 'CAVELANO 24X24 (Mat/Pol)': 'Gris Natural',
    'CARRARA 24X48 (Pol)': 'Blanco Brillo', 'CARRARA 12X24 (Pol)': 'Blanco Brillo',
    'CARRARA 32X32 (Pol)': 'Blanco Brillo',
    'CALCATTA GOLD 12X24 (Mat/Pol)': 'Blanco Natural', 'CALCATTA GOLD 24X24 (Mat/Pol)': 'Blanco Natural',
    'ICE ROCK 24\u00d748 (Mat/ Pol)': 'Gris Brillo', 'ICE ROCK 12X24 (Mat/Pol)': 'Gris Brillo',
    'MARMO ICE ROCK 32\u00d732 (Pol)': 'Gris Brillo', 'ice rock 24\u00d724 (Mat/ Pol)': 'Gris Brillo',
    'CALCATTA PIETRA 12X24 (Mat/Pol)': 'Blanco Natural',
    'CALCATTA PIETRA 24X24 (Mat/Pol)': 'Blanco Natural',
  },
  'Marquina': {
    'Nero Glossy/ Matte': 'Black Polished',
  },
  'Mash-Up': {
    'Diamond': 'Graphite', 'Dot': 'Graphite', 'Flower': 'Graphite',
    'Lined': 'Graphite', 'White': 'Graphite',
  },
  'Nativa': {
    'DARK': 'Grafito', 'LIGHT': 'Perla', 'MEDIUM': 'Cenere',
  },
  'Materica': {
    'Taupe': 'Cenere',  // website mislabeled: caption says Taupe but filename is Grigio
  },
  'Nolan': {
    // Plain tiles now match PRICE_LIST directly (Bianco, Grey, Miele, Natural)
  },
  'Opal': {
    'IVORY': 'Beige Natural',
  },
  'Orlando': {
    // Plain tiles now match PRICE_LIST directly (Cream, White)
  },
  'Oxford 948': {
    'Oxford Perla': 'Grey', 'Oxford Wengue': 'Taupe',
  },
  'Paddington': {
    'Black Matte/ Glossy': 'Black', 'Grey Matte/ Glossy': 'Grey',
    'Navi Blue Matte/ Glossy': 'Navy Blue', 'Putty Matte/ Glossy': 'Putty',
    'White Matte/ Glossy': 'White',
  },
  'Patchwork': {
    'BLACK': 'Color', 'WHITE': 'Color',
  },
  'Peak': {
    // Plain tiles now match PRICE_LIST directly (Dark, Gris, Medium, Tropical, White)
  },
  'Picket': {
    'Carrara Glossy': 'White',
  },
  'Pierre': {
    'BIANCO PAONAZZETO': 'Bone', 'BELLE BLANC': 'Bone',
  },
  'Pietra': {
    'PRIMA BLANCO (MATTE/POLISHED)': 'Bone',
    'MONTEGA (MATTE)': 'Grey',
  },
  'Powder': {
    'Argent': 'Grey', 'Concrete': 'Grey', 'Tortora': 'Sand',
  },
  'Pulpis': {
    'Dark Grey': 'Gris Natural', 'Grey': 'Gris Natural',
  },
  'Rock': {
    'PETRA BEIGE': 'Bone', 'PETRA GRIS': 'Grey',
    'TEIDE BEIGE': 'Bone', 'TEIDE SAND': 'Sand',
    'VULCANO DARK': 'Grey',
  },
  'Romani': {
    'CREMA (Matte/ Polished)': 'Bone',
    'NOCE (Matte/Polished)': 'Sand',
  },
  'Sabina': {
    'GRIS': 'Grey', 'BEIGE': 'Bone',
  },
  'Saverne': {
    'BEIGE': 'Bone', 'GREY': 'Grey',
  },
  'Selkis': {
    'CHARCOAL': 'Grey', 'PERGAMON': 'Beige', 'STEEL': 'Grey',
  },
  'Stony': {
    'BIANCO': 'Bone', 'GRAFITE': 'Grey', 'SABBIA': 'Bone',
  },
  'Terra': {
    'RIVER ROCK': 'Grey', 'TRAVERTINE': 'Beige',
  },
  'Terrazo': {
    'BIANCO': 'White', 'GRIS': 'Grey',
  },
  'Timeless': {
    'ECRU': 'Beige', 'HONEY': 'Beige',
  },
  'Torp': {
    'GRIS': 'Grey',
    // Moka now matches PRICE_LIST directly
  },
  'Toulouse': {
    'TAUPE': 'Sand',
  },
  'Victorian': {
    // Plain tiles + decos now match PRICE_LIST directly
  },
  'Viena': {
    'GRIS CLARO': 'Grey', 'IVORY': 'Beige',
    'GREY PEARL': 'Grey', 'GRAPHITE': 'Grey', 'ANTRACITE': 'Grey',
    'TOBACCO': 'Sand',
  },
  'Vinyle': {
    'Antracita': 'Grey', 'Gris': 'Grey', 'Moka': 'Brown',
    'Beige': 'Natural', 'Blanco': 'Natural', 'Crema': 'Natural',
  },
  'Vulcani': {
    // Plain tiles now match PRICE_LIST directly (Avorio, Bianco, Grigio, Multicolor)
  },
  'Wales': {
    'White': 'Beige',
  },
  'Zafiro': {
    'HELENA': 'Beige Natural',  // captions swapped with filenames on website
  },
};

// ──────────────────────────────────────────────
// Category keyword mapping
// ──────────────────────────────────────────────

const CATEGORY_KEYWORDS = {
  'porcelain-tile': ['porcelain'],
  'ceramic-tile':   ['ceramic'],
  'mosaic-tile':    ['mosaic'],
};

// Cost markup to generate retail price (2x)
const MARKUP = 2.0;

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function slugify(text) {
  return (text || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 30);
}

/** Build internal SKU: SIENA-{COLLECTION}-{COLOR/TYPE}-{SIZE}[-{FINISH}] */
function buildInternalSku(collection, colorOrType, size, finish) {
  const col = slugify(collection);
  const ct = slugify(colorOrType);
  const sz = (size || '').replace(/[^0-9xX.]/g, '').toUpperCase();
  const fin = finish ? slugify(finish) : '';
  const parts = ['SIENA', col, ct, sz];
  if (fin) parts.push(fin);
  return parts.join('-');
}

/** Determine category_id for a collection based on material */
async function resolveCategory(pool, material) {
  let slug = 'porcelain-tile'; // default
  if (material === 'ceramic') slug = 'ceramic-tile';
  const res = await pool.query('SELECT id FROM categories WHERE slug = $1', [slug]);
  return res.rows.length ? res.rows[0].id : null;
}

/** Classify accessory type label for variant_name */
function accessoryLabel(type) {
  const labels = {
    'bullnose': 'Bullnose',
    'mosaic': 'Mosaic',
    'london-base': 'London Base',
    'london-top': 'London Top',
    'torello': 'Torello',
    'quarter-round': 'Quarter Round',
    'corner': 'Corner',
    'corner-qr': 'Corner QR',
    'jolly': 'Jolly',
    'liner': 'Liner',
  };
  return labels[type] || type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ──────────────────────────────────────────────
// Image scraping helpers
// ──────────────────────────────────────────────

async function createPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  return page;
}

async function scrollToLoadAll(page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 15; i++) {
      window.scrollBy(0, 400);
      await new Promise(r => setTimeout(r, 200));
    }
    window.scrollTo(0, 0);
  });
  await delay(1000);
}

/**
 * Extract images + labels from a Siena Decor collection page.
 *
 * DOM structure (WordPress gallery):
 *   div.gallery > dl.gallery-item > dt > a > img   (swatch/product photo)
 *                                 > dd.gallery-caption  (color label)
 *
 * Non-gallery images (outside .gallery) are lifestyle / room-scene photos.
 *
 * Returns { swatches: [{src, label}], lifestyleImages: [url], description }
 */
async function extractCollectionImages(page, url) {
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
    if (!resp || resp.status() >= 400) {
      console.log(`    HTTP ${resp?.status()} for ${url}`);
      return { swatches: [], lifestyleImages: [], description: null };
    }
    await delay(2000);
    await scrollToLoadAll(page);

    const result = await page.evaluate(() => {
      const seen = new Set();
      function fullSize(src) {
        // Only strip WordPress thumbnail dimensions (both values >= 100px).
        // Keep tile-size identifiers like -12x24, -18x18, -3x12, -5x7, -13x26.
        return (src || '').replace(/-(\d+)x(\d+)(\.\w+)(\?|$)/, (m, w, h, ext, end) =>
          (parseInt(w) >= 100 && parseInt(h) >= 100) ? ext + end : m
        );
      }
      function normalize(src) {
        return src.split('?')[0].replace(/-\d+x\d+(\.\w+)$/, '$1');
      }

      // ── 1a. Gallery items: labeled swatch images ──
      const swatches = [];
      document.querySelectorAll('.gallery .gallery-item').forEach(item => {
        const img = item.querySelector('img');
        const caption = item.querySelector('.gallery-caption');
        if (!img) return;
        // Prefer <a> href (full-size original) over <img> src (WP thumbnail)
        const link = img.closest('a');
        const src = (link?.href && link.href.startsWith('http') ? link.href : '') ||
                    img.currentSrc || img.src || img.dataset?.src || '';
        if (!src || !src.startsWith('http')) return;
        const norm = normalize(src);
        if (seen.has(norm)) return;
        seen.add(norm);
        swatches.push({
          src: fullSize(src),
          label: caption?.textContent?.trim() || '',
        });
      });

      // ── 1b. WP-caption containers: labeled images in .wp-caption divs ──
      document.querySelectorAll('.wp-caption').forEach(container => {
        if (container.closest('.gallery')) return; // already handled above
        const img = container.querySelector('img');
        const caption = container.querySelector('.wp-caption-text');
        if (!img) return;
        // Prefer <a> href (full-size original) over <img> src (WP thumbnail)
        const link = img.closest('a');
        const src = (link?.href && link.href.startsWith('http') ? link.href : '') ||
                    img.currentSrc || img.src || img.dataset?.src || '';
        if (!src || !src.startsWith('http')) return;
        const norm = normalize(src);
        if (seen.has(norm)) return;
        seen.add(norm);
        const label = caption?.textContent?.trim() || '';
        if (label) {
          swatches.push({ src: fullSize(src), label });
        }
      });

      // ── 2. Non-gallery images: lifestyle / room-scene ──
      const lifestyleImages = [];
      const contentArea = document.querySelector('.post-content') ||
                          document.querySelector('.entry-content') ||
                          document.querySelector('.fusion-fullwidth') ||
                          document.body;
      contentArea.querySelectorAll('img').forEach(img => {
        if (img.closest('.gallery') || img.closest('.wp-caption')) return;
        const src = img.currentSrc || img.src || img.dataset?.src || '';
        if (!src || !src.startsWith('http')) return;
        if (src.includes('logo') || src.includes('icon') || src.includes('placeholder')) return;
        const norm = normalize(src);
        if (seen.has(norm)) return;
        seen.add(norm);
        lifestyleImages.push(fullSize(src));
      });

      // ── 3. Description ──
      let description = null;
      const descEl = document.querySelector('.fusion-tab-content p') ||
                     document.querySelector('.post-content > p') ||
                     document.querySelector('.entry-content > p');
      if (descEl) {
        const text = descEl.textContent?.trim();
        if (text && text.length > 20 && text.length < 500) description = text;
      }

      return { swatches, lifestyleImages, description };
    });

    return result;
  } catch (err) {
    console.log(`    Error loading ${url}: ${err.message}`);
    return { swatches: [], lifestyleImages: [], description: null };
  }
}

/**
 * Match a scraped image label to a color name (conservative, case-insensitive).
 * Returns the matched color name or null.
 *
 * Strategy: prefer explicit CAPTION_TO_COLOR (handled by caller), then:
 * 1. Exact match (full label)
 * 1b. Exact match after stripping size/finish suffixes (e.g., "AGAVE 12X24 (Pol)" → "AGAVE")
 * 2. Decorative labels (deco/fibre/inlay/etc.) → only match deco colors, else skip
 * 3. Color name starts with label (e.g., "Grey" → "Grey Polished")
 * 4. Label starts with color (e.g., "Black Matte/ Glossy" → "Black")
 */
function matchLabelToColor(label, colors) {
  if (!label || !colors.length) return null;
  const clean = label.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length < 2) return null;

  // Normalize color names consistently (collapse whitespace)
  const norm = c => c.toLowerCase().replace(/\s+/g, ' ').trim();

  // 1. Exact match
  for (const c of colors) {
    if (clean === norm(c)) return c;
  }

  // 1b. Strip size info (e.g., "12X24", "24x48") and finish qualifiers, then retry exact match
  //     Handles labels like "AGAVE 12X24 (Pol)" → "agave", "CREMA MARFIL 24X24 (Mat/Pol)" → "crema marfil"
  const stripped = clean
    .replace(/\s+\d+\s*x\s*\d+.*$/, '')               // strip "12x24 (Pol)" etc.
    .replace(/\s+(?:pol|mat|matte|glossy|polished|natural)\b.*$/i, '')  // strip trailing finish
    .trim();
  if (stripped && stripped !== clean && stripped.length >= 3) {
    for (const c of colors) {
      if (stripped === norm(c)) return c;
    }
  }

  // Detect decorative labels — these should NOT match plain tile colors
  const decoRe = /\b(deco|decor|decoro|fibre|fiber|inlay|3d|bend|grid|honey|bijou|relieve|sigma|ondas|rodia|mix)\b/;
  if (decoRe.test(clean)) {
    // Only match deco colors (those also containing a deco keyword)
    for (const c of colors) {
      const cl = norm(c);
      if (decoRe.test(cl) && (clean.includes(cl) || cl.includes(clean))) return c;
    }
    return null;
  }

  // 2. Color name starts with the label text (or stripped label)
  //    e.g., label "Grey" matches "Grey Polished", "Grey Natural"
  //    Pick the longest label match (most specific)
  let best = null, bestLen = 0;
  for (const label2 of [clean, stripped].filter(Boolean)) {
    for (const c of colors) {
      const cl = norm(c);
      if (cl.startsWith(label2) && label2.length > bestLen) {
        best = c; bestLen = label2.length;
      }
    }
  }
  if (best) return best;

  // 3. Label starts with a color name (min 4 chars to avoid false positives)
  //    e.g., label "Black Matte/ Glossy" matches "Black"
  best = null; bestLen = 0;
  for (const label2 of [clean, stripped].filter(Boolean)) {
    for (const c of colors) {
      const cl = norm(c);
      if (cl.length >= 4 && label2.startsWith(cl) && cl.length > bestLen) {
        best = c; bestLen = cl.length;
      }
    }
  }
  if (best) return best;

  return null;
}

// ──────────────────────────────────────────────
// Main scraper
// ──────────────────────────────────────────────

async function run() {
  console.log('=== Siena Decor Scraper ===\n');

  // ── Step 1: Create/lookup vendor ──
  let vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'SIENA'");
  if (!vendorRes.rows.length) {
    vendorRes = await pool.query(
      "INSERT INTO vendors (name, code, website) VALUES ('Siena Decor', 'SIENA', 'https://sienadecor.com') RETURNING id"
    );
    console.log('Created vendor: Siena Decor');
  }
  const vendorId = vendorRes.rows[0].id;

  // ── Step 2: Resolve category IDs ──
  const categoryCache = new Map();
  for (const [slug] of Object.entries(CATEGORY_KEYWORDS)) {
    const res = await pool.query('SELECT id FROM categories WHERE slug = $1', [slug]);
    if (res.rows.length) categoryCache.set(slug, res.rows[0].id);
  }

  // ── Step 3: Phase 1 — Data Import from PRICE_LIST ──
  console.log('Phase 1: Importing products from price list...\n');

  let productsCreated = 0;
  let skusCreated = 0;
  const productIndex = new Map(); // collection:color → { productId, skuIds: Map<internalSku, skuId> }

  for (const [collectionName, collData] of Object.entries(PRICE_LIST)) {
    const categoryId = await resolveCategory(pool, collData.material);

    // Gather all unique colors across field tile items
    const allColors = new Set();
    for (const item of collData.items) {
      if (item.colors) {
        for (const c of item.colors) allColors.add(c);
      }
    }

    // ── Create field tile products (one per color) ──
    for (const item of collData.items) {
      if (item.type) continue; // skip accessories for now

      for (const color of item.colors) {
        const productName = allColors.size === 1 && !color.includes('Mix') && !color.includes('Deco')
          ? collectionName
          : `${collectionName} ${color}`;

        const { id: productId, is_new: prodNew } = await upsertProduct(pool, {
          vendor_id: vendorId,
          name: productName,
          collection: collectionName,
          category_id: categoryId,
          description_short: `${collData.desc}. Origin: ${collData.origin}.`,
        });

        if (prodNew) productsCreated++;

        // Build SKU
        const finish = item.finish || null;
        const internalSku = buildInternalSku(collectionName, color, item.size, finish);
        const variantName = finish ? `${item.size}, ${finish}` : item.size;
        const sellBy = item.unit === 'sf' ? 'box' : 'unit';
        const priceBasis = item.unit === 'sf' ? 'per_sqft' : 'per_unit';

        const { id: skuId, is_new: skuNew } = await upsertSku(pool, {
          product_id: productId,
          vendor_sku: '',
          internal_sku: internalSku,
          variant_name: variantName,
          sell_by: sellBy,
          variant_type: collData.usage?.includes('wall') ? 'wall_tile' : 'floor_tile',
        });

        if (skuNew) skusCreated++;

        // Pricing
        const cost = item.price;
        const retail = parseFloat((cost * MARKUP).toFixed(2));
        await upsertPricing(pool, skuId, { cost, retail_price: retail, price_basis: priceBasis });

        // Packaging (only for box-sold items)
        if (item.sf) {
          await upsertPackaging(pool, skuId, {
            sqft_per_box: item.sf,
            pieces_per_box: item.pcs,
            weight_per_box_lbs: item.lbs,
            boxes_per_pallet: item.bxPl || null,
          });
        }

        // SKU attributes
        await upsertSkuAttribute(pool, skuId, 'size', item.size);
        await upsertSkuAttribute(pool, skuId, 'color', color);
        if (finish) await upsertSkuAttribute(pool, skuId, 'finish', finish);
        if (collData.material) await upsertSkuAttribute(pool, skuId, 'material', collData.material);
        if (collData.origin) await upsertSkuAttribute(pool, skuId, 'origin', collData.origin);

        // Index for image matching
        const key = `${collectionName}:${color}`;
        if (!productIndex.has(key)) {
          productIndex.set(key, { productId, skuIds: new Map() });
        }
        productIndex.get(key).skuIds.set(internalSku, skuId);
      }
    }

    // ── Create accessory products ──
    for (const item of collData.items) {
      if (!item.type) continue;

      const accLabel = accessoryLabel(item.type);
      const productName = `${collectionName} ${item.label || accLabel}`;

      const { id: productId, is_new: prodNew } = await upsertProduct(pool, {
        vendor_id: vendorId,
        name: productName,
        collection: collectionName,
        category_id: item.type === 'mosaic' ? (categoryCache.get('mosaic-tile') || categoryId) : categoryId,
        description_short: `${accLabel} trim for the ${collectionName} collection.`,
      });

      if (prodNew) productsCreated++;

      const internalSku = buildInternalSku(collectionName, item.label || item.type, item.size, null);
      const sellBy = item.unit === 'sf' ? 'box' : 'unit';
      const priceBasis = item.unit === 'sf' ? 'per_sqft' : 'per_unit';
      const variantType = item.type === 'mosaic' ? 'mosaic' : 'accessory';

      const { id: skuId, is_new: skuNew } = await upsertSku(pool, {
        product_id: productId,
        vendor_sku: '',
        internal_sku: internalSku,
        variant_name: item.size,
        sell_by: sellBy,
        variant_type: variantType,
      });

      if (skuNew) skusCreated++;

      const cost = item.price;
      const retail = parseFloat((cost * MARKUP).toFixed(2));
      await upsertPricing(pool, skuId, { cost, retail_price: retail, price_basis: priceBasis });

      if (item.sf) {
        await upsertPackaging(pool, skuId, {
          sqft_per_box: item.sf,
          pieces_per_box: item.pcs,
          weight_per_box_lbs: item.lbs,
        });
      } else if (item.pcs) {
        await upsertPackaging(pool, skuId, { pieces_per_box: item.pcs });
      }

      await upsertSkuAttribute(pool, skuId, 'size', item.size);
      if (collData.material) await upsertSkuAttribute(pool, skuId, 'material', collData.material);
    }

    console.log(`  ${collectionName}: imported`);
  }

  console.log(`\nPhase 1 complete: ${productsCreated} products, ${skusCreated} SKUs created\n`);

  // ── Step 4: Phase 2 — Scrape website for images ──
  console.log('Phase 2: Scraping website for images...\n');

  let browser = await launchBrowser();
  let page = await createPage(browser);
  let imagesSaved = 0;

  try {
    for (const [collectionName, slug] of Object.entries(COLLECTION_SLUG_MAP)) {
      const url = `${BASE_URL}/portfolio-items/${slug}/`;
      console.log(`  Visiting: ${url}`);

      let result;
      try {
        result = await extractCollectionImages(page, url);
      } catch (err) {
        console.log(`    Error: ${err.message}`);
        // Try to recover browser
        try { await page.goto('about:blank', { timeout: 5000 }).catch(() => {}); } catch {
          try { await browser.close(); } catch {}
          browser = await launchBrowser();
          page = await createPage(browser);
        }
        await delay(1000);
        continue;
      }

      const totalImages = result.swatches.length + result.lifestyleImages.length;
      if (!totalImages) {
        console.log(`    No images found`);
        await delay(500);
        continue;
      }

      console.log(`    Found ${result.swatches.length} swatch + ${result.lifestyleImages.length} lifestyle images`);

      // Gather all colors for this collection
      const collData = PRICE_LIST[collectionName];
      if (!collData) { await delay(500); continue; }

      const allColors = [];
      for (const item of collData.items) {
        if (item.colors) allColors.push(...item.colors);
      }
      const uniqueColors = [...new Set(allColors)];

      // ── Match swatch images to colors and save per-SKU ──
      const savedProducts = new Set();
      const captionMap = CAPTION_TO_COLOR[collectionName] || {};

      // ── Pass 1: Collect all image URLs per color ──
      // This prevents many-to-one mappings (e.g., 10 deco captions → Mix Deco)
      // from overwriting each other. Instead we batch them and save once per color.
      const colorImages = new Map(); // color → [imgUrl, ...]
      const finishRe = /\s+(Polished|Natural|Matte|Brillo)\s*$/i;
      // Colors with explicit caption mappings should NOT receive sibling images —
      // they have their own dedicated gallery image (e.g., Carrara Blanco vs Blanco Brillo)
      const explicitlyMappedColors = new Set(Object.values(captionMap));

      for (const swatch of result.swatches) {
        if (!swatch.label || !swatch.label.trim()) continue; // skip empty captions

        // 1. Explicit caption→color mapping (highest priority)
        // 2. Conservative fuzzy match by label only (no filename guessing)
        const matchedColor = captionMap[swatch.label] ||
                             matchLabelToColor(swatch.label, uniqueColors);
        if (!matchedColor) {
          console.log(`    [UNMATCHED] caption="${swatch.label}" | available: ${uniqueColors.join(', ')}`);
          continue;
        }

        // Skip filterImageUrls() — it strips ALL -NxN suffixes, destroying tile-size
        // identifiers like -12x24. The page.evaluate fullSize() already handled
        // WP thumbnail stripping correctly (only strips when both dims >= 100).
        const imgUrl = swatch.src;
        if (!imgUrl || !imgUrl.startsWith('http')) continue;

        // Build list of colors to save: primary match + finish siblings
        // e.g., "Grey Polished" → also save to "Grey Matte", "Grey Natural"
        // Skip siblings that have their own explicit caption mapping — they'll
        // get their own image and shouldn't be cross-contaminated.
        const baseColor = matchedColor.replace(finishRe, '').trim().toLowerCase();
        const colorsToSave = [matchedColor];
        for (const c of uniqueColors) {
          if (c === matchedColor) continue;
          const cBase = c.replace(finishRe, '').trim().toLowerCase();
          if (cBase === baseColor && !explicitlyMappedColors.has(c)) colorsToSave.push(c);
        }

        for (const color of colorsToSave) {
          if (!colorImages.has(color)) colorImages.set(color, []);
          const imgs = colorImages.get(color);
          if (!imgs.includes(imgUrl)) imgs.push(imgUrl);
        }
      }

      // ── Pass 2: Save batched images per color ──
      for (const [color, imgUrls] of colorImages) {
        const key = `${collectionName}:${color}`;
        const entry = productIndex.get(key);
        if (!entry) continue;

        for (const [, skuId] of entry.skuIds) {
          const saved = await saveSkuImages(pool, entry.productId, skuId, imgUrls, { maxImages: 4, productName: `${collectionName} ${color}` });
          imagesSaved += saved;
        }
        savedProducts.add(entry.productId);

        const siblingNote = colorImages.has(color) && colorImages.get(color) === imgUrls ? '' : '';
        console.log(`    [SKU] ${color}: ${imgUrls.length} image(s) → 1 product`);
      }

      // Lifestyle images are not labeled per color on the Siena website,
      // so we skip them — better no image than a wrong-color room scene.
      if (result.lifestyleImages.length > 0) {
        console.log(`    [SKIPPED] ${result.lifestyleImages.length} lifestyle images (not color-specific)`);
      }

      // Update description if scraped
      if (result.description) {
        await pool.query(`
          UPDATE products SET description_short = COALESCE(description_short, $1)
          WHERE vendor_id = $2 AND collection = $3 AND description_short IS NULL
        `, [result.description, vendorId, collectionName]);
      }

      await delay(800);
    }
  } finally {
    await browser.close();
  }

  console.log(`\nPhase 2 complete: ${imagesSaved} images saved`);

  // Report image coverage
  const coverageRes = await pool.query(`
    SELECT COUNT(*) as total,
           COUNT(CASE WHEN EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id = s.id) THEN 1 END) as with_img
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.variant_type NOT IN ('accessory') AND s.status = 'active'
  `, [vendorId]);
  const { total, with_img } = coverageRes.rows[0];
  console.log(`  Image coverage: ${with_img}/${total} field tile SKUs (${(100*with_img/total).toFixed(1)}%)\n`);

  // ── Step 5: Phase 3 — Activate products ──
  console.log('Phase 3: Activating products...\n');

  // Activate SKUs with pricing
  const skuActivated = await pool.query(`
    UPDATE skus SET status = 'active'
    WHERE product_id IN (SELECT id FROM products WHERE vendor_id = $1)
      AND status = 'draft'
      AND EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id = skus.id AND pr.retail_price > 0)
    RETURNING id
  `, [vendorId]);
  console.log(`  Activated ${skuActivated.rowCount} SKUs with pricing`);

  // Activate products with active SKUs
  const prodActivated = await pool.query(`
    UPDATE products SET status = 'active'
    WHERE vendor_id = $1
      AND status = 'draft'
      AND EXISTS (SELECT 1 FROM skus s WHERE s.product_id = products.id AND s.status = 'active')
    RETURNING id
  `, [vendorId]);
  console.log(`  Activated ${prodActivated.rowCount} products`);

  // ── Step 6: Phase 4 — Refresh search vectors ──
  console.log('\nPhase 4: Refreshing search vectors...\n');

  // Use the DB's proper refresh_search_vectors function for each product
  const sienaProducts = await pool.query(
    'SELECT id FROM products WHERE vendor_id = $1', [vendorId]
  );
  for (const row of sienaProducts.rows) {
    await pool.query('SELECT refresh_search_vectors($1)', [row.id]);
  }
  console.log(`  Search vectors refreshed for ${sienaProducts.rowCount} products`);

  console.log('\n=== Scrape Complete ===');
  console.log(`Products created: ${productsCreated}`);
  console.log(`SKUs created: ${skusCreated}`);
  console.log(`Images saved: ${imagesSaved}`);

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
