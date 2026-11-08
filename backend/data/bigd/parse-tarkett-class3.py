#!/usr/bin/env python3
"""Parse Tarkett Class 3 price book (10/12/2026, via Big D) -> tarkett-catalog.json.

Onboarded sections (enumerated SAP part numbers + concrete prices only):
  VCT (4 series, p5-6)            box, per_sqft, 45 sf/ctn
  iD Latitude LVT (p6-8)          box, per_sqft, size-specific ctn
  Surestart underlayment (p6)     roll sold as unit, per_unit
  Acczent Woods/Concrete/Chambray/Twill (p23-25)  roll, per_sqyd
  Performa (p22)                  roll, per_sqyd
  Adhesives (p62-66)              unit, per_unit

Skipped (no concrete SKUs or quote-only): wall base / accessories / treads /
rubber (XX color-matrix part numbers), iQ + Melodia/Aria (EMEA full-roll
import lines), sports, customs.
"""
import json
import re
import sys

import pdfplumber

PDF = "tarkett-class3-2026-10.pdf"
OUT = "tarkett-catalog.json"

pdf = pdfplumber.open(PDF)
products = {}  # (collection, name) -> product dict


def add_sku(collection, name, category_slug, desc, sku):
    key = (collection, name)
    if key not in products:
        products[key] = {
            "name": name, "collection": collection, "category_slug": category_slug,
            "description": desc, "skus": [],
        }
    if any(s["vendor_sku"] == sku["vendor_sku"] for s in products[key]["skus"]):
        return
    products[key]["skus"].append(sku)


STOP_WB = re.compile(r"^(\d{1,3}|[A-Z]{1,2}\d|VM\d|VL\d|VN\d|VK\d|TA\d|TB\d|TG\d|TH\d)$")


def color_name(tokens):
    """Tokens after the color code, up to the wall-base suggestion code."""
    out = []
    for t in tokens:
        if out and STOP_WB.match(t):
            break
        out.append(t)
    return " ".join(out).strip()


# ---------------- VCT + iD Latitude (pages 5-8) ----------------
VCT_SERIES = {
    "vct_standard": ("Tarkett VCT Standard", 63.49, "Standard VCT II vinyl composition tile, 12x12x1/8, 150 PSI static load."),
    "vct_quartz": ("Tarkett VCT Premium Quartz", 95.95, "Premium Quartz vinyl composition tile, 12x12x1/8."),
    "vct_slip": ("Tarkett VCT Premium Slip Resistant", 241.37, "Premium Slip Resistant vinyl composition tile, 12x12x1/8."),
    "vct_solid": ("Tarkett VCT Premium Solid", 241.37, "Premium Solid Color vinyl composition tile, 12x12x1/8. Recommended for accents and borders."),
}
LVT_PKG = {"6x48": (36, 36), "18x18": (45, 47), "12x24": (36, 36), "6x36": (36, 36)}

section = None
for pi in (4, 5, 6, 7):
    for line in (pdf.pages[pi].extract_text() or "").split("\n"):
        u = line.upper()
        if "COLORS FOR STANDARD VCT" in u: section = "vct_standard"; continue
        if "PREMIUM QUARTZ VCT" in u: section = "vct_quartz"; continue
        if "SLIP RESISTANT VCT" in u: section = "vct_slip"; continue
        if "VCT SOLID COLOR" in u: section = "vct_solid"; continue
        if "COLORS FOR STANDARD LVT" in u: section = "lvt"; continue
        toks = line.split()
        if not toks or not re.match(r"^(350002\d{3}|25117\d{4})$", toks[0]):
            continue
        sap = toks[0]
        rest = [t for t in toks[1:] if t not in ("RTS", "MTS", "MTO", "1")]
        if sap.startswith("350002") and section and section.startswith("vct"):
            # rest: colorcode, name..., wallbase...
            if not rest or not re.match(r"^\d{3}$", rest[0]):
                continue
            name = color_name(rest[1:])
            if not name:
                continue
            coll, box, desc = VCT_SERIES[section]
            add_sku(coll, name, "vct", desc, {
                "vendor_sku": sap, "internal_sku": "BIGD-" + sap,
                "variant_name": '12"x12"', "sell_by": "box",
                "cost": round(box / 45, 2), "price_basis": "per_sqft",
                "packaging": {"sqft_per_box": 45, "pieces_per_box": 45},
                "attrs": {"color": name, "size": '12"x12"', "thickness": '1/8"'},
            })
        elif sap.startswith("25117") and section == "lvt":
            # rest: colorcode(3-4 digit), name..., size, wallbase...
            if not rest or not re.match(r"^\d{3,4}$", rest[0]):
                continue
            m = None
            for i, t in enumerate(rest[1:], 1):
                if re.match(r"^(6x48|18x18|12x24|6x36)$", t, re.I):
                    m = i
                    break
            if m is None:
                continue
            name = " ".join(rest[1:m])
            size = rest[m].lower()
            sf, lbs = LVT_PKG[size]
            add_sku("Tarkett iD Latitude", name, "lvt-tile",
                    "iD Latitude luxury vinyl tile, 3mm (0.12\"), glue-down.", {
                "vendor_sku": sap, "internal_sku": "BIGD-" + sap,
                "variant_name": size.replace("x", '"x') + '"', "sell_by": "box",
                "cost": 2.87, "price_basis": "per_sqft",
                "packaging": {"sqft_per_box": sf, "pieces_per_box": None},
                "attrs": {"color": name, "size": size, "thickness": "3mm"},
            })

