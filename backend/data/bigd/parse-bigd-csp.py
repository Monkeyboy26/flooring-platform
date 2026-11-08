#!/usr/bin/env python3
"""Parse Big D Supply Customer Specific Pricing sheet -> code,price + diff vs DB.

Layout (x-ranges from header): Product ID | Vendor | Category | Sub-Category |
Vendor Code | Description | PS | Effective Date | Price('30.35ea') | Per Unit.
Rows cluster by y; long descriptions can overlap the price column, so rows
whose price token is garbled are flagged instead of guessed.
"""
import csv
import re
import subprocess
import sys

import pdfplumber

PDF = "bigd-pricesheet-2026-10-01.pdf"
PRICE = re.compile(r"^\+?(\d{1,3}(?:,\d{3})*\.\d{2})(ea|sf|sy|lf|pc|bx|rl|gl|pl)?$", re.I)

X = dict(pid=(55, 97), vendor=(98, 135), code=(288, 341), ps=(596, 608),
         eff=(608, 640), price=(640, 700))

rows_out = []   # (product_id, vendor, code, eff, price)
garbled = []

with pdfplumber.open(PDF) as pdf:
    for page in pdf.pages:
        words = sorted(page.extract_words(y_tolerance=1.5),
                       key=lambda w: (w["top"] + w["bottom"]) / 2)
        lines, cur, last = [], [], None
        for w in words:
            yc = (w["top"] + w["bottom"]) / 2
            if last is None or yc - last <= 3.5:
                cur.append(w)
            else:
                lines.append(cur); cur = [w]
            last = yc
        if cur:
            lines.append(cur)

        for line in lines:
            def grab(k):
                lo, hi = X[k]
                return [w["text"] for w in line if lo <= (w["x0"] + w["x1"]) / 2 <= hi]
            pid = grab("pid")
            if len(pid) != 1 or not pid[0].isdigit():
                continue
            vendor = " ".join(grab("vendor"))
            code = "".join(grab("code"))
            eff = " ".join(grab("eff"))
            ptoks = grab("price")
            price = None
            for t in ptoks:
                m = PRICE.match(t)
                if m:
                    price = float(m.group(1).replace(",", ""))
            if price is None:
                garbled.append((pid[0], vendor, code, " ".join(w["text"] for w in line)))
            else:
                rows_out.append((pid[0], vendor, code, eff, price))

print(f"parsed rows: {len(rows_out)}, garbled: {len(garbled)}", file=sys.stderr)
for g in garbled:
    print(f"  GARBLED pid={g[0]} {g[1]} code={g[2]}: {g[3][:130]}", file=sys.stderr)

by_code = {}
by_pid = {}
for pid, vendor, code, eff, price in rows_out:
    if code:
        by_code.setdefault(code, set()).add(price)
    by_pid.setdefault(pid, set()).add(price)

# diff vs DB
res = subprocess.run(["docker", "exec", "flooring-db", "psql", "-U", "postgres", "-d", "flooring_pim",
    "-t", "-A", "-F", "|", "-c",
    "SELECT s.vendor_sku, COALESCE(p.collection,''), pr.cost, s.status "
    "FROM skus s JOIN products p ON p.id=s.product_id JOIN pricing pr ON pr.sku_id=s.id "
    "WHERE p.vendor_id='71708161-0077-4b80-b128-a52d689de455';"],
    capture_output=True, text=True, check=True)

changes, matched_same, nomatch, ambig = [], 0, 0, []
for ln in res.stdout.splitlines():
    if not ln.strip():
        continue
    sku, coll, cost, status = ln.split("|")
    cost = float(cost)
    prices = by_code.get(sku) or by_pid.get(sku)
    if not prices:
        nomatch += 1
        continue
    if len(prices) > 1:
        ambig.append((sku, coll, cost, sorted(prices)))
        continue
    new = next(iter(prices))
    if abs(new - cost) < 0.005:
        matched_same += 1
    else:
        changes.append((sku, cost, new, round((new - cost) / cost * 100, 1), coll, status))

print(f"\nDB BIGD skus: {len([l for l in res.stdout.splitlines() if l.strip()])}")
print(f"matched-unchanged: {matched_same}  changes: {len(changes)}  ambiguous: {len(ambig)}  not-in-sheet: {nomatch}")
print("\nCHANGES:")
for c in sorted(changes):
    print(f"  {c[0]:16} {c[1]:9.2f} -> {c[2]:9.2f}  {c[3]:+7.1f}%  [{c[4]}] {c[5]}")
print("\nAMBIGUOUS (same code, multiple sheet prices):")
for a in ambig:
    print(f"  {a[0]:16} cost {a[2]:9.2f}  sheet {a[3]}  [{a[1]}]")

with open("bigd-cost-diff-2026-11-08.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["vendor_sku", "old_cost", "new_cost", "pct", "collection", "status"])
    for c in sorted(changes):
        w.writerow(c)
print("\nwritten bigd-cost-diff-2026-11-08.csv", file=sys.stderr)
