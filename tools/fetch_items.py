#!/usr/bin/env python3
"""
Rebuild data/economy.json from the Forever Winter wiki.

Unlike the other fetchers (which scrape per-page infoboxes), the wiki keeps a
structured **Cargo** database, so we query the `Items` table directly — one API
call gets every item's name, credit value, weight, volume, size, category and XP.

We keep only the **raiding-loot economy** — the stuff you scavenge and sell —
and drop what already has its own tab:
  * functional weapons (Size == "Weapon"),
  * weapon parts and weapon attachments,
  * ammo.
Enemy-drop **Destroyed weapons** are kept (they're prime salvage income), even
though they carry a weapon Size/class.

Each surviving item is bucketed into a curated **value tier** (Junk … Jackpot),
tuned to the real distribution so every tier is populated, and we precompute
**value density** — credits per unit volume (the "what do I grab when my bins
are nearly full?" metric) and credits per kg.

Credit value = raw `Items.Value` / 1.9512195122 — the exact formula the wiki's
own Items table renders with (its "Reputation 2 / 100% cost efficiency"
reference point), so our numbers match what players read on the wiki.

    python tools/fetch_items.py

Stdlib only, re-runnable, no dependencies.
"""
import json, os, sys, html, urllib.request, urllib.parse

API = "https://theforeverwinter.wiki.gg/api.php"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "economy.json")
UA = {"User-Agent": "fw-almanac-datafetch/1.0 (github.com/dataterminals/forever-winter-almanac)"}

# Wiki's own Items-table conversion: raw internal Value -> displayed credits.
DIVISOR = 1.9512195122

# curated value tiers (lo <= cr < hi; the last hi=None is open-ended)
TIERS = [
    ("junk",     "Junk",           0,      500,   "Vendor-fodder — only bother if it's on the way."),
    ("cheap",    "Cheap",          500,    1500,  "Pocket change; fine when your bins are empty."),
    ("worth",    "Worth grabbing", 1500,   3000,  "Solid filler for spare space."),
    ("good",     "Good",           3000,   6000,  "Reliably worth a slot."),
    ("valuable", "Valuable",       6000,   12000, "Prioritise these on a normal run."),
    ("prime",    "Prime",          12000,  25000, "Big-ticket — make room for it."),
    ("jackpot",  "Jackpot",        25000,  None,  "Drop lesser loot and take it."),
]

# loot categories, in display order, with tidy labels. The primary (first)
# Cargo category token of each item is slugified and matched here; anything not
# listed is appended at the end with an auto-title label.
CAT_ORDER = [
    ("materials",          "Materials"),
    ("civil-goods",        "Civil goods"),
    ("military",           "Military"),
    ("quest-items",        "Quest items"),
    ("iffs",               "IFFs"),
    ("destroyed-weapons",  "Destroyed weapons"),
    ("railgun-components", "Railgun components"),
    ("at-43-components",   "AT-43 components"),
    ("consumables",        "Consumables"),
    ("medical",            "Medical"),
    ("provisions",         "Provisions"),
    ("alcohol",            "Alcohol"),
    ("large-items",        "Large items"),
    ("equipment",          "Equipment"),
    ("grenades",           "Grenades"),
    ("utility-drones",     "Utility drones"),
    ("wall-decorations",   "Wall decorations"),
    ("shelf-decorations",  "Shelf decorations"),
    ("misc",               "Miscellaneous"),
]
CAT_LABEL = dict(CAT_ORDER)

# raiding-loot filter: umbrella category tokens that mean "already has its own tab"
EXCLUDE_UMBRELLA = {"Weapon parts", "Weapon attachments", "Ammo"}
KEEP_OVERRIDE = "Destroyed weapons"  # enemy-drop salvage: keep despite weapon Size/class


def api_get(params):
    params = dict(params); params["format"] = "json"
    url = API + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
        return json.load(r)


