#!/usr/bin/env python3
"""
Build Stone Pride catalog.json from the two 2026 price-list PDFs.

Stone Pride International Corp (Anaheim, CA distributor) — natural marble/stone +
engineered terrazzo. Product lines, keyed off the item-code prefix:

  Tile-<stone>   -> field tiles           (natural-stone / terrazzo-tile)
  MS-<stone>     -> mosaics (per sheet)    (mosaic-tile)
  FR-<stone>     -> chairrails/pencils/
                    baseboards/quarter rd  (trim-accessories, variant_type=accessory)
  MM-...         -> aluminum-backed marble medallions   (medallions  [NEW leaf])
  ML-...         -> waterjet marble borders (liners)     (trim-accessories, accessory)
  MSL-...        -> marble mosaic liners                 (trim-accessories, accessory)

Pricing: the "D+ Price" column is Stone Pride's dealer price = Roma's COST.
Retail = nearestNine(cost x 1.6) — store keystone + charm pricing. (Min cost is
$1.90, so 1.6x always clears the cost+$0.99 covering floor; no floor lift needed.)

Selling model (see [[natural-stone-per-piece]] / [[mosaic-per-sheet-conversion]]):
  * sqft-priced tile  -> sell_by=unit, price_basis=per_sqft, packaging.sqft_per_box
                         = area of ONE piece (price = rate x piece area at runtime)
  * piece-priced tile
    (hexagons) & trim
    & medallions
    & borders/liners  -> sell_by=unit, price_basis=per_unit (cost/retail per piece)
  * mosaics           -> sell_by=unit, price_basis=per_unit (cost/retail per SHEET),
                         packaging.sqft_per_box = sf/sheet, pieces_per_box=1

Vendor name is HIDDEN ([[hide-public-brand]]): import script sets hide_public_name.

Usage: python3 backend/scripts/build-stone-pride-catalog.py
Output: backend/data/stone-pride/catalog.json  (consumed by import-stone-pride.js)
"""
import re, json, os, sys, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT_DIR = os.path.join(ROOT, "backend", "data", "stone-pride")
os.makedirs(OUT_DIR, exist_ok=True)

PRINT_PDF = os.environ.get("SP_PRINT_PDF",
    os.path.expanduser("~/Downloads/SP Price list D+ Print 2026.pdf"))

# ---------------------------------------------------------------- pdf -> text
def pdftotext(path):
    return subprocess.check_output(["pdftotext", "-layout", path, "-"]).decode("utf-8", "replace")

# ---------------------------------------------------------------- helpers
def nearest_nine(v):
    cents = round(float(v) * 100)
    k = (cents - 9) // 10
    return max(9, k * 10 + 9) / 100.0

def retail_of(cost):
    return round(nearest_nine(cost * 1.6), 2)

# Stone display names, matched longest-code-first against the code remainder.
STONE = [
    ("AR-(new)", "Arabescato (New Quarry)"),
    ("Cont.CG", "Contempo Calacatta"),
    ("CWBM", "Carrara White & Black Marquina"),
    ("CWBY", "Carrara White & Blue Grey"),
    ("CWTW", "Carrara White & Thassos White"),
    ("CWSS", "Carrara White"),
    ("CGBY", "Calacatta Gold & Blue Grey"),
    ("CMED", "Crema Marfil & Emperador Dark"),
    ("TWBI", "Thassos White & Blue Grey"),
    ("TWBY", "Thassos White & Blue Grey"),
    ("EDEL", "Emperador Dark & Light"),
    ("ARdb", "Arabescato DanBa"),
    ("AG", "Pietra Grey"),
    ("AR", "Arabescato"),
    ("BA", "Black Absolute"),
    ("BG", "Black Galaxy"),
    ("BM", "Black Marquina"),
    ("CG", "Calacatta Gold"),
    ("CM", "Crema Marfil"),
    ("CW", "Carrara White"),
    ("ED", "Emperador Dark"),
    ("EL", "Emperador Light"),
    ("GW", "Guangxi White"),
    ("HB", "Haisa Black"),
    ("HO", "Honey Onyx"),
    ("NB", "Norway Blue"),
    ("NC", "Neo Calacatta"),
    ("NP", "North Pearl"),
    ("Onyx", "Onyx"),
    ("RA", "Rojo Alicante"),
    ("TB", "Tan Brown"),
    ("Terrazzo", "Terrazzo"),
    ("TW", "Thassos White"),
    ("WO", "White Oak (Haisa Light)"),
    ("Wave", "Wave"),
    ("WJ", "Waterjet Blend"),
]

