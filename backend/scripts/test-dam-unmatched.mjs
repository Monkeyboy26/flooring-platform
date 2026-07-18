import fs from 'fs';
import pg from 'pg';

const RELEVANT_CATEGORIES = new Set(['porcelain', 'mosaics', 'natural-stone', 'lvt', 'hardscape']);

function extractDamCategory(damPath) {
  const m = damPath.match(/\/product\/([^/]+)\//);
  return m ? m[1] : null;
}

function extractDamSku(damPath) {
  const filename = damPath.split('/').pop();
  return filename.replace(/-Primary-Web-Image\.\w+$/i, '')
                 .replace(/_Primary-Web-Image\.\w+$/i, '')
                 .replace(/\.\w+$/, '');
}

const pool = new pg.Pool({
  host: 'localhost', port: 5432,
  database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

try {
  const damPaths = JSON.parse(fs.readFileSync('/Users/kianassarpour/Desktop/flooring-platform/backend/data/msi-dam-paths.json', 'utf8'));

  const { rows } = await pool.query(`
    SELECT s.vendor_sku FROM skus s
    JOIN products p ON s.product_id = p.id
    JOIN vendors v ON p.vendor_id = v.id WHERE v.code = 'MSI'
  `);
  const exact = new Set(rows.map(r => r.vendor_sku));

  const relevant = damPaths.filter(p => {
    const cat = extractDamCategory(p);
    return cat && RELEVANT_CATEGORIES.has(cat);
  });

  const unmatched = [];
  for (const p of relevant) {
    const damSku = extractDamSku(p);
    if (exact.has(damSku)) continue;

    // Check prefix/reverse-prefix
    let found = false;
    for (const sku of exact) {
      if (damSku.startsWith(sku) && sku.length >= 8) { found = true; break; }
      if (sku.startsWith(damSku) && damSku.length >= 8 && (sku.length - damSku.length) <= 3) { found = true; break; }
    }
    if (!found) {
      unmatched.push({ damSku, cat: extractDamCategory(p), path: p });
    }
  }

  // Group by category
  const byCat = {};
  for (const u of unmatched) {
    const cat = u.cat || 'unknown';
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(u.damSku);
  }

  console.log('Unmatched by category:');
  for (const [cat, skus] of Object.entries(byCat).sort((a,b) => b[1].length - a[1].length)) {
    console.log(`\n  ${cat} (${skus.length}):`);
    // Show first 10
    skus.slice(0, 10).forEach(s => console.log(`    ${s}`));
    if (skus.length > 10) console.log(`    ... and ${skus.length - 10} more`);
  }

  // Try to find patterns in unmatched that might help improve matching
  console.log('\n\n═══ PATTERN ANALYSIS ═══');

  // Check how many start with common prefixes that DB SKUs also use
  const prefixes = ['QUPO', 'QUTR', 'SMOT', 'QUARZ', 'VTG', 'VTR', 'VTW', 'VTT', 'NCAR', 'NSTO', 'T'];
  for (const pre of prefixes) {
    const damWithPrefix = unmatched.filter(u => u.damSku.startsWith(pre));
    const dbWithPrefix = [...exact].filter(s => s.startsWith(pre));
    if (damWithPrefix.length > 0) {
      console.log(`\n  Prefix "${pre}": ${damWithPrefix.length} unmatched DAM, ${dbWithPrefix.length} DB SKUs`);
      // Show first 5 of each
      console.log('    DAM:', damWithPrefix.slice(0, 3).map(u => u.damSku).join(', '));
      console.log('    DB:', dbWithPrefix.slice(0, 3).join(', '));
    }
  }

  // Check for P- prefix patterns (some DAM has P- prefix, some DB doesn't)
  const pPrefixDam = unmatched.filter(u => u.damSku.startsWith('P-'));
  if (pPrefixDam.length > 0) {
    console.log(`\n  "P-" prefix: ${pPrefixDam.length} unmatched DAM assets`);
    let wouldMatch = 0;
    for (const u of pPrefixDam) {
      const stripped = u.damSku.replace(/^P-/, '');
      if (exact.has(stripped)) wouldMatch++;
    }
    console.log(`    Would match if P- stripped: ${wouldMatch}`);
    console.log('    Samples:', pPrefixDam.slice(0, 5).map(u => u.damSku).join(', '));
  }

  // Check for -ST or -ST-EE suffix patterns
  const stSuffix = unmatched.filter(u => u.damSku.endsWith('-ST-EE') || u.damSku.endsWith('-ST'));
  if (stSuffix.length > 0) {
    console.log(`\n  "-ST"/"-ST-EE" suffix: ${stSuffix.length} unmatched`);
    let wouldMatch = 0;
    for (const u of stSuffix) {
      const stripped = u.damSku.replace(/-ST(-EE)?$/, '');
      if (exact.has(stripped)) wouldMatch++;
    }
    console.log(`    Would match if suffix stripped: ${wouldMatch}`);
    console.log('    Samples:', stSuffix.slice(0, 5).map(u => u.damSku).join(', '));
  }

  // Check color-name based matching (e.g., "Adella-Gris" in DAM → product name match)
  const colorNameDam = unmatched.filter(u => /^[A-Z][a-z]/.test(u.damSku));
  if (colorNameDam.length > 0) {
    console.log(`\n  Color/product name format (Title-Case): ${colorNameDam.length} unmatched`);
    console.log('    Samples:', colorNameDam.slice(0, 10).map(u => u.damSku).join(', '));
  }

} finally {
  await pool.end();
}
