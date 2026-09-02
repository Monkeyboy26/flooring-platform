#!/usr/bin/env python3
"""
Match harvested stone-pride.com images (sp_images.json) to Stone Pride SKUs/products
and write:
  backend/data/stone-pride/images.json      product name -> {primary, gallery}
  backend/data/stone-pride/sku-images.json   vendor_sku  -> {primary, gallery}

The site names files inconsistently, so matching is PAGE-SECTION scoped and tries
several key forms per SKU:
  * mosaics/tiles/borders: filename embeds the item code (MS-CW-2-Hexagon,
    Tile-CW-12x24-Polished, ML-82-Carolina) -> code key, OR the bare stone+pattern
    with the type prefix dropped, OR the full stone NAME + pattern (Arabescato-1x3-
    Herringbone). Longest matching key wins; images are shared across finishes.
  * frames/trim: filename is bare <stonecode>-<profile> (CW-F1-P, ED-Baseboard-P)
    -> prefix-stripped key, scoped to frame/border pages.
  * medallions: filename is the DESIGN name (Grace-available-in..., Naptune-...,
    MM-24-48-SQ-Odyssey) -> design match (typo-normalized + fuzzy) to the design
    product.
Hotlinked https vendor URLs. 3 self-hosted terrazzo swatches preserved.

Run: python3 backend/scripts/match-stone-pride-images.py
"""
import json, re, os, difflib
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(ROOT, "backend", "data", "stone-pride")
IMG_JSON = os.environ.get("SP_IMG_OUT", "/private/tmp/claude-501/-Users-kianassarpour-Desktop-flooring-platform/99f40623-9d8d-48e9-a4bb-572cf664f98b/scratchpad/sp_images.json")

catalog = json.load(open(os.path.join(DATA, "catalog.json")))
images = json.load(open(IMG_JSON))

# stone code -> normalized display name (for the "stone name + pattern" filenames)
STONE_NAME = {
    "CW": "carrarawhite", "CM": "cremamarfil", "CG": "calacattagold", "TW": "thassoswhite",
    "AR": "arabescato", "ARDB": "arabescato", "BM": "blackmarquina", "BA": "blackabsolute",
    "BG": "blackgalaxy", "ED": "emperadordark", "EL": "emperadorlight", "HO": "honeyonyx",
    "RA": "rojoalicante", "HB": "haisa", "AG": "pietragrey", "NB": "norwayblue",
    "NC": "neocalacatta", "NP": "northpearl", "TB": "tanbrown", "GW": "guangxiwhite",
    "TERRAZZO": "terrazzo",
}
VOCAB = [
    (r'hexagon', 'hex'), (r'herringbone', 'herring'), (r'beveled|bevelled', 'bevel'),
    (r'octagon', 'oct'), (r'elongated', 'long'), (r'chevron', 'chev'), (r'chervon', 'chev'),
    (r'rhomboid', 'rhomb'), (r'basketweave|basket', 'basket'), (r'calcutta|calacatta|calccata', 'cal'),
    (r'pennyround|penny', 'penny'), (r'subway', ''), (r'polished', 'p'), (r'honed', 'h'),
    (r'tumbled', 't'), (r'available|design|marble|mosaic|pattern|italia|italy|spain|greek|greece', ''),
]
def norm(s):
    s = s.lower()
    s = re.sub(r'\.(jpg|jpeg|png)$', '', s)
    for pat, rep in VOCAB: s = re.sub(pat, rep, s)
    s = re.sub(r'[^a-z0-9]', '', s)
    return s
def https(u): return re.sub(r'^http://', 'https://', u) if u.startswith('http://') else u
def strip_finish(code):
    c = re.sub(r'(\([^)]*\))+', '', code)
    c = re.sub(r'[-\s]\d+mm$', '', c)
    c = re.sub(r'[-\s](H|P|T)$', '', c); c = re.sub(r'[-\s](H|P|T)$', '', c)
    return c.strip(' -')
def sku_finish(code):
    m = re.search(r'-(H|P|T)(?:\b|\(|$)', code)
    return {'H':'h','P':'p','T':'t'}.get(m.group(1)) if m else None

PFX = re.compile(r'^(MS|Tile|FR|ML|MSL|MM)-', re.I)
def stone_code(vs, pfx):
    rest = vs[len(pfx):]
    for c in sorted(STONE_NAME, key=len, reverse=True):
        if rest.upper().startswith(c):
            nxt = rest[len(c):len(c)+1]
            if nxt == '' or not nxt.isalpha() or c in ("TERRAZZO",):
                return c
    m = re.match(r'([A-Za-z().]+?)(?:-|\d)', rest)
    return (re.sub(r'\(.*$', '', m.group(1)).upper() if m else None)

