#!/usr/bin/env python3
"""Match Icon MOSAIC / TRIM / COPING SKUs to per-variant vendor photos (SKU-LEVEL images).

Icon mosaics are ONE product per color carrying many format SKUs (1x1, 1x2, 2x2,
2x2 Wavy, 2x4, Mini Pattern, Herringbone ...). The product-level image pass
(build-icon-images.py) gives every format the SAME photo, so on the PDP all the
formats look identical. The vendor actually photographs each format as its own
WooCommerce product ("Autumn Leaves Wavy 2x2", "Autumn Leaves Mini Pattern", ...),
reachable via the open Store API.

Pool COPING has the same problem along a different axis: one product per stone
carries Bullnose, Modern (square-edge) and Step SKUs, but the vendor photographs
each EDGE PROFILE as its own Woo product ("Aqua Dolce Flamed Bullnose Coping" vs
"Aqua Dolce Flamed Modern Coping"; travertines: "X Modern Travertine Pool Coping"
vs plain "X Travertine Pool Coping" = the tumbled bullnose bundle). Without this
pass every Bullnose variant showed whichever profile won the product-level image.
Step SKUs (L*SCHAIR/L*DCHAIR) map to the "Single-Step / Double-Step Chair Rail"
Woo products.

This script pulls every Icon product from the Store API, and for each mosaic/trim/
coping SKU in the catalog finds the vendor product whose (size, pattern-modifier)
or (edge profile) matches, writing
  backend/data/icon/sku-images.json  ->  { vendor_sku: {primary, gallery, woo} }
which import-icon.js attaches as SKU-level media_assets (they win over the shared
product image in the storefront's sku-image-first resolution).

Matching is exact on (size token, pattern-modifier set) so a plain "2x2" never grabs
the "Wavy 2x2" photo and vice-versa; finish words (Tumbled) are ignored as noise for
mosaics but used as a TIEBREAK for copings (two Modern Woo products differing only
by finish, e.g. Indian Black Sandblasted vs Brushed & Tumbled).

Usage: python3 backend/scripts/build-icon-sku-images.py
"""
import json, re, os, urllib.request

BASE = 'https://icontileus.com/wp-json/wc/store/v1/products'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data', 'icon')

# Pattern modifiers that make a mosaic format visually distinct. Finish words
# (tumbled/honed/brushed) are deliberately NOT here — they don't change the layout.
PATTERN_MODS = ['split face', 'splitface', 'wavy', 'herringbone', 'diamond', 'interlock',
                'hexagon', 'micro', 'mesh', 'random', 'mini']
# Non-mosaic Woo products we never want to match a mosaic SKU to.
EXCLUDE = ['paver', 'coping', 'ledger', 'chair rail', 'liner', 'moulding', 'crown',
           'pencil', 'bullnose', 'french pattern', 'roman pattern', 'filled', 'honed',
           'brushed', 'chiseled', 'free length', 'single sizes', 'tumbled tiles',
           'tumbled tile', 'wall cap', 'column cap', 'wainscot']
# Trim products bundle several PROFILE SKUs (needle/pencil/crown/colosseo/bullnose/rope);
# the vendor photographs each profile separately. Never match a trim SKU to these forms.
TRIM_EXCLUDE = ['paver', 'coping', 'ledger', 'mosaic', 'wall cap', 'column cap',
                'wainscot', 'flagstone', 'pool', 'tile']
# Coping SKUs must only match coping-form Woo products (never the same stone's paver/
# ledger/mosaic); steps are matched from their own pool, so keep them out of this one.
COPING_EXCLUDE = ['paver', 'ledger', 'mosaic', 'wall cap', 'column cap', 'wainscot',
                  'chair rail', 'step', 'tile', 'pencil', 'liner']
# Finish words — noise for mosaic format matching, but a TIEBREAK for copings where the
# vendor sells two same-profile products differing only by surface finish.
FINISH_WORDS = ['tumbled', 'sandblasted', 'brushed', 'leathered', 'leather', 'flamed',
                'honed', 'natural', 'glazed']
