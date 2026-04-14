// Temporary script to analyze Pentz grouping
async function main() {
  const body = new URLSearchParams({ apikey: "r6@Tl!f7ApXMW#aN" });
  const res = await fetch("https://www.pentzcommercial.com/product-api/export", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();

  // Group by style_num
  const styles = new Map();
  for (const item of data) {
    const key = item.jj_style_num;
    if (!styles.has(key)) {
      styles.set(key, {
        name: item.style,
        type: item.jj_style_carpet_type,
        brand: item.jj_style_brand,
        width: item.jj_style_width,
        height: item.jj_style_height,
        colors: new Set(),
      });
    }
    styles.get(key).colors.add(item.color);
  }

  // Find base name patterns — strip "Broadloom", "Plank", "Tile", size suffixes
  const baseNames = new Map(); // baseName -> [{ styleNum, name, type, size, colorCount }]
  for (const [num, s] of styles) {
    const base = s.name
      .replace(/\s+Broadloom$/i, '')
      .replace(/\s+Plank$/i, '')
      .replace(/\s+Tile$/i, '')
      .replace(/\s+LVT$/i, '')
      .trim();
    if (!baseNames.has(base)) baseNames.set(base, []);
    baseNames.set(base, [...baseNames.get(base), {
      styleNum: num,
      fullName: s.name,
      type: s.type,
      size: s.width + 'x' + s.height,
      colorCount: s.colors.size,
      colors: [...s.colors].sort(),
    }]);
  }

  // Show groups with multiple variants
  console.log("=== PRODUCT FAMILIES (same base name, multiple formats) ===\n");
  let familyCount = 0;
  for (const [base, variants] of [...baseNames.entries()].sort((a,b) => a[0].localeCompare(b[0]))) {
    if (variants.length > 1) {
      familyCount++;
      console.log(`${base}:`);
      for (const v of variants) {
        console.log(`  ${v.styleNum.padEnd(8)} ${v.type.padEnd(10)} ${v.size.padEnd(8)} ${v.colorCount}c  "${v.fullName}"`);
      }
      // Check if colors match
      const colorSets = variants.map(v => JSON.stringify(v.colors));
      const allSame = colorSets.every(c => c === colorSets[0]);
      console.log(`  Colors match: ${allSame ? 'YES' : 'NO'}`);
      if (!allSame) {
        // Show differences
        const allColors = new Set(variants.flatMap(v => v.colors));
        for (const v of variants) {
          const missing = [...allColors].filter(c => !v.colors.includes(c));
          if (missing.length) console.log(`  ${v.fullName} missing: ${missing.join(', ')}`);
        }
      }
      console.log();
    }
  }

  console.log("=== STANDALONE PRODUCTS (no family) ===\n");
  for (const [base, variants] of [...baseNames.entries()].sort((a,b) => a[0].localeCompare(b[0]))) {
    if (variants.length === 1) {
      const v = variants[0];
      console.log(`  ${v.styleNum.padEnd(8)} ${v.type.padEnd(10)} ${v.size.padEnd(8)} ${v.colorCount}c  "${v.fullName}"`);
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total styles from API: ${styles.size}`);
  console.log(`Product families (multi-format): ${familyCount}`);
  console.log(`Standalone products: ${baseNames.size - familyCount}`);
  console.log(`If grouped by family: ${baseNames.size} products`);
}
main();
