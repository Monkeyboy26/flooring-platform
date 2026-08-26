#!/usr/bin/env python3
"""Match Icon MOSAIC format SKUs to per-format vendor photos (SKU-LEVEL images).

Icon mosaics are ONE product per color carrying many format SKUs (1x1, 1x2, 2x2,
2x2 Wavy, 2x4, Mini Pattern, Herringbone ...). The product-level image pass
(build-icon-images.py) gives every format the SAME photo, so on the PDP all the
formats look identical. The vendor actually photographs each format as its own
WooCommerce product ("Autumn Leaves Wavy 2x2", "Autumn Leaves Mini Pattern", ...),
reachable via the open Store API.

This script pulls every Icon product from the Store API, and for each mosaic SKU in
the catalog finds the vendor product whose (size, pattern-modifier) matches, writing
  backend/data/icon/sku-images.json  ->  { vendor_sku: {primary, gallery, woo} }
which import-icon.js attaches as SKU-level media_assets (they win over the shared
product image in the storefront's sku-image-first resolution).

Matching is exact on (size token, pattern-modifier set) so a plain "2x2" never grabs
the "Wavy 2x2" photo and vice-versa; finish words (Tumbled) are ignored as noise.

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
# Some vendor lines are renamed on the site; map our color -> the vendor's leading name.
# "Light" IS the vendor's name for Cordoba Cream travertine trim/mosaic (its images are
# literally filed as Cordoba-Cream-*). 'Haisa Light' is a DIFFERENT stone — guarded below.
COLOR_ALIAS = {'cordoba cream': 'light'}


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
    return re.sub(r'\s+', ' ', unescape(s).lower()).strip()


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

    def color_candidates(color):
        """Woo products of the same color (honoring the rename alias)."""
        base = color_base(color)
        alias = COLOR_ALIAS.get(base)
        if alias:
            # alias must be a LEADING standalone token ("Light 2x2", "Light Pencil Liner"),
            # and never the unrelated 'Haisa Light' stone.
            return [w for w in woo if re.match(re.escape(alias) + r'\b', w['_n']) and 'haisa' not in w['_n']]
        words = base.split()
        return [w for w in woo if words and all(word in w['_n'] for word in words)]

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
        if form not in ('mosaic', 'trim'):
            continue
        cands = color_candidates(p.get('color'))
        if not cands:
            for s in p['skus']:
                missed += 1; miss_detail.append(f"{p['name']} :: {s.get('variant_name','')}")
            continue
        if form == 'mosaic':
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