def section(pages):
    s = ' '.join(pages).lower()
    for k in ['medallion', 'frame', 'border', 'terrazzo', 'waterjet', 'tile', 'mosaic', 'paver', 'glass']:
        if k in s: return k
    return 'other'
SEC_TYPES = {  # which item prefixes each page-section is allowed to match
    'mosaic': {'MS'}, 'waterjet': {'MS'}, 'glass': {'MS'}, 'tile': {'Tile'},
    'terrazzo': {'Tile', 'MS'}, 'frame': {'FR'}, 'border': {'ML', 'MSL'},
}

# ---------- build SKU keys (code / no-prefix / stone-name) grouped, per item type ----------
key_group = defaultdict(list)          # (itemtype, key) -> [vendor_sku]
sku_meta = {}
for p in catalog:
    for s in p["skus"]:
        vs = s["vendor_sku"]
        pm = PFX.match(vs)
        if not pm:  # terrazzo in-stock (SP-Terrazzo-*) handled via TERR overrides
            continue
        pfx = pm.group(0)[:-1]           # MS / Tile / FR / ML / MSL / MM
        itype = pfx.replace('-', '')
        sku_meta[vs] = {"finish": sku_finish(vs), "product": p["name"], "itype": itype,
                        "stone": stone_code(vs, pm.group(0))}
        base = strip_finish(vs)
        keys = set()
        keys.add(norm(base))                                  # frcwf1 / mscw2hex
        keys.add(norm(base[len(pm.group(0)):]))               # cwf1 / cw2hex  (prefix dropped)
        sc = sku_meta[vs]["stone"]
        if sc and sc.upper() in STONE_NAME:                   # arabescato1x3herring
            after = re.sub(r'^' + re.escape(sc) + r'-?', '', base[len(pm.group(0)):], flags=re.I)
            keys.add(norm(STONE_NAME[sc.upper()] + after))
        for k in keys:
            if len(k) >= 5:
                key_group[(itype, k)].append(vs)

# ---------- medallion designs ----------
DESIGN_FIX = {"augest": "august", "mistic": "mystic", "naptune": "neptune",
              "nothstar": "northstar", "milanlight": "milan", "milanblack": "milan"}
def norm_design(s):
    s = s.lower()
    s = re.sub(r'\.(jpg|jpeg|png)$', '', s)
    s = re.sub(r"['’]", '', s)
    s = re.sub(r'[^a-z]', '', s)
    for a, b in DESIGN_FIX.items(): s = s.replace(a, b)
    return s
med_design = {}     # normalized design -> product name
for p in catalog:
    if p["category_slug"] == "medallions" and p["name"] != "Aluminum-Backed Marble Medallion":
        d = norm_design(p["name"].replace(" Marble Medallion", ""))
        if d: med_design[d] = p["name"]
med_keys = list(med_design.keys())

_FILL = {'oval', 'round', 'square', 'squared', 'rect', 'rectangular', 'corner',
         'triangular', 'in', 'and', 'the', 'marble', 'medallion', 'simplified',
         'repaired', 'only', 'order', 'stone', 'names', 'collection', 'available', 'custom'}
def design_from_filename(fn):
    base = re.sub(r'\.(jpg|jpeg|png)$', '', fn)
    if re.match(r'MM-', base, re.I):                      # MM-24-48-SQ-Odyssey -> Odyssey
        return norm_design(re.split(r'[-_]', base)[-1])
    # cut trailing metadata (…-available…, …Stone-names…, …-collection…)
    base = re.split(r'(?i)[-_ ]?(available|custom|stone[-_ ]?names?|collection)', base)[0]
    base = re.sub(r'(?i)(available|custom|collection)', ' ', base)   # glued: "Sonomaavailable"
    base = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', base)                 # camelCase boundary
    toks = []
    for t in re.split(r'[-_\s]+', base):
        t = t.strip()
        if not t or re.match(r'^\d', t) or re.match(r'(?i)^\d*in$', t): continue
        if t.lower() in _FILL: continue
        toks.append(t)
    return norm_design(' '.join(toks))