def stone_of(code, prefix):
    rest = code[len(prefix):]
    for c, name in STONE:
        if rest == c or rest.startswith(c + "-") or rest.startswith(c + " ") or rest.startswith(c + "1") or rest.startswith(c):
            # guard: require the match to be a clean token boundary for short codes
            tail = rest[len(c):]
            if tail == "" or not tail[0].isalpha() or c in ("Onyx","Wave","Terrazzo","WJ"):
                return c, name
    return None, None

def finish_of(desc, code):
    d = desc.lower()
    # leading/explicit finish words
    if re.search(r'\btumbled?\b', d): return "Tumbled"
    if re.search(r'\bhoned\b', d): return "Honed"
    if re.search(r'\bpolished\b', d): return "Polished"
    # fall back to code suffix -H / -P / -T (before any paren tags)
    m = re.search(r'-(H|P|T)(?:\b|\(|$)', code)
    if m:
        return {"H":"Honed","P":"Polished","T":"Tumbled"}[m.group(1)]
    return None

def parse_sf_per_piece(desc):
    for pat in [
        r'1\s*pc\s*=\s*([\d.]+)\s*sf', r'([\d.]+)\s*sf\s*/\s*pc', r'([\d.]+)\s*sf/piece',
        r'([\d.]+)\s*sf/pc', r'([\d.]+)\s*sq\.?\s*ft\.?\s*/\s*piece', r'appx\.?\s*([\d.]+)\s*sq',
        r'([\d.]+)\s*SF/PC',
    ]:
        m = re.search(pat, desc, re.I)
        if m:
            try:
                v = float(m.group(1))
                if 0 < v < 20: return round(v, 4)
            except: pass
    m = re.search(r'(\d+)\s*pcs?\s*=\s*1\s*sf', desc, re.I)
    if m:
        n = int(m.group(1))
        if n > 0: return round(1.0/n, 4)
    return None

def parse_sf_per_sheet(desc):
    for pat in [
        r'([\d.]+)\s*SF\s*/\s*(?:Sheet|sheet|SHT|Shee|SHEET)',
        r'\{?Appx\.?\s*([\d.]+)\s*SF', r'=\s*([\d.]+)\s*SF/Sheet',
        r'([\d.]+)\s*sf/sheet', r'([\d.]+)\s*SF/sheet',
    ]:
        m = re.search(pat, desc, re.I)
        if m:
            try:
                v = float(m.group(1))
                if 0 < v < 5: return round(v, 4)
            except: pass
    return None

TRAIL_TAGS = ['(A+)','(D)','(GRN)','(BD)','(SU)','(GO)','(A2)','(A3)','(A4)','(A5)','(EL)','(RA)','(Burg-Red)','(burg-red)','(Blue)','(Dark blend)','(few white veins']

def fmt_of(code, prefix, stone_code):
    f = code[len(prefix):]
    if stone_code and (f.startswith(stone_code)):
        f = f[len(stone_code):]
    f = f.lstrip('-').lstrip()
    # strip trailing paren tags (possibly several)
    f = re.sub(r'(\s*\([^)]*\)\s*)+$', '', f).strip()
    # strip trailing thickness like -8mm / -7mm
    f = re.sub(r'[-\s](\d+mm)$', '', f).strip()
    # strip trailing finish suffix -H/-P/-T
    f = re.sub(r'[-\s](H|P|T)$', '', f).strip()
    f = re.sub(r'[-\s](H|P|T)$', '', f).strip()  # twice for e.g. "-H-P"
    f = f.strip(' -')
    # prettify
    pretty = re.sub(r'\s+', ' ', f.replace('-', ' ')).strip()
    return pretty

BORDER_DESIGNS = {'harmony', 'daphne', 'aroma', 'olympus', 'grace', 'carolina',
                  'casablanca', 'crescent', 'aquielia', 'simplicity', 'celebration',
                  'gardena', 'cascade', 'nostalgia'}
