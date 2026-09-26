// Hand-authored pillar guide: Engineered vs Solid Hardwood.
//
// Replaces the short AI-generated body on /guides/engineered-vs-solid-hardwood with a
// comprehensive hand-written comparison (~1,600 words). Same standard as the other
// insert-*-guide scripts; leans on the Southern California slab-on-grade reality that
// decides most local hardwood projects.
//
//   node scripts/seo/insert-engineered-solid-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. FAQ stored as [q, a] pairs in filter_json.faq.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'engineered-vs-solid-hardwood',
  title: 'Engineered vs Solid Hardwood: Which Is Right for You?',
  h1: 'Engineered vs. Solid Hardwood: Which Is Right for You?',
  meta_title: 'Engineered vs Solid Hardwood: Which Is Right for You? | Roma Flooring Designs',
  meta_description: 'Engineered vs. solid hardwood compared honestly — construction, concrete slabs, refinishing math, wide planks, cost installed, and which belongs in your home.',
  intro_html: `<p><strong>Here's the fact that surprises most hardwood shoppers: once they're installed, engineered and solid hardwood are the same floor to live on.</strong> Both have a surface of 100% real wood — same species, same grain, same feel underfoot. The difference is everything you can't see: what's under that surface, what subfloor it can go over, and how many times it can be sanded back to new.</p>
<p>In Southern California, one construction detail settles most of these decisions before style even comes up. Here's the honest comparison — and if you'd rather see the cross-sections in person, <a href="/installation">our Anaheim showroom</a> has both on the wall, cut edges exposed.</p>`,
  content_html: `
<h2>The 30-second answer</h2>
<div class="guide-callout"><p><strong>Choose engineered</strong> if your home sits on a concrete slab (most of Orange County does), you want wide planks, or you're installing over radiant heat. <strong>Choose solid</strong> if you have a wood subfloor, plan to stay for decades, and want a floor that can be re-sanded practically forever. When in doubt locally, engineered is the default for a reason.</p></div>

<h2>What each floor actually is</h2>
<p><strong>Solid hardwood</strong> is exactly what it sounds like: one board of oak, hickory, maple, or walnut, typically 3/4" thick, milled with a tongue and groove. All of that thickness above the tongue — usually about 1/4" — is sacrificial wear material you can sand and refinish again and again over the floor's 50-to-100-year life.</p>
<p><strong>Engineered hardwood</strong> puts a real-wood wear veneer — anywhere from about 1mm on budget lines to 4–6mm on premium ones — over a cross-laminated plywood core. That cross-grain construction is the whole point: wood expands and contracts across the grain, and stacking layers in alternating directions cancels most of that movement out. The result is a plank that stays flat where solid wood would cup, gap, or crown.</p>

<h2>Head to head</h2>
<table>
  <caption>Engineered vs. solid hardwood at a glance</caption>
  <thead><tr><th>Factor</th><th>Engineered</th><th>Solid</th></tr></thead>
  <tbody>
    <tr><td>Surface</td><td>100% real wood veneer</td><td>100% real wood, full thickness</td></tr>
    <tr><td>Over concrete slab</td><td>Yes — glue, float, or click</td><td>Not directly (needs a wood subfloor built up)</td></tr>
    <tr><td>Moisture/humidity stability</td><td>Excellent (cross-ply core)</td><td>Moves with the seasons</td></tr>
    <tr><td>Refinishing</td><td>0–3 sands (veneer-dependent)</td><td>4–6+ sands over its life</td></tr>
    <tr><td>Wide planks (7"+)</td><td>Handles them gracefully</td><td>Riskier — more movement</td></tr>
    <tr><td>Radiant heat</td><td>Most lines approved</td><td>Generally not recommended</td></tr>
    <tr><td>Material cost</td><td>$4–$9/sq ft typical</td><td>$6–$12/sq ft typical</td></tr>
    <tr><td>Lifespan</td><td>20–40+ years</td><td>50–100 years with refinishing</td></tr>
  </tbody>
</table>

<h2>The Southern California slab reality</h2>
<p>This is the section that decides most local projects. The majority of Orange County homes are built <strong>slab-on-grade</strong> — the floor under your floor is concrete. Solid hardwood must be nailed to a wood subfloor, so putting it over a slab means first building one: plywood sleepers or panels fastened over the concrete, adding height, cost, and transitions at every doorway. It's done, but you're paying for a subfloor before you've bought a floor.</p>
<p>Engineered hardwood was designed for exactly this situation. It glues directly to a properly prepped slab (or floats over an underlayment), tolerates the slab's minor moisture vapor with the right adhesive and testing, and keeps your floor height where the builder intended. If your home has a raised foundation with wood subfloors — common in older neighborhoods — solid becomes a genuine option, and a great one.</p>

<h2>The refinishing math</h2>
<p>Solid's headline advantage is refinishing headroom: with roughly 1/4" of wood above the tongue, it can take a full sand every 15–20 years essentially forever. That's how 80-year-old oak floors keep coming back to life.</p>
<p>Engineered refinishing depends entirely on the veneer: <strong>under 2mm, treat it as a no-sand floor</strong> (screen-and-recoat only — which refreshes the finish, not deep damage); <strong>3mm takes one or two careful sands; 4–6mm behaves like solid for two or three</strong>. Two honest counterpoints, though: modern factory finishes (aluminum-oxide urethanes) are far harder than anything applied on site, so today's floors need refinishing much less often than the floors your parents had — and most homeowners re-floor for style long before a quality engineered floor is sanded out. Pay for veneer thickness if the forever-floor math matters to you; skip it if you'll want a different look in 25 years anyway.</p>

<h2>Looks, widths, and where the styles have gone</h2>
<p>Because the core does the structural work, engineered handles today's popular formats — <strong>7" to 10" wide, extra-long planks, wire-brushed European oak</strong> — with a stability solid can't match at those widths. Solid keeps the edge in one respect: the classic 2¼"–5" strip floor, site-finished to a glass-smooth single plane, is still the traditional look some homes call for, and it's what you'll be matching if you're extending existing original hardwood. For finish choices — matte vs. satin, oil vs. urethane, wire-brushed textures — see our <a href="/guides/hardwood-flooring-finishes-explained">hardwood finishes guide</a>.</p>

<h2>What they cost installed</h2>
<p>Typical Orange County ranges, materials and labor combined: <strong>engineered runs about $9–$18 per square foot installed, solid about $12–$25</strong> — the gap comes from both the material and the labor (nail-down is slower, and slab homes add subfloor build-up for solid). Full component-by-component numbers, project examples, and what drives the price are in our <a href="/guides/cost-to-install-hardwood-floors-orange-county">hardwood installation cost guide</a>.</p>

<h2>Where each belongs — and where neither does</h2>
<ul>
  <li><strong>Living rooms, bedrooms, dens, hallways:</strong> either — this is hardwood's home turf.</li>
  <li><strong>Concrete slab homes:</strong> engineered, glued or floated.</li>
  <li><strong>Second stories over wood subfloors:</strong> either; engineered floats quietly over an acoustic pad.</li>
  <li><strong>Over radiant heat:</strong> engineered lines rated for it.</li>
  <li><strong>Kitchens:</strong> a judgment call — plenty of beautiful kitchens run hardwood, but drips and drops are part of life; finish maintenance matters.</li>
  <li><strong>Bathrooms and laundry rooms: neither.</strong> Wood and standing water don't negotiate — use <a href="/guides/best-waterproof-flooring">a genuinely waterproof floor</a> there, or get the wood look in <a href="/guides/lvp-vs-laminate">LVP</a> or wood-look porcelain.</li>
</ul>

<h2>The 60-second checklist</h2>
<ul>
  <li><strong>Concrete slab?</strong> Engineered. (Or budget for a built-up wood subfloor first.)</li>
  <li><strong>Refinishing matters?</strong> Solid — or engineered with a <strong>3mm+ veneer</strong>.</li>
  <li><strong>Wide planks (7"+)?</strong> Engineered.</li>
  <li><strong>Check the spec sheet:</strong> veneer thickness, core plies, and finish type — not just the photo.</li>
  <li><strong>Either floor:</strong> let it acclimate on site per the manufacturer, order ~10% overage from one lot (<a href="/guides/how-to-measure-a-room-for-flooring">measuring guide</a>), and keep the spares.</li>
</ul>`,
  footer_html: `<p>The cross-section tells the story better than any article. <strong>Roma Flooring Designs</strong> stocks engineered and solid hardwood side by side at our Anaheim showroom (1440 S. State College Blvd, Suite 6M) — bring your room dimensions and we'll check your subfloor situation, narrow the field, and quote supply or supply-and-install on the spot. <a href="/installation">Book a free consultation</a> or call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['engineered-hardwood', 'solid-hardwood', 'hardwood'],
    angle: 'construction, moisture/subfloor tolerance, refinishing, cost, where each works.',
    faq: [
      ['Is engineered hardwood real wood?',
       'Yes — the surface you see and walk on is 100% real hardwood, the same species and grain as solid. The difference is underneath: a cross-laminated plywood core that makes the plank far more stable over concrete slabs and through humidity swings.'],
      ['Can you refinish engineered hardwood?',
       'It depends on the wear veneer. Under 2mm, plan on recoating only; a 3mm veneer takes one or two careful sands; 4–6mm veneers can be refinished two or three times, similar to solid over a typical ownership span.'],
      ['Which is better on a concrete slab: engineered or solid hardwood?',
       'Engineered — it glues or floats directly over a properly prepped slab. Solid must be nailed to a wood subfloor, so slab homes need a plywood build-up first, which adds cost and floor height. Most Orange County homes are slab-on-grade, which is why engineered is the local default.'],
      ['Is solid hardwood worth the extra cost?',
       'If you have a wood subfloor and plan to stay long-term, yes — its 4–6+ refinishes give it a 50–100 year life. On a slab, or if you expect to update styles within a couple of decades, quality engineered delivers the same look and feel for less.'],
      ['Can you put hardwood in a bathroom or laundry room?',
       'We don\'t recommend it — engineered or solid, wood is damaged by standing water. Use porcelain tile or LVP in wet rooms and keep hardwood in living areas, bedrooms, and hallways.'],
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
