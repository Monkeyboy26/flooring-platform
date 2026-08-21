#!/usr/bin/env python3
"""
Build Icon Tile images.json by matching catalog products to icontileus.com photos.

icontileus.com is WooCommerce; its **Store API is open**:
  https://icontileus.com/wp-json/wc/store/v1/products?per_page=100&page=N
returns every product (443) with an images[] array. mod_security blocks default UAs on
the API path, so we send a browser User-Agent. The image files under /wp-content/uploads
hotlink fine (Roma's resize proxy fetches them 200), so we store the vendor URLs directly.

Matching (high precision — a wrong photo is worse than none):
  1. SKU embedded in the Woo product name ("Astro Grey PP1412424R", ledger "#RF818GREY").
     Trailing finish letters (R, …) are stripped so PP1312424 <-> PP1312424R core-match.
  2. Catalog color tokens are a subset of the Woo name AND the form bucket matches AND the
     material agrees (guards single-word colors like "Beige" from crossing porcelain<->marble).
  3. Fallback: EXACT multi-token color match, any form, same material (same-stone representative).

Output: backend/data/icon/images.json  { "<product name>": {primary, gallery[], woo_name, match} }
Consumed by import-icon.js. Re-run after Icon adds products, then re-run import-icon.js.

Usage: python3 backend/scripts/build-icon-images.py
"""
import json, re, html, collections, os, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, '..', 'data', 'icon')
CATALOG = os.path.join(DATA_DIR, 'catalog.json')
OUT = os.path.join(DATA_DIR, 'images.json')
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
API = 'https://icontileus.com/wp-json/wc/store/v1/products?per_page=100&page='


def fetch_woo():
    prods, page = [], 1
    while True:
        req = urllib.request.Request(API + str(page), headers={'User-Agent': UA})
        batch = json.load(urllib.request.urlopen(req, timeout=30))
        if not batch:
            break
        prods += batch
        if len(batch) < 100:
            break
        page += 1
    seen = {p['id']: p for p in prods}
    return [{'id': p['id'], 'name': p['name'],
             'categories': [c['name'] for c in p.get('categories', [])],
             'images': [im['src'] if isinstance(im, dict) else im for im in p.get('images', [])]}
            for p in seen.values()]


STOP = set('''travertine limestone marble granite sandstone porcelain poecelain ceramic quartzite slate
basalt natural stone collection tile tiles paver pavers coping pool panel panels rockface rock face
stack stacked corner cap caps column wainscot sill sills pebble pebbles cobblestone flagstone walling
wall mosaic trim liner pencil needle crown colosseo step steps stair leathered leather tumbled honed
filled unfilled brushed chiseled flamed sandblasted distressed edge glossy glazed matte gloss single
sided double modern bullnose french roman versailles pattern mesh finish light dark and toros brickup
free length mini micro hexagon hex wavy flat splitface 3cm 2cm 1cm cm mm sizes size new products made
in usa deco art collection scabos'''.split())
SIZE = re.compile(r'^\d+([./x×]\d+)*("|”|″|in|cm)?$')
MATS = ['travertine', 'limestone', 'marble', 'granite', 'sandstone', 'porcelain', 'ceramic',
        'quartzite', 'slate', 'basalt']


def toks(s):
    s = html.unescape(s).lower().replace('×', 'x').replace('&', ' ')
    s = re.sub(r'#\S+', '', s)
    s = re.sub(r'[^a-z0-9 ]', ' ', s)
    return {t for t in s.split() if t not in STOP and not SIZE.match(t) and not t.isdigit()}


def matof(name):
    n = name.lower()
    return next((m for m in MATS if m in n), None)


def woo_bucket(cats, name=''):
    b = set()
    for c in cats:
        c = c.lower()
        if 'paver' in c: b.add('paver')
        elif 'coping' in c or 'stair' in c or 'step' in c: b.add('coping')
        elif 'ledger' in c or 'splitface' in c: b.add('ledger')
        elif 'mosaic' in c or 'trim' in c:
            b.add('trim' if is_trim_name(name) else 'mosaic')   # one Woo cat → split by name
        elif 'tile' in c: b.add('tile')
        elif any(k in c for k in ('flagstone', 'wall cap', 'column', 'wainscot', 'pebble', 'cobble')): b.add('hardscape')
    return b


MYFORM = {'paver': 'paver', 'coping': 'coping', 'ledger': 'ledger', 'mosaic': 'mosaic',
          'tile': 'tile', 'walling': 'hardscape', 'cap': 'hardscape', 'trim': 'trim'}

ALLOW_CROSSFORM = False   # cross-form color fallback (wrong-form photos) — kept off for correctness