# A Woo page naming a DIFFERENT material than the catalog product is another stone that
# happens to share a color word ("Silver" travertine vs "Tivoli Silver" PORCELAIN paver;
# "White" marble vs "Quartzite White" porcelain). Guard only fires when the catalog
# material is itself in this list ('Natural Stone' products skip it — their Woo pages
# legitimately name the specific stone).
MATERIAL_WORDS = ['travertine', 'limestone', 'marble', 'sandstone', 'ceramic', 'porcelain',
                  'quartzite', 'slate', 'granite']
# Some vendor lines are renamed on the site; map our color -> the vendor's leading name.
# "Light" IS the vendor's name for Cordoba Cream travertine trim/mosaic (its images are
# literally filed as Cordoba-Cream-*). 'Haisa Light' is a DIFFERENT stone — guarded below.
COLOR_ALIAS = {'cordoba cream': 'light',
               # price-list "Grand Canyon" rock-face ledgers = the site's "Grand Canyon Peak"
               # (same stone; the superset-color guard would otherwise block the Peak pages)
               'grand canyon': 'grand canyon peak'}


def coping_profile(text):
    """Edge profile of a coping variant. 'Modern' beats 'Bullnose' because a
    '4-Sided Modern' or 'Double Modern' name never contains 'bullnose'."""
    n = norm(text)
    if 'step' in n:     return 'step'
    if 'modern' in n:   return 'modern'
    if 'bullnose' in n: return 'bullnose'
    return None


def finish_score(a, b):
    """Shared finish words between two names — tiebreak for same-profile candidates."""
    na, nb = norm(a), norm(b)
    return sum(1 for w in FINISH_WORDS if w in na and w in nb)


def material_conflict(material, woo_name):
    mat = norm(material)
    if mat not in MATERIAL_WORDS:
        return False
    return any(m in woo_name for m in MATERIAL_WORDS if m != mat)


def trim_type(text):
    """Profile of a trim piece, shared vocabulary between our variant_name and Woo names.
    Order matters: 'needle'/'rope'/'pencil' before the generic 'liner'/'bullnose'."""
    n = norm(text)
    if 'needle' in n:   return 'needle'
    if 'colosseo' in n: return 'colosseo'
    if 'crown' in n:    return 'crown'
    if 'rope' in n:     return 'rope'
    if 'pencil' in n:   return 'pencil'
    if 'chair rail' in n: return 'chair rail'
    if 'bullnose' in n or 'liner' in n: return 'bullnose'
    return None


def unescape(s):
    return (s or '').replace('&#215;', 'x').replace('&#8243;', '"') \
                    .replace('&#8242;', "'").replace('&amp;', '&').replace(' ', ' ')


def norm(s):
    s = re.sub(r'\s+', ' ', unescape(s).lower()).strip()
    # collapse two-word spellings so catalog and Woo tokens agree
    return s.replace('rock face', 'rockface').replace('split face', 'splitface')


def size_tok(s):
    m = re.search(r'(\d+)\s*[x×]\s*(\d+)', s)
    return f'{m.group(1)}x{m.group(2)}' if m else None


def mods(s):
    s = norm(s)
    found = set()
    for p in PATTERN_MODS:
        if p in s:
            found.add(p.replace(' ', ''))   # "split face" -> "splitface"
    return found


def color_base(color):
    """Catalog color -> vendor color words, e.g. 'Autumn Leaves (Scabos)' -> 'autumn leaves'."""
    c = re.sub(r'\([^)]*\)', '', color or '')   # drop the (Scabos) alias
    return norm(c)


def fetch_all():
    out, page = [], 1
    while True:
        req = urllib.request.Request(f'{BASE}?per_page=100&page={page}', headers={'User-Agent': UA})
        data = json.load(urllib.request.urlopen(req, timeout=30))
        if not data:
            break
        out += data
        if len(data) < 100:
            break
        page += 1
    return out


