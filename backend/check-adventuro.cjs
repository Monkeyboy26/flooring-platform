#!/usr/bin/env node
const COVEO_DOMAIN = 'www.daltile.com';
const COVEO_FIELDS = ['sku', 'seriesname', 'colornameenglish', 'productimageurl', 'nominalsize', 'producttype'];

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
  const resp = await queryCoveo(' @seriesname=="Adventuro"', 0, 100);
  const results = resp.results || [];
  console.log(`Got ${results.length} Adventuro entries\n`);
  const byType = {};
  for (const r of results) {
    const t = getField(r, 'producttype');
    byType[t] = (byType[t] || 0) + 1;
  }
  console.log('By type:', byType, '\n');

  for (const r of results.slice(0, 40)) {
    console.log(`type="${getField(r, 'producttype')}" color="${getField(r, 'colornameenglish')}" size="${getField(r, 'nominalsize')}"`);
    console.log(`  img=${getField(r, 'productimageurl')}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