def border_variant(code, desc, pfx):
    """Readable border/liner variant: '<Design or Design NN>[ WxH][ Corner]'."""
    rest = code[len(pfx):]
    corner = 'corner' in (code + ' ' + desc).lower()
    design = None
    m = re.search(r'[Dd]esign(?:\s*name)?\s*[:\-]?\s*([A-Za-z]+)', desc)
    if m and m.group(1).lower() in BORDER_DESIGNS:
        design = m.group(1).title()
    if not design:                                   # substring: "Grace5x5Corner" -> Grace
        low = (rest + ' ' + desc).lower()
        for w in BORDER_DESIGNS:
            if w in low:
                design = w.title(); break
    num_m = re.match(r'(\d+)(?![xX])', rest)          # leading number, but not a size like 6x18
    num = num_m.group(1) if num_m else None
    sz_m = re.search(r'(\d+)\s*[xX]\s*(\d+)', code) or re.search(r'(\d+)"?\s*[xX]\s*(\d+)"?', desc)
    size = f'{sz_m.group(1)}×{sz_m.group(2)}' if sz_m else None
    base = design or (f'Design {num}' if num else re.sub(r'\(.*', '', rest).strip(' -'))
    parts = [base]
    if size and size != '4×12' and (design or num):  # only size-qualify a real design/number
        parts.append(size)
    name = ' '.join(parts)
    if corner:
        name += ' Corner'
    return re.sub(r'\s+', ' ', name).strip()[:120]

def sanitize_sku(code):
    s = re.sub(r'[^A-Za-z0-9]+', '-', code).strip('-')
    return ("SP-" + s)[:120]

# ---------------------------------------------------------------- parse rows
def parse_print(text):
    lines = text.split("\n")
    UOM = {"sqft (sf)":"sf","piece (pc)":"pc","Sheet (sh)":"sh","each (ea)":"ea"}
    uom_alt = "|".join(re.escape(k) for k in UOM)
    row_re = re.compile(r'^(?P<code>.+?)\s+(?P<price>[\d,]+\.\d{2})\s+(?P<uom>'+uom_alt+r')\s*(?P<desc>.*)$')
    hdr_re = re.compile(r'^(?P<prefix>\S.*?)\s+Price\s+Unit \(UM\)\s*(?P<name>.*)$')
    rows, pending, started = [], [], False
    for ln in lines:
        if not started:
            if ln.strip().startswith("Item") and "D+ Price" in ln: started = True
            continue
        raw = ln.rstrip()
        if raw.strip() == "": pending = []; continue
        if "Price" in raw and "Unit (UM)" in raw and hdr_re.match(raw):
            pending = []; continue
        m = row_re.match(raw)
        if m:
            desc = re.sub(r'\s+', ' ', (" ".join(pending) + " " + m.group("desc")).strip()).strip()
            rows.append({"code": m.group("code").strip(),
                         "cost": float(m.group("price").replace(",","")),
                         "uom": UOM[m.group("uom")], "desc": desc})
            pending = []
        else:
            pending.append(raw.strip())
    return rows

PREFIXES = ["Tile-","MSL-","ML-","MS-","MM-","FR-"]
def prefix_of(code):
    for p in PREFIXES:
        if code.startswith(p): return p
    return None

# ---------------------------------------------------------------- medallion design
_NAME_FIX = {"NStar":"North Star","Nstar":"North Star",
             "AugustGreen":"August Green","MysticView":"Mystic View",
             "LilysCrown":"Lily's Crown","GreenO":None}
_STOP = {"rect","oval","corner","round","square","squared","white","medallion",
         "custom","x","mm","ft","triangular","simplified","repaired","light","black",
         "silvermk","bw","go","ed","tr","el","ra","burg","red"}
def medallion_design(code, desc):
    rest = code[3:]                       # after "MM-"
    rest = re.sub(r'\(.*?\)', '', rest)   # drop paren color notes first
    rest = rest.replace('/', ' ')
    names = []
    for t in re.split(r'[-\s.]+', rest):
        t = t.strip(' .')
        if len(t) < 2: continue                          # finish letters (P/H/T), stray 'A'
        if re.match(r'^\d', t): continue                 # size / index (36RD, 3x5, 022)
        if re.match(r'^[A-Za-z]{1,3}\d+$', t): continue  # index (A001, CZ001)
        if re.match(r'^[A-Z]{2,3}$', t): continue        # index letters (CZ, TR, ED, BW)
        if t.lower() in _STOP: continue
        names.append(t)
    if not names:
        first = re.split(r'[-\s]+', rest)[0]
        return {"Mini":"Mini"}.get(first)
    design = ' '.join(names)
    design = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', design).strip()   # AugustGreen -> August Green
    design = _NAME_FIX.get(design.replace(' ', ''), design)
    return design or None