# Surestart underlayment (p6 price table rows carry SAP directly)
t6 = pdf.pages[5].extract_text() or ""
for m in re.finditer(r"(50003\d{4})\s+Surestart\s+(\d+)in[^\n]*?=\s*([\d ]+inches x [\d.]+ feet)\s+(\d+)\s+\d+\s+N\d+\s+\$\s*([\d.]+)", t6):
    sap, width, dims, sf, sfprice = m.groups()
    add_sku("Tarkett Surestart", f"Surestart {width}in LVT Underlayment", "lvt-tile",
            "Surestart self-adhering LVT underlayment roll.", {
        "vendor_sku": sap, "internal_sku": "BIGD-" + sap,
        "variant_name": f"{dims} Roll ({sf} sf)", "sell_by": "unit",
        "cost": round(float(sfprice) * float(sf), 2), "price_basis": "per_unit",
        "packaging": None, "attrs": {"size": dims},
    })

# ---------------- Performa (p22) + Acczent (p23-25) rolls ----------------
STOCK_TOKENS = {"TNA", "RTS", "NON", "MTO", "-", "Max", "1,000", "SY", "EMEA", "FARNHAM", "Full", "Roll", "CUSTOM"}

def parse_roll_colors(pages, sap_re, handler):
    for pi in pages:
        for line in (pdf.pages[pi].extract_text() or "").split("\n"):
            toks = line.split()
            if not toks or not re.match(sap_re, toks[0]):
                continue
            handler(toks)

def performa_row(toks):
    sap = toks[0]
    rest = [t for t in toks[1:] if t not in STOCK_TOKENS]
    # rest: pattern+color..., colornumber(5 digit), width(6'), weldrod...
    idx = next((i for i, t in enumerate(rest) if re.match(r"^\d{5}$", t)), None)
    if idx is None or idx == 0:
        return
    name = " ".join(rest[:idx])
    add_sku("Tarkett Performa", name, "sheet-vinyl",
            "Performa heterogeneous commercial sheet vinyl, 2.0 mm.", {
        "vendor_sku": sap, "internal_sku": "BIGD-" + sap,
        "variant_name": "6' Sheet", "sell_by": "roll",
        "cost": 26.67, "price_basis": "per_sqyd",
        "packaging": {"roll_width_ft": 6}, "attrs": {"color": name, "thickness": "2.0mm"},
    })

ACCZENT_RANGES = [
    (re.compile(r"^2060240\d\d$"), "Tarkett Acczent Woods & Stones"),
    (re.compile(r"^2060245\d\d$"), "Tarkett Acczent Chambray"),
    (re.compile(r"^2060246\d\d$"), "Tarkett Acczent Twill"),
]

def acczent_row(toks):
    sap = toks[0]
    coll = next((c for rx, c in ACCZENT_RANGES if rx.match(sap)), None)
    if not coll:
        return
    rest = [t for t in toks[1:] if t not in STOCK_TOKENS]
    # rest: name..., colornumber(3digit == sap last3), weldrod sap, ...
    last3 = sap[-3:]
    idx = next((i for i, t in enumerate(rest) if t == last3), None)
    if idx is None or idx == 0:
        return
    name = " ".join(rest[:idx])
    add_sku(coll, name, "sheet-vinyl",
            coll.replace("Tarkett ", "") + " heterogeneous commercial sheet vinyl, 2.0 mm.", {
        "vendor_sku": sap, "internal_sku": "BIGD-" + sap,
        "variant_name": "6'6\" Sheet", "sell_by": "roll",
        "cost": 45.74, "price_basis": "per_sqyd",
        "packaging": {"roll_width_ft": 6.5}, "attrs": {"color": name, "thickness": "2.0mm"},
    })

