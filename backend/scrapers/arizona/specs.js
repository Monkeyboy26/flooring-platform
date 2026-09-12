import { upsertSkuAttribute } from '../base.js';

/**
 * Upsert all spec + technical spec attributes for a SKU.
 */
export async function upsertAllSpecAttributes(pool, skuId, specs, technicalSpecs, { skipFinish = false } = {}) {
  // General specs → attribute slugs
  // Note: 'colors' (Stocked Colors) is intentionally excluded — it lists all
  // colors in the collection, not the SKU's actual color.  The accurate color
  // comes from attribute_pa_color on each variation.
  const specMap = {
    type: 'material',
    countryOfOrigin: 'country',
    finish: 'finish',
    thickness: 'thickness',
    application: 'application',
    edge: 'edge',
    look: 'look',
  };
  for (const [specKey, attrSlug] of Object.entries(specMap)) {
    if (!specs[specKey]) continue;
    // "Stocked Finish(es)" has the same hazard as Stocked Colors: it lists every
    // finish in the collection (e.g. "Honed (H), Polished (P)"), not this SKU's
    // finish. Never overwrite a variation-supplied finish with it, and never
    // write a multi-finish list at all — only a single finish (markers stripped).
    if (attrSlug === 'finish') {
      if (skipFinish) continue;
      const single = specs[specKey].replace(/\s*\([A-Z]\)/g, '').trim();
      if (single.includes(',')) continue;
      await upsertSkuAttribute(pool, skuId, 'finish', single);
      continue;
    }
    await upsertSkuAttribute(pool, skuId, attrSlug, specs[specKey]);
  }

  // Technical specs → attribute slugs
  const techMap = {
    peiRating: 'pei_rating',
    shadeVariation: 'shade_variation',
    waterAbsorption: 'water_absorption',
    dcof: 'dcof',
    breakingStrength: 'breaking_strength',
    frostResistant: 'frost_resistant',
    abrasionResistance: 'abrasion_resistance',
    mohs: 'mohs',
    stainingResistance: 'staining_resistance',
    thermalShock: 'thermal_shock',
  };
  for (const [techKey, attrSlug] of Object.entries(techMap)) {
    if (technicalSpecs[techKey]) await upsertSkuAttribute(pool, skuId, attrSlug, technicalSpecs[techKey]);
  }
}