def main():
    catalog = json.load(open(os.path.join(DATA, 'catalog.json')))
    woo = fetch_all()
    print(f'Fetched {len(woo)} vendor products.')

    # pre-normalize woo names once
    for w in woo:
        w['_n'] = norm(w.get('name'))
        w['_size'] = size_tok(w['_n'])
        w['_mods'] = mods(w['_n'])

    for w in woo:
        w['_trim'] = trim_type(w['_n'])

    # Every catalog color as a word set — used to keep a shorter color from stealing a
    # longer one's photos ("Noce" must not match "Noce Toros ..."; "Tundra" not "Blue Tundra").
    all_color_words = {tuple(color_base(p.get('color')).split()) for p in catalog if p.get('color')}

    def drop_superset_colors(cands, base):
        words = set(base.split())
        supers = [set(c) for c in all_color_words if set(c) > words]
        if not supers:
            return cands
        # whole-word tokens, not substrings — 'de' (De White) must not hit 'leathereD'
        return [w for w in cands
                if not any(sup <= set(re.findall(r'[a-z0-9]+', w['_n'])) for sup in supers)]

    def words_match(words):
        words = [t for t in words if any(c.isalnum() for c in t)]   # drop bare '-' tokens
        def has(w, t):
            # purely-numeric tokens need word boundaries: '4' (4 Lines) must not
            # substring-match the '4' inside a '6x24' size or an SKU code
            return re.search(r'\b' + t + r'\b', w['_n']) if t.isdigit() else t in w['_n']
        return drop_superset_colors(
            [w for w in woo if words and all(has(w, t) for t in words)], ' '.join(words))

    def color_candidates(color, full_name_first=False):
        """Woo products of the same color (honoring the rename alias).

        full_name_first (coping/paver/ledger/cap): the vendor uses the FULL color name for
        these pages ("Cordoba Cream Modern Travertine Pool Coping") but the alias for
        chair-rail steps ("Light Single-Step Chair Rail") — so return the union, full-name
        matches first, instead of letting the alias shadow the full-name products. Extra
        fallbacks for that path: vendor vocabulary ("6 Lines" -> "6 Row" ledgers), a
        " - suffix" qualifier ("Cordoba Cream - Light"), and the parenthesized alias
        ("Autumn Mix (California Gold)" -> the California Gold cap page)."""
        base = color_base(color)
        alias = COLOR_ALIAS.get(base)
        words = base.split()
        full = words_match(words)
        aliased = []
        if alias:
            # alias must be a LEADING standalone token ("Light 2x2", "Light Pencil Liner"),
            # and never the unrelated 'Haisa Light' stone.
            aliased = [w for w in woo if re.match(re.escape(alias) + r'\b', w['_n']) and 'haisa' not in w['_n']]
        if full_name_first:
            # Extra tiers are APPENDED (first tier stays preferred): the exact-name tier can
            # be non-empty yet miss a whole form ("Cordoba Cream - Light" matches the
            # "(Light)" pattern-tile pages but none of the ledger pages, which the vendor
            # names plain "Cordoba Cream"). "N Lines" colors skip the dash tier — the row
            # count is load-bearing and the bare name would pull the wrong-row-count pages.
            tiers = [full]
            if 'lines' in words:
                tiers.append(words_match(['row' if t == 'lines' else t for t in words]))
            elif ' - ' in base:
                tiers.append(words_match(base.split(' - ')[0].split()))
            merged = []
            for tier in tiers:
                merged += [w for w in tier if w not in merged]
            if not merged:
                m = re.search(r'\(([^)]+)\)', color or '')
                if m:
                    merged = words_match(norm(m.group(1)).split())
            return merged + [w for w in aliased if w not in merged]
        return aliased if alias else full

    def record(vsku, hit):
        imgs = [i['src'] for i in hit['images'] if i.get('src')]
        if not imgs:
            return False
        sku_images[vsku] = {'primary': imgs[0], 'gallery': imgs[:6], 'woo': unescape(hit.get('name'))}
        return True

    sku_images = {}
    matched = missed = 0
    miss_detail = []
    for p in catalog:
        form = p.get('form')
        if form not in ('mosaic', 'trim', 'coping', 'paver', 'ledger', 'cap'):
            continue
        cands = color_candidates(p.get('color'), full_name_first=(form not in ('mosaic', 'trim')))
        if not cands:
            for s in p['skus']:
                missed += 1; miss_detail.append(f"{p['name']} :: {s.get('variant_name','')}")
            continue
        if form == 'coping':
            # One Woo product per edge profile: 'modern' in the name = Modern; any other
            # coping page for the stone is the bullnose/tumbled product (filenames carry
            # BN/TPCBN). Steps live on separate "…-Step Chair Rail" / "Stair Step" pages.
            pool = [w for w in cands if w.get('images') and 'coping' in w['_n']
                    and not any(x in w['_n'] for x in COPING_EXCLUDE)
                    and not material_conflict(p.get('material'), w['_n'])]
            steps = [w for w in cands if w.get('images') and 'step' in w['_n'].replace('-', ' ')
                     and not material_conflict(p.get('material'), w['_n'])]
            for s in p['skus']:
                vn = s.get('variant_name', '')
                prof, hit = coping_profile(vn), None
                if prof == 'step':
                    which = 'double' if 'double' in norm(vn) else 'single'
                    named = [w for w in steps if which in w['_n'].replace('-', ' ')]
                    hit = (named or steps or [None])[0]
                elif prof:
                    sub = [w for w in pool
                           if ('modern' if 'modern' in w['_n'] else 'bullnose') == prof]
                    # finish tiebreak (e.g. Indian Black Modern: Sandblasted vs Brushed&Tumbled)
                    hit = max(sub, key=lambda w: (finish_score(vn, w['_n']), -len(w['_n'])),
                              default=None)
                if hit and record(s['vendor_sku'], hit):
                    matched += 1
                else:
                    missed += 1; miss_detail.append(f"{p['name']} :: {vn}")
        elif form == 'paver':
            # French/Roman Versailles PATTERN photos look nothing like a single-size paver;
            # the vendor pages them separately ("X French Pattern Tumbled Paver 3cm" vs
            # "X Single Sizes Tumbled Paver" / "X 16x24 ... Paver").
            pool = [w for w in cands if w.get('images') and 'paver' in w['_n'] and 'coping' not in w['_n']
                    and not material_conflict(p.get('material'), w['_n'])]
            for s in p['skus']:
                vn = s.get('variant_name', '')
                nv = norm(vn)
                if 'french' in nv or 'roman' in nv:
                    which = 'french' if 'french' in nv else 'roman'
                    hit = next((w for w in pool if which in w['_n'] and 'pattern' in w['_n']), None)
                else:
                    st = size_tok(nv)
                    sub = [w for w in pool if 'pattern' not in w['_n']]
                    # exact size page > 'single sizes'/generic (no size in the name) > another size
                    hit = max(sub, key=lambda w: ((w['_size'] == st) * 4 + ('single sizes' in w['_n']) * 2
                                                  + (w['_size'] is None), finish_score(vn, w['_n'])),
                              default=None)
                if hit and record(s['vendor_sku'], hit):
                    matched += 1
                else:
                    missed += 1; miss_detail.append(f"{p['name']} :: {vn}")
        elif form == 'ledger':
            # Flat panels, corners (dog-ear / L-shape) and 8x22 rock-face panels are all
            # photographed as separate Woo pages per color.
            ctx = [w for w in cands if w.get('images')
                   and ('ledger' in w['_n'] or 'stack stone' in w['_n'] or 'rockface' in w['_n']
                        or 'panel' in w['_n'])
                   and not any(x in w['_n'] for x in ('cap', 'coping', 'paver', 'mosaic', 'sill'))
                   and not material_conflict(p.get('material'), w['_n'])]
            corners = [w for w in ctx if 'corner' in w['_n']]
            rockface = [w for w in ctx if 'rockface' in w['_n'] and 'corner' not in w['_n']]
            flats = [w for w in ctx if 'corner' not in w['_n'] and 'rockface' not in w['_n']]
            for s in p['skus']:
                vn = s.get('variant_name', '')
                nv = norm(vn)
                if 'corner' in nv:
                    hit = corners[0] if corners else None
                elif 'rockface' in nv:
                    hit = rockface[0] if rockface else None
                else:
                    st = size_tok(nv)
                    hit = max(flats, key=lambda w: (w['_size'] == st, w['_size'] is None), default=None)
                if hit and record(s['vendor_sku'], hit):
                    matched += 1
                else:
                    missed += 1; miss_detail.append(f"{p['name']} :: {vn}")
        elif form == 'cap':
            # Wainscot sills have their own pages; wall + column caps usually share a
            # combined "Column Cap & Wall Cap" page (a dedicated wall-cap page wins if one exists).
            pool = [w for w in cands if w.get('images')
                    and ('cap' in w['_n'] or 'sill' in w['_n'] or 'wainscot' in w['_n'])
                    and not any(x in w['_n'] for x in ('coping', 'ledger', 'mosaic', 'paver'))
                    and not material_conflict(p.get('material'), w['_n'])]
            sills = [w for w in pool if 'sill' in w['_n'] or 'wainscot' in w['_n']]
            for s in p['skus']:
                vn = s.get('variant_name', '')
                nv = norm(vn)
                hit = None
                if 'sill' in nv or 'wainscot' in nv:
                    hit = sills[0] if sills else None
                elif 'column cap' in nv:
                    hit = next((w for w in pool if 'column cap' in w['_n']), None)
                elif 'wall cap' in nv:
                    ws = [w for w in pool if 'wall cap' in w['_n']]
                    hit = max(ws, key=lambda w: ('column' not in w['_n'], finish_score(vn, w['_n'])),
                              default=None)
                if hit and record(s['vendor_sku'], hit):
                    matched += 1
                else:
                    missed += 1; miss_detail.append(f"{p['name']} :: {vn}")
        elif form == 'mosaic':
            pool = [w for w in cands if w.get('images') and not any(x in w['_n'] for x in EXCLUDE)]
            for s in p['skus']:
                vn = s.get('variant_name', '')
                st, sm = size_tok(vn), mods(vn)
                hit = next((w for w in pool if w['_size'] == st and w['_mods'] == sm), None)
                if hit and record(s['vendor_sku'], hit):
                    matched += 1
                else:
                    missed += 1; miss_detail.append(f"{p['name']} :: {vn}")
        else:  # trim
            pool = [w for w in cands if w.get('images') and w['_trim']
                    and not any(x in w['_n'] for x in TRIM_EXCLUDE)]
            for s in p['skus']:
                vn = s.get('variant_name', '')
                tt = trim_type(vn)
                hit = next((w for w in pool if w['_trim'] == tt), None) if tt else None
                if hit and record(s['vendor_sku'], hit):
                    matched += 1
                else:
                    missed += 1; miss_detail.append(f"{p['name']} :: {vn}")

    out = os.path.join(DATA, 'sku-images.json')
    json.dump(sku_images, open(out, 'w'), indent=2, ensure_ascii=False)
    print(f'Matched {matched} mosaic+trim SKUs to per-format photos, {missed} unmatched.')
    if miss_detail:
        print('Unmatched (fall back to the shared product image):')
        for m in miss_detail:
            print('  -', m)
    print('Wrote', out)


if __name__ == '__main__':
    main()
