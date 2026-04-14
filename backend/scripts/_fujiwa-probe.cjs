#!/usr/bin/env node
/**
 * Probe a few Fujiwa series pages to confirm WooCommerce variation shape.
 * Used during development of fujiwa-color-variants.cjs.
 */
const puppeteer = require('puppeteer');

const SLUGS = [
  'bohol-series',
  'joya-100-series',
  'joya-300-series',
  'joya-600-series',
  'joya-deco-series',
  'tokyo-100-series',
  'tokyo-200-series',
  'tokyo-600-series',
];

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'], headless: 'new' });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0');

  for (const slug of SLUGS) {
    const url = 'https://www.fujiwatiles.com/products/fujiwa-tile-collections/' + slug + '/';
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      const data = await page.evaluate(() => {
        const form = document.querySelector('form.variations_form');
        if (!form) return null;
        let vars = [];
        try { vars = JSON.parse(form.getAttribute('data-product_variations') || '[]'); } catch (e) {}
        return vars.map(v => ({
          sku: v.sku,
          color: v.attributes && v.attributes.attribute_pa_colors,
          img: v.image && v.image.full_src,
        }));
      });
      console.log(slug + ':', JSON.stringify(data));
    } catch (e) {
      console.log(slug + ' ERROR:', e.message);
    }
  }
  await browser.close();
})();
