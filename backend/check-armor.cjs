#!/usr/bin/env node
const COVEO_DOMAIN = 'www.daltile.com';
const COVEO_FIELDS = ['sku', 'seriesname', 'colornameenglish', 'productimageurl', 'nominalsize', 'productshape', 'producttype'];

async function queryCoveo(extraFilter, firstResult, numberOfResults) {
  const aq = `@sitetargethostname=="${COVEO_DOMAIN}" @sourcedisplayname==product${extraFilter}`;
  const resp = await fetch(`https://${COVEO_DOMAIN}/coveo/rest/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: '', aq, firstResult, numberOfResults, fieldsToInclude: COVEO_FIELDS }),
  });
  if (!resp.ok) throw new Error(`Coveo ${resp.status}`);
  return resp.json();
}

function getField(r, f) {
  const raw = r.raw || {};
  const val = raw[f] ?? raw[f.toLowerCase()] ?? null;
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean).join(', ');
  return String(val).trim();
}

async function main() {
  const resp = await queryCoveo(' @seriesname=="Armor"', 0, 100);
  const results = resp.results || [];
  console.log(`Got ${results.length} Armor entries\n`);
  for (const r of results) {
    console.log(`color="${getField(r, 'colornameenglish')}" shape="${getField(r, 'productshape')}" size="${getField(r, 'nominalsize')}" type="${getField(r, 'producttype')}"`);
    console.log(`  skus=${getField(r, 'sku')}`);
    console.log(`  img=${getField(r, 'productimageurl')}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
