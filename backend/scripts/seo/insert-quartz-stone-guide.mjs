// Hand-authored pillar guide: Quartz vs Natural Stone Countertops.
//
// Replaces the short AI-generated body on /guides/quartz-vs-natural-stone-countertops
// with a comprehensive hand-written comparison (~1,400 words): what quartz actually is,
// stone by stone (granite/marble/quartzite/soapstone), heat and UV honesty, sealing
// reality, looks, cost, and how to choose by kitchen life.
//
//   node scripts/seo/insert-quartz-stone-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. FAQ stored as [q, a] pairs in filter_json.faq.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'quartz-vs-natural-stone-countertops',
  title: 'Quartz vs Natural Stone Countertops: A Comparison',
  h1: 'Quartz vs. Natural Stone Countertops',
  meta_title: 'Quartz vs Natural Stone Countertops: An Honest Comparison | Roma Flooring Designs',
  meta_description: 'Quartz vs. granite, marble, and quartzite — durability, sealing, heat and UV honesty, how each looks and ages, cost installed, and which fits how you actually cook.',
  intro_html: `<p><strong>The countertop aisle divides into two philosophies: stone engineered to be perfect, and stone quarried to be singular.</strong> Quartz — the engineered one — now outsells every natural stone combined, on the promise of zero maintenance and consistent color. Natural stone answers with the thing no factory replicates: a slab that exists exactly once.</p>
<p>Both philosophies make excellent countertops. The right one depends on how you cook, how you feel about patina, and a couple of physical facts (heat, sun, sealing) the sales brochures blur. Here's the honest comparison — then <a href="/installation">come stand over full slabs at our Anaheim showroom</a>, because countertops are chosen by the slab, not the swatch.</p>`,
  content_html: `
<h2>The 30-second answer</h2>
<div class="guide-callout"><p><strong>Quartz</strong> for zero-maintenance, consistent color, and busy family kitchens. <strong>Granite or quartzite</strong> for natural one-of-a-kind slabs with serious durability (and honest-but-minor sealing). <strong>Marble</strong> when you love the look enough to accept the patina. Outdoors or under strong sun: natural stone or porcelain — <em>not</em> quartz.</p></div>

<h2>What quartz actually is</h2>
<p>"Quartz" countertops are engineered slabs: roughly 90% ground natural quartz bound in polymer resin with pigments. That recipe is the source of every strength — <strong>non-porous (no sealing, ever), stain-shrugging, consistent from sample to slab</strong> — and of both weaknesses: the resin scorches under direct high heat, and it can yellow under prolonged UV, which is why quartz doesn't go outdoors or in front of a wall of unshaded south glass. Modern printing has made marble-look quartz genuinely convincing, though the veining repeats across slabs where nature never does.</p>

<h2>The natural stones, one by one</h2>
<table>
  <caption>Natural stone countertop materials</caption>
  <thead><tr><th>Stone</th><th>Character</th><th>The honest tradeoff</th></tr></thead>
  <tbody>
    <tr><td>Granite</td><td>Speckled, crystalline, endless variety</td><td>Sealing on schedule (a 15-minute wipe-on, yearly-ish); nearly bulletproof otherwise</td></tr>
    <tr><td>Quartzite</td><td>Marble's look with granite-beating hardness</td><td>Costs more; verify the slab — some "quartzites" are mislabeled softer stone</td></tr>
    <tr><td>Marble</td><td>The classic — depth and veining nothing imitates</td><td>Soft and reactive: lemon juice and wine etch it. Patina is the price of admission</td></tr>
    <tr><td>Soapstone</td><td>Matte charcoal, ages to a rich dark patina</td><td>Scratches and dents easily (and sands out easily); a hands-on owner's stone</td></tr>
  </tbody>
</table>
<p>Two clarifications the aisle confuses: <strong>quartzite is not quartz</strong> — it's a natural metamorphic stone, among the hardest counters you can buy — and "granite needs constant maintenance" is a decade out of date; modern penetrating sealers make it a minor annual chore, not a lifestyle.</p>

<h2>Durability: the real-world scorecard</h2>
<ul>
  <li><strong>Scratches:</strong> quartzite and granite laugh at knives (your knives lose); quartz resists well; marble and soapstone scratch — one hides it in patina, one considers it character.</li>
  <li><strong>Stains:</strong> quartz wins outright — nothing penetrates. Sealed granite and quartzite are close behind. Unsealed stone drinks wine and oil.</li>
  <li><strong>Heat:</strong> the clean quartz loss. A hot pan straight off the burner can scorch resin permanently; natural stone takes it without comment. (Use trivets on everything anyway — thermal shock can crack any slab — but stone forgives the lapse.)</li>
  <li><strong>Chips and impact:</strong> roughly even; edges and sink corners are every material's weak point, and all of them repair.</li>
  <li><strong>Etching:</strong> marble-only (and travertine/limestone kin): acids dull the polish on contact. It's chemistry, not damage — but if water rings on day 30 will bother you, marble is the wrong stone.</li>
</ul>

<h2>Looks and aging: perfection vs. singularity</h2>
<p>This is the real decision. <strong>Quartz on day 3,000 looks like quartz on day 3</strong> — same color, same pattern, and the sample you approved is the counter you get. <strong>Natural stone is a one-off</strong> — you pick the actual slab, veins and all, and it ages: granite imperceptibly, soapstone and marble visibly and (to their owners) beautifully. Neither answer is wrong; one is a finish, the other is a relationship. If you're pairing the counter with tile, the same fork shows up in our <a href="/guides/how-to-choose-porcelain-tile">porcelain guide</a> — engineered consistency vs. natural variation runs through every surface in the house.</p>

<h2>What they cost</h2>
<p>Installed, in the Orange County market, the two families overlap far more than the marketing suggests: <strong>quartz typically $50–$100 per square foot, granite $45–$100, quartzite $70–$150, marble $60–$150+</strong> — the slab's grade and drama move price more than the material category does. Builder-grade granite is often the cheapest real-stone entry; designer quartz lines out-price mid-tier quartzite. Full component math (fabrication, cutouts, tear-out, prefab-vs-custom) is in our <a href="/guides/countertop-installation-cost-orange-county">countertop cost guide</a>.</p>

<h2>Choosing by how you actually live</h2>
<ul>
  <li><strong>Busy family kitchen, set-and-forget:</strong> quartz. The no-sealing, no-thinking surface.</li>
  <li><strong>Serious cook, pans landing hot:</strong> granite or quartzite.</li>
  <li><strong>Statement island, one-of-a-kind veining:</strong> quartzite (durable drama) or marble (accepting the patina).</li>
  <li><strong>Baths and vanities:</strong> anything goes — even marble lives easily where lemon juice doesn't. Pair with <a href="/guides/choosing-bathroom-floor-tile">the right bathroom tile</a>.</li>
  <li><strong>Outdoor kitchens and sun-drenched rooms:</strong> granite, quartzite, or porcelain slab — quartz's resin rules it out.</li>
  <li><strong>Mixed strategy</strong> (the designer default): quartz on the hardworking perimeter, the showpiece slab on the island.</li>
</ul>

<h2>The 60-second checklist</h2>
<ul>
  <li><strong>Hot pans or outdoor use?</strong> Natural stone or porcelain — not quartz.</li>
  <li><strong>Zero maintenance non-negotiable?</strong> Quartz.</li>
  <li><strong>Buying natural stone? Pick the actual slab,</strong> not a sample — and view it vertical, in good light.</li>
  <li><strong>Marble: do the lemon test</strong> on an offcut and decide how you feel about etching before you commit.</li>
  <li><strong>Get sealing reality in writing:</strong> which sealer, how often — it's minutes a year, not a burden.</li>
  <li><strong>Compare bids by the piece:</strong> slab, fabrication, cutouts, install — the <a href="/guides/countertop-installation-cost-orange-county">cost guide</a> shows the line items.</li>
</ul>`,
  footer_html: `<p>Swatches can't show you a slab's veining, and brochures won't mention the resin. <strong>Roma Flooring Designs</strong> carries quartz, granite, quartzite, marble, and porcelain slab options at our Anaheim showroom (1440 S. State College Blvd, Suite 6M) — bring your cabinet color and kitchen dimensions, stand the slabs up in real light, and we'll quote fabrication and installation on the spot. <a href="/installation">Book a free consultation</a> or call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['quartz-countertops', 'natural-stone', 'quartzite-countertops', 'marble-countertops'],
    angle: 'durability, maintenance/sealing, heat/scratch, look, cost.',
    faq: [
      ['Which is better: quartz or granite countertops?',
       'Neither is better — they trade different strengths. Quartz is non-porous and maintenance-free but can scorch under hot pans and yellow in strong UV; granite handles heat and sun effortlessly but wants a quick sealer wipe-down roughly once a year. Family kitchens lean quartz; serious cooks and outdoor kitchens lean stone.'],
      ['Is quartzite the same as quartz?',
       'No. Quartz is an engineered slab of ground stone in resin; quartzite is a natural metamorphic stone — one of the hardest countertop materials available, with marble-like veining and granite-beating scratch resistance. It costs more and, being natural, each slab is unique.'],
      ['Do granite countertops really need sealing?',
       'Yes, but it\'s minor: modern penetrating sealers are a 15-minute wipe-on/wipe-off job about once a year (the water-drop test tells you when — if water stops beading, reseal). The "high-maintenance granite" reputation is a decade out of date.'],
      ['Can you put hot pans on quartz countertops?',
       'No — the polymer resin in quartz can scorch or discolor permanently under direct high heat, and that damage isn\'t warrantied. Natural stone tolerates hot cookware far better, though trivets are smart practice on any surface because thermal shock can crack slabs.'],
      ['Does marble make a bad kitchen countertop?',
       'Not bad — demanding. Marble etches on contact with acids (lemon, wine, vinegar) and scratches more easily than granite or quartzite, developing a patina over time. If that aging appeals to you, marble is glorious; if it would read as damage, choose quartzite or a marble-look quartz.'],
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
