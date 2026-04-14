#!/usr/bin/env node
const COVEO_DOMAIN = 'www.daltile.com';
const COVEO_FIELDS = ['sku', 'seriesname', 'colornameenglish', 'productimageurl', 'nominalsize'];

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
  const resp = await queryCoveo(' @seriesname=="Marble Attache"', 0, 20);
  const results = resp.results || [];
  console.log(`Got ${results.length} entries\n`);
  for (const r of results.slice(0, 10)) {
    console.log(`color=${getField(r, 'colornameenglish')} size=${getField(r, 'nominalsize')}`);
    console.log(`  skus=${getField(r, 'sku')}`);
    console.log(`  img=${getField(r, 'productimageurl')}`);
    console.log('');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