def cargo_items():
    """Query the whole Items Cargo table, paginating 500 rows at a time."""
    fields = "Name,Category,Weight,Volume,Size,XP,Value"
    rows, offset = [], 0
    while True:
        d = api_get({"action": "cargoquery", "tables": "Items", "fields": fields,
                     "limit": "500", "offset": str(offset), "order_by": "Value DESC"})
        chunk = d.get("cargoquery", [])
        rows += [c["title"] for c in chunk]
        if len(chunk) < 500:
            break
        offset += 500
    return rows


def slug(token):
    out = "".join(ch.lower() if ch.isalnum() else "-" for ch in token.strip())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def cat_key(primary):
    if primary == "Uncategorized items" or not primary:
        return "misc"
    return slug(primary)


def num(s):
    try:
        return float(str(s).replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


def tier_for(cr):
    for key, _label, lo, hi, _blurb in TIERS:
        if cr >= lo and (hi is None or cr < hi):
            return key
    return TIERS[-1][0]


def is_loot(size, tokens):
    if KEEP_OVERRIDE in tokens:
        return True
    if size == "Weapon":
        return False
    if EXCLUDE_UMBRELLA & set(tokens):
        return False
    return True


def main():
    print("Querying the Items Cargo table …")
    raw = cargo_items()
    print(f"  {len(raw)} items in the table")

    items = []
    for r in raw:
        name = html.unescape(r.get("Name") or "").strip()
        cat_raw = html.unescape(r.get("Category") or "").strip()
        tokens = [t.strip() for t in cat_raw.split(",") if t.strip()]
        size = (r.get("Size") or "").strip()
        if not name or not is_loot(size, tokens):
            continue

        cr = round(num(r.get("Value")) / DIVISOR)
        weight = round(num(r.get("Weight")), 2)
        volume = round(num(r.get("Volume")), 2)
        xp = int(num(r.get("XP")))
        primary = tokens[0] if tokens else ""
        key = cat_key(primary)

        item = {
            "name": name,
            "cr": cr,
            "tier": tier_for(cr),
            "cat": key,
            "catLabel": CAT_LABEL.get(key, primary or "Miscellaneous"),
            "size": size,
            "weight": weight,
            "volume": volume,
            "perVol": round(cr / volume) if volume > 0 else None,   # credits per unit volume
            "perWgt": round(cr / weight) if weight > 0 else None,   # credits per kg
            "xp": xp,
            "quest": ("Quest items" in tokens) or ("Quest exclusive" in tokens),
        }
        items.append(item)

    items.sort(key=lambda it: (-it["cr"], it["name"].lower()))

    # tier + category rollups (counts and total credits, for the app's summary strip)
    tiers_out = []
    for key, label, lo, hi, blurb in TIERS:
        grp = [it for it in items if it["tier"] == key]
        tiers_out.append({"key": key, "label": label, "lo": lo, "hi": hi, "blurb": blurb,
                          "count": len(grp), "sumCr": sum(it["cr"] for it in grp)})

    present = {}
    for it in items:
        present[it["cat"]] = present.get(it["cat"], 0) + 1
    ordered_keys = [k for k, _ in CAT_ORDER if k in present] + \
                   [k for k in present if k not in CAT_LABEL]
    cats_out = [{"key": k, "label": CAT_LABEL.get(k, k.replace("-", " ").title()),
                 "count": present[k]} for k in ordered_keys]

    data = {
        "source": "theforeverwinter.wiki.gg — Items Cargo table (action=cargoquery)",
        "generated_note": ("Raiding-loot economy: the scavenge-and-sell items. Excludes functional "
                           "weapons, weapon parts, attachments and ammo (those have their own tabs); "
                           "keeps enemy-drop Destroyed Weapons."),
        "valueBasis": "credits = round(raw Items.Value / 1.9512195122) — the wiki's Rep-2 / 100%-cost-efficiency reference",
        "divisor": DIVISOR,
        "tiers": tiers_out,
        "categories": cats_out,
        "items": items,
        "count": len(items),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)

    for t in tiers_out:
        print(f"  {t['label']:16s} {t['count']:4d}   {t['sumCr']:>10,} cr total")
    print(f"\n  {len(items)} loot items across {len(cats_out)} categories -> {os.path.relpath(OUT)}")


if __name__ == "__main__":
    main()
