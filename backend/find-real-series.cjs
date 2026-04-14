#!/usr/bin/env node
/**
 * Find where mystery Daltile colors actually live in Coveo (by colornameenglish)
 */

const COVEO_DOMAIN = 'www.daltile.com';
const COVEO_FIELDS = ['sku', 'seriesname', 'colornameenglish', 'productimageurl', 'bodytype', 'producttype'];

async function queryCoveo(extraFilter, firstResult, numberOfResults) {
  const aq = `@sitetargethostname=="${COVEO_DOMAIN}" @sourcedisplayname==product${extraFilter}`;
  const resp = await fetch(`https://${COVEO_DOMAIN}/coveo/rest/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ q: '', aq, firstResult, numberOfResults, fieldsToInclude: COVEO_FIELDS }),
  });
  if (!resp.ok) throw new Error(`Coveo ${resp.status}`);
  return resp.json();
}

function getField(result, fieldName) {
  const raw = result.raw || {};
  const val = raw[fieldName] ?? raw[fieldName.toLowerCase()] ?? null;
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean).join(', ');
  return String(val).trim();
}

async function main() {
  const suspects = ['Antico Scuro', 'Calacatta Gold', 'Carrara White', 'Botticino Fiorito', 'Black/White'];

  for (const color of suspects) {
    console.log(`\n=== Looking for color "${color}" ===`);
    const resp = await queryCoveo(` @colornameenglish=="${color}"`, 0, 20);
    const results = resp.results || [];
    console.log(`  Found ${results.length} results`);
    const seriesSet = new Set();
    for (const r of results) {
      const s = getField(r, 'seriesname');
      const t = getField(r, 'producttype');
      seriesSet.add(`${s} | ${t}`);
    }
    for (const s of seriesSet) console.log(`    ${s}`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