# ---------------------------------------------------------------- build
def main():
    text = pdftotext(PRINT_PDF)
    rows = parse_print(text)

    products = {}   # key -> product dict
    def get_product(key, name, collection, category_slug, description):
        if key not in products:
            products[key] = {"name": name, "collection": collection,
                             "category_slug": category_slug, "description": description,
                             "skus": []}
        return products[key]

    unmapped = []
    for r in rows:
        code, cost, uom, desc = r["code"], r["cost"], r["uom"], r["desc"]
        pfx = prefix_of(code)
        retail = retail_of(cost) if cost and cost > 0 else None
        status = "active" if retail else "inactive"

        if pfx in ("Tile-","MS-","FR-"):
            sc, sname = stone_of(code, pfx)
            if not sc:
                unmapped.append(code); continue
            fin = finish_of(desc, code)
            fmt = fmt_of(code, pfx, sc)
            is_terrazzo = (sc == "Terrazzo")
            mat = "" if is_terrazzo else "Marble "

            if pfx == "Tile-":
                ptype, cat = "tile", ("terrazzo-tile" if is_terrazzo else "natural-stone")
                pname = f"{sname} {mat}Tile".replace("  ", " ")
                vtype = None
                if uom == "sf":
                    sell_by, basis = "unit", "per_sqft"
                    spp = parse_sf_per_piece(desc)
                    pkg = {"sqft_per_box": spp, "pieces_per_box": 1} if spp else None
                else:  # pc (hexagons)
                    sell_by, basis = "unit", "per_unit"
                    spp = parse_sf_per_piece(desc)
                    pkg = {"sqft_per_box": spp, "pieces_per_box": 1} if spp else None
            elif pfx == "MS-":
                ptype, cat = "mosaic", "mosaic-tile"
                pname = f"{sname} {mat}Mosaic".replace("  ", " ")
                vtype, sell_by, basis = None, "unit", "per_unit"
                sps = parse_sf_per_sheet(desc)
                pkg = {"sqft_per_box": sps, "pieces_per_box": 1} if sps else None
            else:  # FR- trim
                ptype, cat = "trim", "trim-accessories"
                pname = f"{sname} Marble Trim & Moldings"
                vtype, sell_by, basis, pkg = "accessory", "unit", "per_unit", None

            variant = (fmt or "").strip()
            if fin and fin.lower() not in variant.lower():
                variant = (variant + (", " if variant else "") + fin)
            variant = variant or (fin or "Standard")
            key = (ptype, sc)
            prod = get_product(key, pname, sname, cat,
                               f"{sname} natural {'terrazzo' if is_terrazzo else 'marble'} "
                               f"{'mosaic' if ptype=='mosaic' else ('trim' if ptype=='trim' else 'tile')}.")
            prod["skus"].append({
                "vendor_sku": code, "internal_sku": sanitize_sku(code),
                "variant_name": variant[:120], "sell_by": sell_by, "variant_type": vtype,
                "cost": cost, "retail": retail, "price_basis": basis, "status": status,
                "packaging": pkg, "attrs": {k:v for k,v in (("finish",fin),) if v},
                "desc": desc,
            })

        elif pfx == "MM-":
            design = medallion_design(code, desc)
            if design:
                pname = design   # collection "Marble Medallions" supplies the type; avoids
                key = ("medallion", design.lower())   # "Marble Medallions Grace Marble Medallion"
            else:
                pname = "Aluminum-Backed"
                key = ("medallion", "_misc")
            # variant name = size/shape phrase from the description (design is the product)
            ms = re.search(r'(\d[\d.\'"\s]*(?:ft)?\s*(?:x\s*\d[\d.\'"\s]*(?:ft)?)?\s*(?:Round|Square|Squared|Oval|Rectangular|Rect\.?|Corner))', desc, re.I)
            vname = re.sub(r'\s+', ' ', ms.group(1)).strip() if ms else re.sub(r'[-\s]+', ' ', code[3:]).strip()
            prod = get_product(key, pname, "Marble Medallions", "medallions",
                               "Aluminum-backed waterjet marble medallion (made to order).")
            prod["skus"].append({
                "vendor_sku": code, "internal_sku": sanitize_sku(code),
                "variant_name": vname[:120], "sell_by": "unit", "variant_type": None,
                "cost": cost, "retail": retail, "price_basis": "per_unit", "status": status,
                "packaging": None, "attrs": {}, "desc": desc,
            })

        elif pfx == "ML-":
            prod = get_product(("border","ml"), "Waterjet Marble Borders", "Marble Borders",
                               "borders", "Waterjet marble border / liner strip (4\"x12\" typical).")
            prod["skus"].append({
                "vendor_sku": code, "internal_sku": sanitize_sku(code),
                "variant_name": border_variant(code, desc, pfx), "sell_by": "unit",
                "variant_type": None, "cost": cost, "retail": retail,   # own 'borders' category → browsable (not a linked accessory)
                "price_basis": "per_unit", "status": status, "packaging": None,
                "attrs": {}, "desc": desc,
            })
        elif pfx == "MSL-":
            prod = get_product(("liner","msl"), "Marble Mosaic Liners", "Marble Borders",
                               "borders", "Marble mosaic liner / border (10mm mosaic pieces on 4\"x12\").")
            prod["skus"].append({
                "vendor_sku": code, "internal_sku": sanitize_sku(code),
                "variant_name": border_variant(code, desc, pfx), "sell_by": "unit",
                "variant_type": None, "cost": cost, "retail": retail,   # own 'borders' category → browsable (not a linked accessory)
                "price_basis": "per_unit", "status": status, "packaging": None,
                "attrs": {}, "desc": desc,
            })
        else:
            unmapped.append(code)

    # -------- terrazzo in-stock 1-pager (3 new colors, hardcoded structure) ----
    TERR_PDF = os.environ.get("SP_TERR_PDF",
        os.path.expanduser("~/Downloads/Price list 2026 in-stock terrazzo items - D+ Cost.pdf"))
    terr_colors = [
        ("SP1870", {"24x24":7.90, "12x24":7.90, "4x12":9.24, "6Hex":2.81}),
        ("SP6268", {"24x24":7.90, "12x24":7.90, "4x12":9.24, "6Hex":2.81}),
        ("SP20646",{"24x24":10.92,"12x24":10.92,"4x12":11.55,"6Hex":2.92}),
    ]
    sf_map = {"24x24":4.0, "12x24":2.0, "4x12":1.0}  # area per piece (sqft); 6Hex ~0.22 per pc
    for cid, sizes in terr_colors:
        pname = f"Terrazzo {cid} Tile"
        prod = get_product(("terrazzo_instock", cid), pname, "Terrazzo In-Stock",
                           "terrazzo-tile", f"In-stock terrazzo tile, color {cid}.")
        for sz, cost in sizes.items():
            is_hex = (sz == "6Hex")
            retail = retail_of(cost)
            code = f"SP-Terrazzo-{cid}-{sz}"
            prod["skus"].append({
                "vendor_sku": code, "internal_sku": sanitize_sku(code),
                "variant_name": ("6\" Hexagon" if is_hex else sz) + ", Polished",
                "sell_by": "unit", "variant_type": None, "cost": cost, "retail": retail,
                "price_basis": ("per_unit" if is_hex else "per_sqft"), "status": "active",
                "packaging": {"sqft_per_box": (0.22 if is_hex else sf_map[sz]), "pieces_per_box": 1},
                "attrs": {"finish":"Polished"}, "desc": f"Terrazzo {cid} {sz}, Polished, in-stock.",
            })

    catalog = list(products.values())
    # collision / integrity check on internal_sku
    seen = {}
    for p in catalog:
        for s in p["skus"]:
            if s["internal_sku"] in seen:
                print("!! DUP internal_sku:", s["internal_sku"], "<-", s["vendor_sku"], "&", seen[s["internal_sku"]])
            seen[s["internal_sku"]] = s["vendor_sku"]
    # stats
    nsku = sum(len(p["skus"]) for p in catalog)
    from collections import Counter
    cat_counts = Counter()
    for p in catalog:
        cat_counts[p["category_slug"]] += len(p["skus"])
    json.dump(catalog, open(os.path.join(OUT_DIR, "catalog.json"), "w"), indent=1)
    print(f"Products: {len(catalog)}   SKUs: {nsku}")
    print("SKUs per category:", dict(cat_counts))
    print("Unmapped codes:", len(unmapped))
    for c in unmapped[:30]: print("   !", c)
    # sample medallion products
    med = [p for p in catalog if p["category_slug"]=="medallions"]
    print(f"\nMedallion products: {len(med)}  (sample names)")
    for p in sorted(med, key=lambda x:-len(x["skus"]))[:15]:
        print(f"   {len(p['skus']):2d}  {p['name']}")

if __name__ == "__main__":
    main()
