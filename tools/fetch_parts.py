#!/usr/bin/env python3
"""
Rebuild data/parts.json from the Forever Winter wiki (Category:Weapon parts).

The *structural* parts — barrels, handguards, magazines, stocks, grips, upper
assemblies — are weapon-specific and unlocked by weapon level (unlike the rail /
muzzle attachments in fetch_attachments.py). Each part page carries the same
infobox + `Compatible with` block, so this parses them into a per-weapon index
the Weapons tab shows on each gun's card. Stdlib only.

    python tools/fetch_parts.py
"""
import json, re, os, urllib.request, urllib.parse
from collections import Counter

API = "https://theforeverwinter.wiki.gg/api.php"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "parts.json")
UA = {"User-Agent": "fw-almanac-partdata/1.0 (github.com/dataterminals/forever-winter-attachments)"}

SLOT_ORDER = ["Upper assembly", "Receiver", "Barrel", "Handguard", "Magazine", "Stock", "Grip"]
# (infobox key -> short effect label); magCapacity is the headline one (magazines)
STAT_FIELDS = [
    ("magCapacity", "mag"), ("accuracy", "acc"), ("stability", "stab"),
    ("recoilFirstPerson", "recoil"), ("rof", "rof"), ("fov", "fov"),
    ("reloadSpeed", "reload"), ("adsSpeed", "ads"), ("damage", "dmg"),
]


def api_get(params):
    params = dict(params); params["format"] = "json"
    url = API + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
        return json.load(r)


def list_pages():
    out, cont = [], {}
    while True:
        d = api_get({"action": "query", "list": "categorymembers", "cmtitle": "Category:Weapon parts",
                     "cmtype": "page", "cmlimit": "500", **cont})
        out += [m["title"] for m in d["query"]["categorymembers"]]
        if "continue" in d: cont = d["continue"]
        else: break
    return out


def fetch_batch(titles):
    res = {}
    for i in range(0, len(titles), 45):
        chunk = titles[i:i + 45]
        d = api_get({"action": "query", "prop": "revisions", "rvslots": "main", "rvprop": "content",
                     "titles": "|".join(chunk), "redirects": "1"})
        for p in d["query"]["pages"].values():
            if "revisions" in p:
                res[p["title"]] = p["revisions"][0]["slots"]["main"]["*"]
    return res


def ib(wt, key):
    m = re.search(r'\n\s*\|\s*' + re.escape(key) + r'\s*=\s*([^\n]*)', wt)
    return m.group(1).strip() if m else None


def num(s):
    if s is None: return None
    m = re.search(r'-?\d+(?:\.\d+)?', s.replace(",", ""))
    return float(m.group(0)) if m else None


def as_int(s):
    v = num(s); return int(round(v)) if v is not None else None


def short_name(name, slot):
    """A weapon's parts are prefixed with the in-game family name ('Kala Grip A',
    'AK Barrel B'). For display under a weapon's slot group we want just the
    variant ('A', 'B', 'E-1'); fall back to name-minus-slot when there's none."""
    m = re.search(r'\b([A-Z]+(?:-\d+)?)\s*$', name)
    if m:
        return m.group(1)
    s = re.sub(r'(?i)\b' + re.escape(slot) + r'\b', '', name)
    return re.sub(r'\s+', ' ', s).strip() or name


def disambiguate_shorts(rows, slot):
    """A weapon+slot group can hold parts from two in-game families whose short
    variants collide (e.g. M4A1 'Handguard Upgrade B' and 'NSN Handguard B' both
    -> 'B'). For the colliding rows only, fall back to name-minus-slot so the
    chips are visually distinct ('M4A1 Upgrade B' vs 'NSN B')."""
    dups = {s for s, c in Counter(r["short"] for r in rows).items() if c > 1}
    if not dups:
        return
    for r in rows:
        if r["short"] in dups:
            s = re.sub(r'(?i)\b' + re.escape(slot) + r'\b', ' ', r["name"])
            r["short"] = re.sub(r'\s+', ' ', s).strip() or r["name"]
    # near-identical names may still collide -> use the full name
    still = {s for s, c in Counter(r["short"] for r in rows).items() if c > 1}
    for r in rows:
        if r["short"] in still:
            r["short"] = r["name"]


def compat_weapons(wt):
    seg = wt.split("Compatible with", 1)
    body = seg[1] if len(seg) > 1 else wt
    return sorted(set(w.strip() for w in re.findall(r'weapon\s*=\s*([^|}\n]+)', body)))


def main():
    print("Enumerating Category:Weapon parts …")
    titles = list_pages()
    pages = fetch_batch(titles)

    parts, by_weapon, slots_seen, skipped = [], {}, set(), []
    for title in sorted(titles):
        wt = pages.get(title)
        if ":" in title or not wt or ib(wt, "slot") is None:
            skipped.append(title); continue
        slot = (ib(wt, "slot") or "Other").strip()
        slots_seen.add(slot)
        level = as_int(ib(wt, "level"))
        effects = {}
        for key, lab in STAT_FIELDS:
            v = num(ib(wt, key))
            if v not in (None, 0, 0.0):
                effects[lab] = int(v) if key == "magCapacity" else v
        weapons = compat_weapons(wt)
        internal = (ib(wt, "internalTag") or "").split(".")[-1] or None
        parts.append({"name": title, "slot": slot, "level": level, "buy": as_int(ib(wt, "base value")),
                      "weight": num(ib(wt, "weight")), "effects": effects, "compatible": weapons,
                      "internal": internal})
        row = {"name": title, "short": short_name(title, slot), "level": level,
               "effects": effects, "buy": as_int(ib(wt, "base value"))}
        row = {k: v for k, v in row.items() if v not in (None, {})}
        for w in weapons:
            by_weapon.setdefault(w, {}).setdefault(slot, []).append(row)

    for w in by_weapon:
        for slot in by_weapon[w]:
            lst = by_weapon[w][slot]
            lst.sort(key=lambda x: (x.get("level") or 0, x["name"]))
            disambiguate_shorts(lst, slot)

    slot_order = [s for s in SLOT_ORDER if s in slots_seen] + sorted(s for s in slots_seen if s not in SLOT_ORDER)
    data = {
        "source": "theforeverwinter.wiki.gg — Category:Weapon parts",
        "note": ("Structural parts (barrels/handguards/magazines/stocks/grips/uppers) are weapon-specific "
                 "and unlock at the listed weapon level. Some also unlock an attachment slot (e.g. a "
                 "suppressor or optic). Community wiki data — may lag patches."),
        "slotOrder": slot_order,
        "byWeapon": by_weapon,
        "parts": parts,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)

    print(f"  {len(parts)} parts across {len(by_weapon)} weapons -> {os.path.relpath(OUT)}")
    print(f"  slots: {', '.join(slot_order)}")
    if skipped:
        print(f"  skipped {len(skipped)} non-part pages")
    # surface compat weapons the app roster doesn't model (parts silently unshown)
    try:
        with open(os.path.join(os.path.dirname(OUT), "attachments.json"), encoding="utf-8") as f:
            roster = {wp["name"].lower() for wp in json.load(f)["weapons"]}
        orphans = sorted(k for k in by_weapon if k.lower() not in roster)
        if orphans:
            print(f"  note: {len(orphans)} compat weapon(s) not in the app roster (parts not shown): {', '.join(orphans)}")
    except Exception:
        pass


if __name__ == "__main__":
    main()
