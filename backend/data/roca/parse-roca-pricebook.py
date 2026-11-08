#!/usr/bin/env python3
"""Parse ROCA USA 2026 Price Book (II-JUL) PDF into sku -> price CSV.

Layout: series tables with merged PRICE cells spanning a group of SKU rows.
Strategy: per page, for each $price token find the tightest horizontal grid
band (from rect edges crossing the price column) that encloses it; assign every
known vendor_sku token whose y-center falls inside that band.
"""
import csv
import re
import subprocess
import sys

import pdfplumber

PDF = "ROCA-USA-2026-PRICE-BOOK-II-JUL.pdf"
OUT = "roca-pricebook-2026-jul-parsed.csv"

db_skus = subprocess.run(
    ["docker", "exec", "flooring-db", "psql", "-U", "postgres", "-d", "flooring_pim",
     "-t", "-A", "-c",
     "SELECT DISTINCT s.vendor_sku FROM skus s JOIN products p ON p.id=s.product_id "
     "WHERE p.vendor_id='b898517d-1643-4158-a92f-bf494bb69ef0';"],
    capture_output=True, text=True, check=True,
).stdout.splitlines()
db_skus = [s.strip() for s in db_skus if s.strip()]
db_sku_set = set(db_skus)
# skus safe for substring/suffix matching (long, unambiguous)
sub_sku_set = {s for s in db_sku_set if re.match(r"^[A-Z0-9-]{8,}$", s) and not s.isalpha()}
print(f"DB vendor_skus: {len(db_sku_set)} (substring-safe: {len(sub_sku_set)})", file=sys.stderr)

PRICE_RE = re.compile(r"^\$(\d{1,3}(?:,\d{3})*\.\d{2})$")


def token_skus(text):
    """All DB skus represented by this word token."""
    t = text.rstrip("*").rstrip(",")
    out = []
    if t in db_sku_set:
        out.append(t)
        return out
    # merged row-label prefix, e.g. FLOORFWM0A57371 / WALLFN8A0AW371
    for s in sub_sku_set:
        if t.endswith(s) and len(t) > len(s):
            out.append(s)
            return out
    # char-interleave of two skus printed on overlapping lines
    if len(t) >= 16 and len(t) % 2 == 0:
        a, b = t[0::2], t[1::2]
        if a in db_sku_set or b in db_sku_set:
            out += [x for x in (a, b) if x in db_sku_set]
    return out


results = {}   # sku -> set of (price, page)
fallback = {}  # sku -> (price, page)  nearest-in-block assignment, needs review
price_cells = 0

with pdfplumber.open(PDF) as pdf:
    for pageno, page in enumerate(pdf.pages):
        words = page.extract_words(y_tolerance=1, keep_blank_chars=False)
        rects = page.rects

        price_words = [w for w in words if PRICE_RE.match(w["text"])]

        sku_hits = []  # (sku, ycenter)
        for w in words:
            yc = (w["top"] + w["bottom"]) / 2
            for s in token_skus(w["text"]):
                sku_hits.append((s, yc))

        for pw in price_words:
            price = float(PRICE_RE.match(pw["text"]).group(1).replace(",", ""))
            xc = (pw["x0"] + pw["x1"]) / 2
            pt, pb = pw["top"], pw["bottom"]
            # horizontal grid edges crossing the price column at this x
            edges = set()
            for r in rects:
                if r["x0"] - 1 <= xc <= r["x1"] + 1:
                    edges.add(round(r["top"], 1))
                    edges.add(round(r["bottom"], 1))
            above = [e for e in edges if e <= pt + 0.5]
            below = [e for e in edges if e >= pb - 0.5]
            top = max(above) if above else pt - 6
            bottom = min(below) if below else pb + 6
            price_cells += 1
            for sku, yc in sku_hits:
                if top - 0.5 <= yc <= bottom + 0.5:
                    results.setdefault(sku, set()).add((price, pageno + 1))

        # fallback: skus on this page still unassigned -> nearest price in the
        # same table block (blocks delimited by header rows containing "PRICE")
        header_ys = sorted((w["top"] + w["bottom"]) / 2
                           for w in words if w["text"] == "PRICE")
        pw_pos = [((w["top"] + w["bottom"]) / 2,
                   float(PRICE_RE.match(w["text"]).group(1).replace(",", "")))
                  for w in price_words]

        def block_of(yc):
            above = [h for h in header_ys if h < yc]
            below = [h for h in header_ys if h > yc]
            return (max(above) if above else 0,
                    min(below) if below else page.height)

        for sku, yc in sku_hits:
            if sku in results:
                continue
            lo, hi = block_of(yc)
            cands = [(abs(py - yc), pr) for py, pr in pw_pos if lo <= py <= hi]
            if cands:
                cands.sort()
                if cands[0][0] <= 40:  # within ~3 rows
                    fallback[sku] = (cands[0][1], pageno + 1)

print(f"price cells: {price_cells}", file=sys.stderr)

rows, ambiguous = [], []
for sku, hits in sorted(results.items()):
    prices = sorted(set(h[0] for h in hits))
    pages = sorted(set(h[1] for h in hits))
    if len(prices) == 1:
        rows.append((sku, prices[0], ";".join(map(str, pages))))
    else:
        ambiguous.append((sku, prices, pages))

with open(OUT, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["vendor_sku", "price", "pages", "source"])
    for r in rows:
        w.writerow(list(r) + ["band"])
    for sku, (price, page) in sorted(fallback.items()):
        w.writerow([sku, price, page, "fallback"])

print(f"matched unique: {len(rows)}", file=sys.stderr)
print(f"fallback (nearest-in-block, REVIEW): {len(fallback)}", file=sys.stderr)
for sku, (price, page) in sorted(fallback.items()):
    print(f"  FALLBACK {sku}: ${price} p{page}", file=sys.stderr)
print(f"ambiguous (multi-price): {len(ambiguous)}", file=sys.stderr)
for sku, prices, pages in ambiguous:
    print(f"  AMBIG {sku}: {prices} pages {pages}", file=sys.stderr)
print(f"db skus with no price found: {len(db_sku_set) - len(results) - len(fallback)}", file=sys.stderr)