# Icon lumps mosaics and trim into ONE Woo category ("Mosaics/Trim"), so the category alone
# can't tell a mosaic sheet from a pencil/liner. Disambiguate by keywords in the product NAME.
TRIM_KW = re.compile(r'\b(pencil|liner|rope|needle|crown|colosseo|chair rail|dome|quarter round|'
                     r'ogee|bullnose|base ?board|molding|moulding|trim|dot|listello|border)\b', re.I)
def is_trim_name(name):
    return bool(TRIM_KW.search(html.unescape(name)))


def skucore(x):
    return re.sub(r'[A-Z]+$', '', x.upper())


# Distinct color words used to reject a fuzzy (core-only) SKU match when the pricelist
# and the website disagree on what a SKU number means. Icon's feed vs site sometimes
# swap the trailing-letter suffix between two colors (e.g. pricelist PP1202424 = Tivoli
# Beige, but site PP1202424R = Tivoli Silver). An exact SKU match is trusted; a core-only
# match whose colors conflict is dropped so a color match can find the right-named product.
COLOR_WORDS = {'beige', 'silver', 'grey', 'gray', 'black', 'white', 'gold', 'ivory', 'cream',
               'blue', 'green', 'brown', 'charcoal', 'pearl', 'bone', 'navy', 'mixed', 'red',
               'ivory', 'antracite', 'anthracite', 'walnut', 'noce', 'cinnamon', 'rosal'}


def color_conflict(cat_color, woo_name):
    a = {t for t in re.sub(r'[^a-z ]', ' ', cat_color.lower()).split() if t in COLOR_WORDS}
    b = {t for t in re.sub(r'[^a-z ]', ' ', html.unescape(woo_name).lower()).split() if t in COLOR_WORDS}
    return bool(a and b and not (a & b))   # both name a color, but none in common


def main():
    cat = json.load(open(CATALOG))
    woo = fetch_woo()
    print(f'Fetched {len(woo)} Woo products')

    sku2prod, core2prod = {}, {}
    catcolor = {p['name']: p['color'] for p in cat}
    for p in cat:
        for s in p['skus']:
            vs = s['vendor_sku'].upper(); sku2prod[vs] = p['name']
            c = skucore(vs)
            if len(c) >= 6: core2prod.setdefault(c, p['name'])

    wtok = [(w, toks(w['name']), woo_bucket(w["categories"], w["name"]) or {'*'}) for w in woo if w['images']]
    skuhit = collections.defaultdict(list)
    for w in woo:
        if not w['images']: continue
        for m in re.findall(r'#?([A-Za-z]{1,4}\d[A-Za-z0-9]*)', html.unescape(w['name'])):
            mu = m.upper()
            if mu in sku2prod:
                skuhit[sku2prod[mu]].append(w)            # exact SKU — always trusted
            elif skucore(mu) in core2prod:
                pn = core2prod[skucore(mu)]
                if not color_conflict(catcolor[pn], w['name']):   # fuzzy — drop on color conflict
                    skuhit[pn].append(w)

    images, stats = {}, collections.Counter()
    for p in cat:
        ct = toks(p['color']); bucket = MYFORM.get(p['form'], '*'); mat = p['material'].lower()
        best = how = None
        if p['name'] in skuhit:
            best, how = skuhit[p['name']][0], 'sku'
        if not best and ct:
            cand = []
            for w, wt, wb in wtok:
                if bucket != '*' and bucket not in wb and '*' not in wb: continue
                wm = matof(w['name'])
                if wm and wm != mat: continue
                if ct <= wt: cand.append((len(wt - ct), len(w['name']), w))
            if cand:
                cand.sort(key=lambda x: (x[0], x[1])); best, how = cand[0][2], 'colorform'
        # Cross-form fallback (exact color, any form) DISABLED: it puts a field-tile photo
        # on a mosaic/trim/walling product etc. — same stone but wrong-looking product.
        # Only SKU + same-form color matches are kept (verified 0 color conflicts).
        if ALLOW_CROSSFORM and not best and len(ct) >= 2:
            cand = []
            for w, wt, wb in wtok:
                wm = matof(w['name'])
                if wm and wm != mat: continue
                if ct == wt: cand.append((len(w['name']), w))
            if cand:
                cand.sort(key=lambda x: x[0]); best, how = cand[0][1], 'coloronly'
        if best:
            stats[how] += 1
            imgs = best['images']
            images[p['name']] = {'primary': imgs[0], 'gallery': imgs[:6],
                                 'woo_name': html.unescape(best['name']), 'match': how}
        else:
            stats['MISS'] += 1

    json.dump(images, open(OUT, 'w'), indent=1)
    print('match stats:', dict(stats), '| matched', sum(v for k, v in stats.items() if k != 'MISS'), '/', len(cat))
    print('Wrote', OUT)


if __name__ == '__main__':
    main()
