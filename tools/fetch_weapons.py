#!/usr/bin/env python3
"""
Rebuild data/weapons.json from the Forever Winter wiki.

Reads every page in Category:Weapons via the wiki.gg MediaWiki API, parses each
weapon's infobox, and writes the per-weapon stat table the app's Weapons tab
shows on each weapon card. Stdlib only.

Community wiki data (flagged WIP by the devs), but cross-checked against the
game files where we have them: the AK/RFL01's wiki damage 150 and RoF 11.11
match the datamined WeaponDamage 150.0 / FireRate 0.09 exactly.

    python tools/fetch_weapons.py
"""
import json, re, os, sys, urllib.request, urllib.parse

API = "https://theforeverwinter.wiki.gg/api.php"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "weapons.json")
UA = {"User-Agent": "fw-almanac-weapondata/1.0 (github.com/dataterminals/forever-winter-almanac)"}


def api_get(params):
    params = dict(params); params["format"] = "json"
    url = API + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
        return json.load(r)


def list_weapon_pages():
    out, cont = [], {}
    while True:
        d = api_get({"action": "query", "list": "categorymembers",
                     "cmtitle": "Category:Weapons", "cmtype": "page", "cmlimit": "500", **cont})
        out += [m["title"] for m in d["query"]["categorymembers"]]
        if "continue" in d: cont = d["continue"]
        else: break
    return out


def fetch_wikitext_batch(titles):
    res = {}
    for i in range(0, len(titles), 45):
        chunk = titles[i:i + 45]
        d = api_get({"action": "query", "prop": "revisions", "rvslots": "main",
                     "rvprop": "content", "titles": "|".join(chunk), "redirects": "1"})
        norm = {n["from"]: n["to"] for n in d["query"].get("normalized", [])}
        redir = {r["from"]: r["to"] for r in d["query"].get("redirects", [])}
        for p in d["query"]["pages"].values():
            if "revisions" in p:
                res[p["title"]] = p["revisions"][0]["slots"]["main"]["*"]
        for frm, to in {**norm, **redir}.items():
            if to in res: res[frm] = res[to]
    return res


def ib(wt, key):
    m = re.search(r'\n\s*\|\s*' + re.escape(key) + r'\s*=\s*([^\n]*)', wt)
    return m.group(1).strip() if m else None


def num(s):
    if s is None: return None
    m = re.search(r'-?\d+(?:\.\d+)?', s.replace(",", ""))
    return float(m.group(0)) if m else None


def as_int(s):
    v = num(s)
    return int(round(v)) if v is not None else None


def clean(s):
    if not s: return None
    # strip wiki link markup [[X|Y]] -> Y, [[X]] -> X, and templates
    s = re.sub(r'\[\[(?:[^|\]]*\|)?([^\]]+)\]\]', r'\1', s)
    s = re.sub(r"''+", "", s).strip()
    return s or None


def internal_code(wt):
    # BP_WPN_RFL01 / Inventory.Weapon.RFL01 -> RFL01 (joins to the datamine assets)
    for key in ("internalClass", "internalTag"):
        v = ib(wt, key)
        if v:
            m = re.search(r'(?:WPN[_.]|Weapon[_.])([A-Z0-9]+)', v)
            if m: return m.group(1)
            return v.split(".")[-1].split("_")[-1]
    return None


def main():
    print("Enumerating Category:Weapons …")
    titles = list_weapon_pages()
    pages = fetch_wikitext_batch(titles)

    weapons, skipped = {}, []
    for title in sorted(titles):
        wt = pages.get(title)
        # skip namespaced pages (Template:, User:, …) and non-weapon pages that
        # lack the damage/internalClass infobox fields
        if ":" in title or not wt or (ib(wt, "damage") is None and ib(wt, "internalClass") is None):
            skipped.append(title); continue
        rof = num(ib(wt, "rof"))
        w = {
            "class": clean(ib(wt, "category")) or clean(ib(wt, "type")),
            "damage": num(ib(wt, "damage")),
            "magazine": as_int(ib(wt, "magazine")),
            "accuracy": num(ib(wt, "accuracy")),
            "stability": num(ib(wt, "stability")),
            "recoil": num(ib(wt, "recoil")),
            "rof": round(rof, 2) if rof is not None else None,
            "firemodes": clean(ib(wt, "firemodes")),
            "weight": num(ib(wt, "weight")),
            "value": as_int(ib(wt, "base value")),
            "ammo": clean(ib(wt, "ammo")),
            "xp": as_int(ib(wt, "xp")),
            "internal": internal_code(wt),
        }
        weapons[title] = {k: v for k, v in w.items() if v is not None}

    data = {
        "source": "theforeverwinter.wiki.gg weapon infoboxes (Category:Weapons)",
        "note": ("Community wiki stats, flagged WIP by the devs — see the Stats tab for what each "
                 "actually does. Cross-checked against game files where available (AK/RFL01 wiki "
                 "damage 150 & RoF 11.11 match the datamined values exactly)."),
        "weapons": weapons,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)

    print(f"  {len(weapons)} weapons -> {os.path.relpath(OUT)}")
    if skipped:
        print(f"  skipped {len(skipped)} non-weapon pages: {', '.join(skipped[:8])}"
              + (" …" if len(skipped) > 8 else ""))


if __name__ == "__main__":
    main()
