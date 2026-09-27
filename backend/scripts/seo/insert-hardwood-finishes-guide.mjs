// Hand-authored pillar guide: Hardwood Flooring Finishes Explained.
//
// Replaces the short AI-generated body on /guides/hardwood-flooring-finishes-explained
// with a comprehensive hand-written guide (~1,400 words): sheen levels, finish
// chemistry (factory UV-urethane vs site poly vs hardwax oil), textures, maintenance,
// and lifestyle-based picks.
//
//   node scripts/seo/insert-hardwood-finishes-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. FAQ stored as [q, a] pairs in filter_json.faq.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'hardwood-flooring-finishes-explained',
  title: 'Hardwood Flooring Finishes Explained',
  h1: 'Hardwood Flooring Finishes, Explained',
  meta_title: 'Hardwood Flooring Finishes Explained: Sheen, Oil vs. Urethane, Texture | Roma Flooring Designs',
  meta_description: 'Matte vs. satin vs. gloss, factory urethane vs. hardwax oil, wire-brushed vs. smooth — how each hardwood finish looks, wears, and repairs, and which fits your home.',
  intro_html: `<p><strong>Two floors in the same oak, from the same mill, can live completely different lives — because of the finish.</strong> The finish decides how the floor catches light, how loudly it announces every scratch and dust bunny, how it's cleaned, and whether a worn patch means a quick touch-up or a full refinish.</p>
<p>Finish is really three separate choices — <strong>sheen, chemistry, and texture</strong> — and once you see them as separate dials, the wall of samples gets much easier to read. Here's each dial, honestly. Or skip ahead and <a href="/installation">turn the real samples in the light at our Anaheim showroom</a> — sheen is something you judge with your eyes, not a spec sheet.</p>`,
  content_html: `
<h2>The 30-second answer</h2>
<div class="guide-callout"><p>For most homes: a <strong>matte or satin factory-finished urethane</strong>, and if life is busy, <strong>wire-brushed texture</strong> on top of it. Choose a <strong>hardwax-oil finish</strong> if you love a bare-wood look and the idea of spot-repairing instead of refinishing. Save gloss for formal rooms that see slippers, not sneakers.</p></div>

<h2>Dial one: sheen</h2>
<p>Sheen is pure optics — how much light the surface bounces — but it drives daily life more than any other choice:</p>
<ul>
  <li><strong>Matte (roughly 10–25% gloss):</strong> today's default. Reads like natural wood, hides scratches, dust, and paw prints better than anything else. The whole European-oak look is built on it.</li>
  <li><strong>Satin (~30–40%):</strong> the classic compromise — a soft glow that still forgives. The most popular sheen of the last two decades, and the safe call in traditional homes.</li>
  <li><strong>Semi-gloss and gloss (55%+):</strong> elegant and luminous, and utterly honest about every scratch, footprint, and speck of dust. Formal living rooms and low-traffic spaces only.</li>
</ul>
<p>One myth worth killing: <strong>sheen is not durability.</strong> A matte and a gloss version of the same finish are equally tough — the matte just hides the evidence. That's why busy households should shop the low end of the sheen scale.</p>

<h2>Dial two: chemistry — what the finish is made of</h2>
<table>
  <caption>Hardwood finish types compared</caption>
  <thead><tr><th>Finish</th><th>Look &amp; feel</th><th>Durability</th><th>When it wears</th></tr></thead>
  <tbody>
    <tr><td>Factory UV-cured urethane (aluminum oxide)</td><td>Any sheen; film sits on the wood</td><td>The hardest available — 25+ yr warranties</td><td>Screen &amp; recoat, eventually re-sand</td></tr>
    <tr><td>Site-finished waterborne poly</td><td>Clear, non-yellowing; seamless single plane</td><td>Very good</td><td>Recoat every 5–10 yrs</td></tr>
    <tr><td>Site-finished oil-based poly</td><td>Warm amber that deepens with age</td><td>Very good</td><td>Recoat; ambering continues</td></tr>
    <tr><td>Hardwax oil (penetrating)</td><td>Ultra-matte, bare-wood feel</td><td>Good — protects in the wood, not on it</td><td>Spot-repair anytime; periodic re-oil</td></tr>
  </tbody>
</table>
<p>The big fork is <strong>film vs. penetrating</strong>. Urethanes and polys form a plastic film over the wood — maximum protection, and when it finally wears, the fix is sanding and recoating the whole floor. Hardwax oils soak <em>into</em> the wood — the surface feels like wood rather than a coating, a scratch can be re-oiled in that one spot in twenty minutes, but the floor asks for maintenance oil every few years and is less bulletproof against spills in the meantime.</p>
<p>The second fork is <strong>factory vs. site-applied</strong>. Factory UV-cured urethane with aluminum-oxide additives is harder than anything that can be applied in your living room, arrives fully cured, and is why prefinished floors dominate — the tradeoff is micro-beveled edges between boards. Site finishing sands the installed floor into one seamless plane and lets you tune the stain on real wood in your real light — the traditional look, at the cost of days of dust and cure time. (This choice also intersects with <a href="/guides/engineered-vs-solid-hardwood">engineered vs. solid</a> — nearly all engineered floors come factory-finished.)</p>

<h2>Dial three: texture</h2>
<ul>
  <li><strong>Smooth:</strong> the classic. Shows life honestly — best paired with satin, hard species, and calm households.</li>
  <li><strong>Wire-brushed:</strong> the workhorse of modern floors. Brushing pulls the soft grain out of the surface, leaving fine linear texture that <em>pre-distresses</em> the floor — new scratches join the pattern instead of standing out. The natural partner of matte European oak.</li>
  <li><strong>Hand-scraped / distressed:</strong> deeper, rustic sculpting. Hides everything; commits your room to a farmhouse-leaning style.</li>
</ul>
<p>Texture is the cheapest insurance in flooring: with kids, dogs, or a busy front door, wire-brushing does more to keep a floor looking good than any upgrade in finish hardness — it's half of our standard <a href="/guides/best-flooring-for-pets">pet-household recipe</a>.</p>

<h2>Living with each finish</h2>
<ul>
  <li><strong>All finishes:</strong> dry dust-mopping, a hardwood-specific cleaner, felt pads under furniture — and <strong>no steam mops, ever</strong> (steam drives moisture into seams and voids most warranties).</li>
  <li><strong>Film finishes:</strong> the maintenance move is a <strong>screen-and-recoat</strong> — a light abrasion and fresh topcoat every 5–10 years that resets the wear clock <em>before</em> damage reaches wood. Wait until it's bare and you've bought a full sand instead.</li>
  <li><strong>Hardwax oil:</strong> refresh high-traffic zones with maintenance oil as they dull; spot-treat scratches as they happen. More frequent, dramatically less invasive.</li>
</ul>

<h2>Choosing by household</h2>
<ul>
  <li><strong>Kids, dogs, real life:</strong> matte, wire-brushed, factory urethane. The forgiveness stack.</li>
  <li><strong>Traditional or formal home:</strong> satin, smooth, site-finished — the seamless classic plane.</li>
  <li><strong>Design-forward, hands-on owner:</strong> hardwax oil in ultra-matte — the raw Scandinavian look, with spot-repair as the payoff for periodic oiling.</li>
  <li><strong>Rental or resale prep:</strong> mid-tone stain, satin factory urethane — the broadest buyer appeal per dollar.</li>
</ul>
<p>Whatever you choose, finish is baked into the price ranges in our <a href="/guides/cost-to-install-hardwood-floors-orange-county">Orange County hardwood cost guide</a> — premium factory finishes and site-finishing labor are two of the levers.</p>

<h2>The 60-second checklist</h2>
<ul>
  <li><strong>Sheen:</strong> matte or satin unless the room is genuinely formal. Sheen ≠ durability — it's scratch <em>visibility</em>.</li>
  <li><strong>Chemistry:</strong> factory UV-urethane for maximum armor; hardwax oil for repairability and feel.</li>
  <li><strong>Texture:</strong> wire-brushed if the household is busy.</li>
  <li><strong>Judge samples in your light,</strong> at an angle, near a window — sheen changes with the room.</li>
  <li><strong>Plan the recoat</strong> before the finish wears through; it's the difference between a weekend and a week.</li>
</ul>`,
  footer_html: `<p>Sheen and texture only make sense in person — the same board reads differently at noon and at dusk. <strong>Roma Flooring Designs</strong> stocks matte, satin, wire-brushed, and oiled hardwood side by side at our Anaheim showroom (1440 S. State College Blvd, Suite 6M); take samples home for the window test, then we'll quote supply or supply-and-install. <a href="/installation">Book a free consultation</a> or call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['engineered-hardwood', 'solid-hardwood', 'hardwood'],
    angle: 'matte vs satin vs gloss, wire-brushed, oil vs urethane, durability and look.',
    faq: [
      ['What is the most durable hardwood floor finish?',
       'Factory-applied UV-cured urethane with aluminum-oxide additives — it\'s harder than any finish that can be applied on site and commonly carries 25-year-plus wear warranties. Pair it with a matte sheen and wire-brushed texture and wear stays invisible longest.'],
      ['Is matte or satin finish better for hardwood floors?',
       'They\'re equally durable — sheen only changes how visible wear is. Matte hides scratches and dust best and suits modern European-oak looks; satin adds a soft classic glow and is the safer match for traditional homes. Skip gloss anywhere with real foot traffic.'],
      ['What is the difference between oil and urethane hardwood finishes?',
       'Urethane forms a protective film on top of the wood — maximum protection, but worn areas eventually need a full sand and recoat. Hardwax oil penetrates into the wood — it feels like bare wood and scratches can be spot-repaired in minutes, but it needs periodic re-oiling and is less spill-proof.'],
      ['What does wire-brushed hardwood mean?',
       'The surface is brushed at the factory to pull out the soft grain, leaving a fine linear texture. It effectively pre-distresses the floor, so new scratches blend into the pattern instead of standing out — the most practical texture for households with kids or pets.'],
      ['How do you maintain a hardwood finish?',
       'Dry dust-mopping, a hardwood-specific cleaner, felt pads — and never a steam mop. For film finishes, schedule a screen-and-recoat every 5–10 years before wear reaches bare wood; for oiled floors, refresh high-traffic areas with maintenance oil as they dull.'],
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