# ---------- assign images ----------
sku_imgs = defaultdict(list)      # vendor_sku -> [(url, finish)]
med_prod_imgs = defaultdict(list) # product name -> [url]
for im in images:
    fn, url, sec = im["filename"], https(im["url"]), section(im["pages"])
    fk = norm(fn)
    imf = 'p' if re.search(r'polish', fn, re.I) else ('h' if re.search(r'hone', fn, re.I) else ('t' if re.search(r'tumbl', fn, re.I) else None))

    if sec == 'medallion':
        d = design_from_filename(fn)
        if not d or len(d) < 3: continue
        hit = med_design.get(d)
        if not hit:
            close = difflib.get_close_matches(d, med_keys, n=1, cutoff=0.84)
            hit = med_design[close[0]] if close else None
        if hit: med_prod_imgs[hit].append(url)
        continue

    allowed = SEC_TYPES.get(sec)
    # find the longest key (within allowed item types for this page) that prefixes fk
    best = None
    for (itype, k), vslist in key_group.items():
        if allowed and itype not in allowed: continue
        if fk.startswith(k):
            if best is None or len(k) > len(best[0]):
                best = (k, vslist)
    if best:
        for vs in best[1]:
            sku_imgs[vs].append((url, imf))

# ---------- build outputs ----------
sku_out = {}
for vs, lst in sku_imgs.items():
    fin = sku_meta.get(vs, {}).get("finish")
    ordered = sorted(lst, key=lambda t: (0 if (t[1] == fin or t[1] is None) else 1))
    urls = []
    for u, _ in ordered:
        if u not in urls: urls.append(u)
    sku_out[vs] = {"primary": urls[0], "gallery": urls[1:6]}

# per-stone overview swatches (fallback product hero)
STONE_SWATCH = {}
swatch_re = re.compile(r'^(CW|CM|CG|TW|AR|ARdb|BM|BA|BG|BL|ED|EL|EM|HO|RA|HB|HD|NB|NC|NP|TB|GW)[-_]', re.I)
for im in images:
    fn = im["filename"]
    if swatch_re.match(fn) and not PFX.match(fn):
        STONE_SWATCH.setdefault(swatch_re.match(fn).group(1).upper(), https(im["url"]))
for im in images:
    if re.match(r'terrazzo', im["filename"], re.I) and re.search(r'hex|24x24|12x24|blue|gold|silver', im["filename"], re.I):
        STONE_SWATCH.setdefault("TERRAZZO", https(im["url"])); break
SWATCH_ALIAS = {"ARDB": "AR", "CONT.CG": "CG", "CGBY": "CG", "CWBM": "CW", "CWBY": "CW",
                "CWTW": "CW", "CWSS": "CW", "CMED": "CM", "EDEL": "ED", "TWBI": "TW", "TWBY": "TW"}
def swatch_for(code):
    if not code: return None
    c = code.upper()
    return STONE_SWATCH.get(c) or STONE_SWATCH.get(SWATCH_ALIAS.get(c, ""))
def product_stone(p):
    for s in p["skus"]:
        vs = s["vendor_sku"]
        if "Terrazzo" in vs: return "TERRAZZO"
        m = PFX.match(vs)
        if m: return stone_code(vs, m.group(0))
    return None

prod_out = {}
n_from_sku = n_from_med = n_from_swatch = 0
for p in catalog:
    name = p["name"]
    if name in med_prod_imgs:                       # medallion design photo
        gal = []
        for u in med_prod_imgs[name]:
            if u not in gal: gal.append(u)
        prod_out[name] = {"primary": gal[0], "gallery": gal[1:6]}
        n_from_med += 1
        continue
    hero = None                                     # first SKU that got a photo
    for s in p["skus"]:
        if s["vendor_sku"] in sku_out:
            hero = sku_out[s["vendor_sku"]]["primary"]; break
    if hero:
        prod_out[name] = {"primary": hero}; n_from_sku += 1
    else:
        sw = swatch_for(product_stone(p))
        if sw: prod_out[name] = {"primary": sw}; n_from_swatch += 1

# preserve the 3 self-hosted terrazzo swatches
prod_out.update({
    "Terrazzo SP1870 Tile":  {"primary": "/uploads/stone-pride/terrazzo-sp1870.jpg"},
    "Terrazzo SP6268 Tile":  {"primary": "/uploads/stone-pride/terrazzo-sp6268.jpg"},
    "Terrazzo SP20646 Tile": {"primary": "/uploads/stone-pride/terrazzo-sp20646.jpg"},
})

json.dump(prod_out, open(os.path.join(DATA, "images.json"), "w"), indent=1)
json.dump(sku_out, open(os.path.join(DATA, "sku-images.json"), "w"), indent=1)

nsku = sum(len(p["skus"]) for p in catalog)
nmed = len([p for p in catalog if p["category_slug"] == "medallions"])
print(f"Harvested: {len(images)} images")
print(f"SKUs with a photo:    {len(sku_out)} / {nsku}")
print(f"Products with a hero:  {len(prod_out)} / {len(catalog)}  "
      f"(sku:{n_from_sku}  medallion:{n_from_med}  swatch:{n_from_swatch}  +3 terrazzo)")
print(f"Medallion products w/ photo: {n_from_med} / {nmed}")