parse_roll_colors((21,), r"^2130020\d\d$", performa_row)
parse_roll_colors((22, 23, 24), r"^206024\d{3}$", acczent_row)

# ---------------- Adhesives (p62-66) ----------------
# Curated from geometry extraction (price = per selling unit; "full cartons
# only"). p66 tapes/cartridges/gun/nozzles intentionally skipped.
ADHESIVES = [
    ("906",  "Tarkett 906 Conductive Static-Dissipative Adhesive", [
        ("297038061", "4 x 1 Gal Case", 425.08), ("297038065", "2 Gal Pail", 149.72)]),
    ("925",  "Tarkett 925 Resilient Sheet Vinyl Flooring Adhesive", [
        ("297038062", "4 x 1 Gal Case", 214.52), ("297038066", "4 Gal Pail", 208.27)]),
    ("925HM", "Tarkett 925HM High-Moisture Vinyl Sheet Adhesive", [
        ("297038346", "4 x 1 Gal Case", 238.57), ("297038345", "4 Gal Pail", 240.80)]),
    ("926HM", "Tarkett 926HM High-Moisture Vinyl Tile Adhesive", [
        ("297038353", "4 Gal Pail", 201.60)]),
    ("930",  "Tarkett 930 SpraySmart Resilient Spray Adhesive", [
        ("297038040", "13.5 oz Can Case", 492.36)]),
    ("931",  "Tarkett 931 SpraySmart Carpet Spray Adhesive", [
        ("297038337", "13.5 oz Can Case", 492.36)]),
    ("959HM", "Tarkett 959HM High-Moisture LVT Substrate Adhesive", [
        ("297038082", "4 Gal Pail", 121.39)]),
    ("960",  "Tarkett 960 Releasable Resilient Tile Adhesive", [
        ("297038000", "4 x 1 Gal Case", 96.04), ("297038001", "4 Gal Pail", 63.51)]),
    ("965",  "Tarkett 965 Premium Resilient Flooring Adhesive", [
        ("297038011", "4 x 1 Gal Case", 177.24), ("297038024", "4 Gal Pail", 152.12)]),
    ("975",  "Tarkett 975 Two-Part Urethane Adhesive", [
        ("297038014", "1 Gal Unit", 136.91), ("297038020", "2 Gal Unit", 245.89)]),
    ("996",  "Tarkett 996 Two-Part Epoxy Adhesive", [
        ("297038019", "1 Gal Unit", 210.56)]),
    ("CWL",  "Tarkett CWL Cold Weld Liquid Seam Sealer", [
        ("297038002", "10 x 4.5 oz Tube Case", 604.80)]),
    ("RollSmart", "Tarkett RollSmart Immediate-Occupancy Sheet Adhesive", [
        ("297038074", "4 x 1 Gal Case", 281.76), ("297038073", "4 Gal Pail", 265.94)]),
    ("901",  "Tarkett 901 Premium Wall Base Adhesive (22 oz)", [
        ("297038075", "22 oz Cartridge Case", 224.88)]),
]
for num, pname, packs in ADHESIVES:
    for sap, pack, price in packs:
        add_sku("Tarkett Adhesives", pname, "adhesives-sealants",
                pname + ". Full cartons only; price is per selling unit.", {
            "vendor_sku": sap, "internal_sku": "BIGD-" + sap,
            "variant_name": pack, "sell_by": "unit",
            "cost": price, "price_basis": "per_unit",
            "packaging": None, "attrs": {},
        })

out = list(products.values())
counts = {}
for p in out:
    counts[p["collection"]] = counts.get(p["collection"], 0) + len(p["skus"])
print(json.dumps(counts, indent=2), file=sys.stderr)
print(f"products: {len(out)}, skus: {sum(len(p['skus']) for p in out)}", file=sys.stderr)
with open(OUT, "w") as f:
    json.dump(out, f, indent=1)
print("written", OUT, file=sys.stderr)
