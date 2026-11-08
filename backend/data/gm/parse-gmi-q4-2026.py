#!/usr/bin/env python3
"""Parse GMI Q4 2026 price list PDF -> vendor_sku,new_cost CSV + diff vs DB.

Sections:
  p3  SINTERA        part + cols [Jumbo->SLAB, 26->P26, 37.5->P375, 43.5->P435, 52->P52]
  p4-5 PORCELAIN 12MM part(GMP/GMO) single price -> -SLAB
  p6-7 HYBRID 6MM     part(GMHS*) single price -> -SLAB ("SPECIAL ORDER" rows skipped)
  p8  3296            part single price -> -PANEL; kits -> 3296KIT-* ($895)
  p9  THINMAXX        exact sku, single price (first number = single unit)
  p10 SINKS           exact sku, price per blurb
  p11 CLEARANCE       two tables: Jumbo(126x63)->-J and Standard(120x55)->-S,
                      prefab cols 26/36/42/52 -> P26/P36/P42/P52

A part number can appear in BOTH Sintera (new production) and Clearance
(old quartz stock). DB disambiguates by collection: skus under
'Genuine Quartz — Clearance' price from p11, everything else from p3-10.
"""
import csv
import re
import subprocess
import sys

import pdfplumber

PDF = "GMI-Q4-2026-pricelist.pdf"
PART = re.compile(r"^(GQ[A-Z]\d{3})")
PRICE = re.compile(r"^\$(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)$")

pdf = pdfplumber.open(PDF)
sintera = {}    # (part, suffix) -> price   from p3
clearance = {}  # (part, suffix) -> price   from p11
flat = {}       # vendor_sku -> price       from p4-10


def rows_of(page):
    words = sorted(page.extract_words(y_tolerance=2), key=lambda w: (w["top"] + w["bottom"]) / 2)
    rows, cur, last_y = [], [], None
    for w in words:
        yc = (w["top"] + w["bottom"]) / 2
        if last_y is None or yc - last_y <= 3.5:
            cur.append(w)
        else:
            rows.append(cur); cur = [w]
        last_y = yc
    if cur: rows.append(cur)
    return [sorted(r, key=lambda w: w["x0"]) for r in rows]


def col_assign(page, col_defs, out, y_min=0, y_max=10_000):
    """col_defs: list of (x_center, suffix). Assign $ tokens to nearest column."""
    for row in rows_of(page):
        part = None
        for w in row:
            m = PART.match(w["text"])
            if m and w["x0"] < 150:
                part = m.group(1)
        if not part:
            continue
        yc = (row[0]["top"] + row[0]["bottom"]) / 2
        if not (y_min <= yc <= y_max):
            continue
        for w in row:
            m = PRICE.match(w["text"])
            if not m:
                continue
            xc = (w["x0"] + w["x1"]) / 2
            suffix = min(col_defs, key=lambda c: abs(c[0] - xc))[1]
            out[(part, suffix)] = float(m.group(1).replace(",", ""))


# ---- p3 SINTERA: find header x positions
p3 = pdf.pages[2]
w3 = p3.extract_words(y_tolerance=2)
def find_x(words, text, after=0):
    for w in words:
        if w["text"] == text and w["x0"] > after:
            return (w["x0"] + w["x1"]) / 2
    raise ValueError(text)
# header tokens: 26" 37.5" 43.5" 52" and Jumbo Slab / 127" x 64"
x_26 = find_x(w3, '26"')
x_375 = find_x(w3, '37.5"')
x_435 = find_x(w3, '43.5"')
x_52 = find_x(w3, '52"')
x_jumbo = find_x(w3, '127"') if any(w["text"] == '127"' for w in w3) else x_26 - 90
col_assign(p3, [(x_jumbo, "SLAB"), (x_26, "P26"), (x_375, "P375"), (x_435, "P435"), (x_52, "P52")], sintera)

# ---- p4-8: single-price rows (part# ... $price)
for pi, suffix_rule in [(3, "-SLAB"), (4, "-SLAB"), (5, "-SLAB"), (6, "-SLAB"), (7, "-PANEL")]:
    for row in rows_of(pdf.pages[pi]):
        part = None
        for w in row:
            if re.match(r"^(GMP\d{3}|GMO\d{3}|GMHS[CDE]\d{3}|GM3296\d{3})", w["text"]):
                part = re.match(r"^(GMP\d{3}|GMO\d{3}|GMHS[CDE]\d{3}|GM3296\d{3})", w["text"]).group(1)
        if not part:
            continue
        prices = [PRICE.match(w["text"]) for w in row]
        prices = [float(m.group(1).replace(",", "")) for m in prices if m]
        if len(prices) == 1:
            flat[part + suffix_rule] = prices[0]

