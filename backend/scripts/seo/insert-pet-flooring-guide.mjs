// Hand-authored pillar guide: The Best Flooring for Pets and High-Traffic Homes.
//
// Replaces the short AI-generated body on /guides/best-flooring-for-pets with a
// comprehensive hand-written guide (~1,400 words). Honest rankings — including the
// floors that DON'T work with pets — grounded in real specs (wear mils, AC ratings).
//
//   node scripts/seo/insert-pet-flooring-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. FAQ stored as [q, a] pairs in filter_json.faq.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'best-flooring-for-pets',
  title: 'The Best Flooring for Pets and High-Traffic Homes',
  h1: 'The Best Flooring for Pets (and Busy Households)',
  meta_title: 'The Best Flooring for Pets and High-Traffic Homes | Roma Flooring Designs',
  meta_description: 'The best pet-proof flooring, ranked honestly — porcelain tile and 20-mil LVP up top, where laminate and hardwood fit, what to skip, and traction tips for older dogs.',
  intro_html: `<p><strong>Pets are a stress test for flooring: claws, accidents, tipped water bowls, zoomies, and hair — every day, for years.</strong> The floors that survive aren't a mystery, but the marketing around "pet-proof" flooring muddies what actually matters: scratch resistance is one spec, accident-proofing is a completely different one, and plenty of floors ace the first while failing the second.</p>
<p>Here's the honest ranking, what to look for on the spec sheet, and how to make the floors you love work in a house with animals. Bring a photo of your crew to <a href="/installation">our Anaheim showroom</a> and we'll match the floor to the pet — a 90-pound shepherd and a ragdoll cat are different problems.</p>`,
  content_html: `
<h2>The 30-second answer</h2>
<div class="guide-callout"><p><strong>Matte porcelain tile</strong> is the most pet-proof floor made — claws, accidents, and water bowls simply don't register. <strong>LVP with a 20-mil-plus wear layer</strong> is the wood-look choice that handles real pet life. Everything below those two involves a tradeoff you should make with eyes open.</p></div>

<h2>What pets actually do to floors</h2>
<p>Four separate problems, and floors handle each differently:</p>
<ul>
  <li><strong>Claws</strong> — constant micro-abrasion that dulls soft finishes and scratches soft wood. This is a surface-hardness question.</li>
  <li><strong>Accidents</strong> — urine is the real killer: it's not just moisture, it's ammonia that discolors wood and soaks into anything porous, often unnoticed for hours. This is a waterproofing question.</li>
  <li><strong>The water-bowl zone</strong> — a small area that stays damp for years. Same question, permanent version.</li>
  <li><strong>Traction</strong> — glossy floors are hard on dogs, especially seniors with weak hips. This is a finish question, and the one most articles skip.</li>
</ul>

<h2>The rankings</h2>
<table>
  <caption>Pet-friendliness by flooring type</caption>
  <thead><tr><th>Floor</th><th>Claws</th><th>Accidents</th><th>Verdict</th></tr></thead>
  <tbody>
    <tr><td>Porcelain tile (matte)</td><td>Immune</td><td>Immune</td><td>The gold standard</td></tr>
    <tr><td>LVP, 20+ mil</td><td>Very good</td><td>Waterproof</td><td>Best wood look for pets</td></tr>
    <tr><td>Laminate, AC4</td><td>Excellent</td><td>Weak — seams swell</td><td>Dry rooms, reliable pets only</td></tr>
    <tr><td>Engineered / solid hardwood</td><td>Shows wear</td><td>Vulnerable</td><td>Doable with strategy (below)</td></tr>
    <tr><td>Carpet</td><td>Fine (snags for cats)</td><td>Worst — pad soaks</td><td>Bedrooms only, chosen carefully</td></tr>
  </tbody>
</table>

<h2>Porcelain tile: the floor that doesn't care</h2>
<p>Nothing a pet can do registers on porcelain: claws can't scratch the fired surface, accidents wipe up hours later without a trace, and the water-bowl zone is a non-issue. Two pet-specific notes: choose a <strong>matte finish</strong> for paw traction (the same DCOF logic as <a href="/guides/choosing-bathroom-floor-tile">bathroom floors</a> — skip polished), and in a Southern California summer, the cool tile in front of the slider becomes your dog's favorite spot in the house. Wood-look porcelain planks give you the hardwood aesthetic with none of the vulnerability — the full spec guide is <a href="/guides/how-to-choose-porcelain-tile">here</a>.</p>

<h2>LVP: the practical favorite</h2>
<p>For most pet households, rigid-core LVP is the sweet spot: waterproof against accidents, softer and quieter under paws than tile, warm-toned wood looks, and planks that swap out if something truly bad happens. The spec that separates pet-worthy from not is the <strong>wear layer: 20 mil is the floor, 22–28 mil if a large dog lives on it</strong> — thickness of the plank itself matters far less. Two honest caveats: big-dog claws will eventually leave hairlines in any vinyl (matte, lower-sheen visuals hide them), and cheap lines can discolor in strong sun. See <a href="/guides/lvp-vs-laminate">LVP vs. laminate</a> for the full comparison.</p>

<h2>Laminate: great claws, bad accidents</h2>
<p>Here's the tradeoff most articles blur: laminate's melamine surface is <em>harder than vinyl</em> — an AC4 laminate out-resists claw scratches on almost anything short of tile. But its wood-fiber core swells permanently if an accident sits at a seam, and with pets, accidents happen where and when you're not looking. Our honest placement: laminate suits <strong>dry rooms with house-trained adult pets</strong> — living rooms and bedrooms — not the kitchen where the water bowl lives, and not homes with a puppy or a senior pet.</p>

<h2>Hardwood with pets: possible, with strategy</h2>
<p>Plenty of dog owners live happily on hardwood — they just stack the deck:</p>
<ul>
  <li><strong>Hard species:</strong> hickory, white oak, maple — skip soft walnut and pine.</li>
  <li><strong>Forgiving finishes:</strong> matte or satin sheen, <strong>wire-brushed texture</strong>, and character grade with knots and variation — scratches vanish into grain instead of glinting off a glossy plane.</li>
  <li><strong>Refinish headroom:</strong> solid or a 3mm+ veneer engineered floor means a decade of claw traffic can be sanded away — see <a href="/guides/engineered-vs-solid-hardwood">engineered vs. solid</a>.</li>
  <li><strong>Zone defense:</strong> rugs at doors and under the water bowl (with a waterproof mat), claws trimmed, and accept that patina is part of the deal.</li>
</ul>

<h2>Carpet: the honest no (with one exception)</h2>
<p>Accidents reach the pad, and the pad never forgets — odor that outlives every cleaning is why carpet ranks last for pets. The exception is the bedroom, where comfort wins and risk is low: choose a <strong>solution-dyed fiber</strong> (the color runs through the strand, so it tolerates real cleaning agents), a low <strong>loop-free pile for cats</strong> (loops snag claws), and a moisture-barrier pad. Fiber-by-fiber details in our <a href="/guides/carpet-buying-guide">carpet buying guide</a>.</p>

<h2>Traction: the senior-dog factor</h2>
<p>Older dogs on slick floors struggle to get up, and vets see the joint toll. If your dog is aging on a hard floor: matte over gloss every time, runners on the main highways (hallway, stairs, the route to the door), and a rug where they sleep so the first three steps of the morning have grip. It's a small design constraint that pays off for years.</p>

<h2>The 60-second checklist</h2>
<ul>
  <li><strong>Messiest rooms (kitchen, entries, laundry):</strong> matte porcelain or 20+ mil LVP. Nothing else.</li>
  <li><strong>LVP spec:</strong> 20 mil minimum, 22–28 for big dogs; low-sheen visual; UV-stable line by the slider.</li>
  <li><strong>Laminate:</strong> AC4, dry rooms, reliable pets — never the water-bowl room.</li>
  <li><strong>Hardwood:</strong> hard species + matte wire-brushed character grade + refinish headroom.</li>
  <li><strong>Everywhere:</strong> keep spare planks/tiles from your lot, trim claws, waterproof mat under the bowl.</li>
</ul>`,
  footer_html: `<p>Bring the real-world test to the showroom: <strong>Roma Flooring Designs</strong> stocks porcelain, LVP, laminate, and hardwood side by side in Anaheim (1440 S. State College Blvd, Suite 6M) — drag a key across samples, pour some water, and see what your house can live with. We'll quote supply or supply-and-install on the spot. <a href="/installation">Book a free consultation</a> or call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['lvp-plank', 'porcelain-tile', 'broadloom-carpet'],
    angle: 'scratch/stain resistance, waterproof, traction, easy cleaning.',
    faq: [
      ['What is the best flooring for dogs?',
       'Matte porcelain tile is the most dog-proof floor — immune to claws, accidents, and water bowls, with good paw traction. If you want a wood look, rigid-core LVP with a 20-mil-or-thicker wear layer is the practical favorite for dog households.'],
      ['Is LVP or laminate better for pets?',
       'LVP for most pet homes: the plank is waterproof, so accidents are a cleanup rather than damage. Laminate actually resists claw scratches better (its surface is harder), but its wood-fiber core swells permanently if an accident reaches a seam — keep it to dry rooms with reliable pets.'],
      ['What wear layer should LVP have for pets?',
       '20 mil is the minimum for a pet household; go 22–28 mil for large dogs or rental-grade abuse. Wear-layer thickness matters far more than total plank thickness for durability.'],
      ['Can you have hardwood floors with dogs?',
       'Yes, with strategy: choose a hard species (hickory, white oak, maple), a matte wire-brushed finish and character grade that hide scratches, keep claws trimmed, and pick a floor with refinish headroom — solid or engineered with a 3mm+ veneer — so accumulated wear can be sanded away.'],
      ['Is carpet bad for pets?',
       'For accident-prone pets, yes — urine reaches the pad and the odor outlasts cleaning. If you want carpet in bedrooms, choose a solution-dyed fiber, a loop-free pile (loops snag cat claws), and a moisture-barrier pad.'],
    ],
  },
};

async function upsertGuide(g) {
  const sql = `
    INSERT INTO landing_pages
      (type, slug, title, h1, meta_title, meta_description, intro_html, content_html, footer_html,
       filter_json, is_indexable, content_status, created_at, updated_at)
    VALUES
      ('guide', $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, true, 'reviewed', now(), now())
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title, h1 = EXCLUDED.h1, meta_title = EXCLUDED.meta_title,
      meta_description = EXCLUDED.meta_description, intro_html = EXCLUDED.intro_html,
      content_html = EXCLUDED.content_html, footer_html = EXCLUDED.footer_html,
      filter_json = EXCLUDED.filter_json, is_indexable = true, content_status = 'reviewed',
      updated_at = now()
    RETURNING slug, (xmax = 0) AS inserted`;
  const params = [g.slug, g.title, g.h1, g.meta_title, g.meta_description,
    g.intro_html, g.content_html, g.footer_html, JSON.stringify(g.filter_json)];
  if (DRY) { console.log(`[dry-run] would upsert guide: ${g.slug}`); return; }
  const res = await pool.query(sql, params);
  const row = res.rows[0];
  console.log(`${row.inserted ? 'INSERTED' : 'UPDATED '} guide: /guides/${row.slug}`);
}

(async () => {
  try {
    await upsertGuide(GUIDE);
    console.log('Done.');
  } catch (e) {
    console.error('Failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