# 3296 kits: $895 per blurb on p8
t8 = pdf.pages[7].extract_text() or ""
m = re.search(r"4-Piece Shower kit \(\$(\d+)\)", t8)
if m:
    kit_price = float(m.group(1))
    for color in ("ADAGIOWHITE", "ARIAGOLD", "FOSSILCROSSCUT", "ALABASTER", "FOGCROSS", "KAOLIN"):
        flat["3296KIT-" + color] = kit_price

# ---- p9 THINMAXX: "130 /115" style — first number is single-unit price
t9 = pdf.pages[8].extract_text() or ""
m = re.search(r"TMXHS-10.*?(\d{2,4})\s*/\s*\d{2,4}", t9, re.S)
if m: flat["TMXHS-10"] = float(m.group(1))
m = re.search(r"TMXPT-10.*?(\d{2,4})\s*/\s*\d{2,4}", t9, re.S)
if m: flat["TMXPT-10"] = float(m.group(1))

# ---- p10 SINKS: part tokens then $ price in following text
t10 = pdf.pages[9].extract_text() or ""
sink_prices = {
    "GQS1812": r"GQS1812.*?\$(\d+)",
    "GQSSK25WH": r"GQSSK25WH.*?\$(\d+)",
}
# layout is scattered; capture the known blurbs explicitly
pairs = re.findall(r"(GQS[\w/-]+).*?\$(\d+)", t10, re.S)
# fall back to manual reading below in diff — collect what regex finds
for name, price in pairs:
    for sku in name.split("/"):
        flat.setdefault(sku, float(price))

# ---- p11 CLEARANCE: two tables with different slab suffix
p11 = pdf.pages[10]
w11 = p11.extract_words(y_tolerance=2)
# split y at "Standard" header
y_std = min(w["top"] for w in w11 if w["text"] == "Standard")
xj = find_x(w11, '126"x63"')
x26c = find_x(w11, '108"x26"')
x36c = find_x(w11, '108"x36"')
x42c = find_x(w11, '108"x42"')
x52c = find_x(w11, '108"x52"')
col_assign(p11, [(xj, "J"), (x26c, "P26"), (x36c, "P36"), (x42c, "P42"), (x52c, "P52")],
           clearance, y_max=y_std)
xs = find_x(w11, '120"x55"')
x26s = find_x(w11, '108"x26"', after=0)  # same prefab columns repeat
col_assign(p11, [(xs, "S"), (x26c, "P26"), (x36c, "P36"), (x42c, "P42"), (x52c, "P52")],
           clearance, y_min=y_std)

print(f"sintera cells: {len(sintera)}, clearance cells: {len(clearance)}, flat: {len(flat)}", file=sys.stderr)

# ---- diff vs DB
res = subprocess.run(["docker", "exec", "flooring-db", "psql", "-U", "postgres", "-d", "flooring_pim",
    "-t", "-A", "-F", "|", "-c",
    "SELECT s.vendor_sku, COALESCE(p.collection,''), pr.cost, s.status "
    "FROM skus s JOIN products p ON p.id=s.product_id JOIN pricing pr ON pr.sku_id=s.id "
    "WHERE p.vendor_id='86a82f9b-8ffe-4069-b6d8-5c328ce5a609';"],
    capture_output=True, text=True, check=True)

changes, absent, unchanged = [], [], 0
for ln in res.stdout.splitlines():
    if not ln.strip():
        continue
    sku, coll, cost, status = ln.split("|")
    cost = float(cost)
    is_clear = "Clearance" in coll
    new = None
    if "-" in sku and PART.match(sku):
        part, suffix = sku.split("-", 1)
        new = clearance.get((part, suffix)) if is_clear else sintera.get((part, suffix))
        if new is None and not is_clear:
            new = flat.get(sku)
    else:
        new = flat.get(sku)
        if new is None and PART.match(sku):  # suffixless (sinks GQS1812 etc.)
            new = flat.get(sku)
    if new is None:
        absent.append((sku, coll, cost, status))
    elif abs(new - cost) < 0.005:
        unchanged += 1
    else:
        changes.append((sku, cost, new, round((new - cost) / cost * 100, 1), coll, status))

print(f"\nunchanged: {unchanged}  changes: {len(changes)}  absent-from-book: {len(absent)}")
print("\nCHANGES:")
for c in sorted(changes, key=lambda c: c[0]):
    print(f"  {c[0]:16} {c[1]:8.2f} -> {c[2]:8.2f}  {c[3]:+6.1f}%  [{c[4]}] {c[5]}")
print("\nABSENT (candidates: dropped/clearance-sold-out):")
for a in sorted(absent):
    print(f"  {a[0]:20} cost {a[2]:8.2f}  [{a[1]}] {a[3]}")

with open("gmi-q4-cost-diff-2026-11-08.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["vendor_sku", "old_cost", "new_cost", "pct", "collection", "status"])
    for c in sorted(changes):
        w.writerow(c)
print("\nwritten gmi-q4-cost-diff-2026-11-08.csv", file=sys.stderr)
