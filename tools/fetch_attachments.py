#!/usr/bin/env python3
"""
Rebuild data/attachments.json from the Forever Winter wiki.

Reads every page in Category:Weapon attachments (the per-attachment pages, which
are kept current — unlike the aggregate 'Text Only' list) via the wiki.gg
MediaWiki API, and parses each page's infobox + the
`=== Compatible with: ===` section ({{WeaponCompatibility|weapon=..|parts=..}}
grouped under ==== Class ==== headers) into the weapon<->attachment dataset the
app consumes. No dependencies beyond Python 3.

    python tools/fetch_attachments.py
"""
import json, re, os, sys, urllib.request, urllib.parse

API = "https://theforeverwinter.wiki.gg/api.php"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "attachments.json")
UA = {"User-Agent": "fw-almanac-datafetch/2.0 (github.com/dataterminals/forever-winter-almanac)"}

# category code + display, resolved from the infobox image texture prefix
IMG_CAT = {"ATTMD": "MZD", "PICFGR": "FGR", "PICFLL": "FLL", "PICLAM": "LAM",
           "PICOPT": "OPT", "PICSCP": "SCP"}
CATLABEL = {"MZD": "Muzzle Devices", "SMZD": "Suppressed Muzzle Devices", "FGR": "Foregrips",
            "FLL": "Rail Flashlights", "LAM": "Rail Laser Sights", "OPT": "Optics", "SCP": "Scopes"}
CAT_ORDER = ["MZD", "SMZD", "FGR", "FLL", "LAM", "OPT", "SCP"]

# weapon-class headers used on the wiki -> our display label
CLASS_LABEL = {
    "pistols": "Pistols", "submachine guns": "Submachine Guns", "rifles": "Rifles",
    "heavy rifles": "Heavy Rifles", "light machineguns": "Light Machineguns",
    "heavy machineguns": "Heavy Machineguns", "shotguns": "Shotguns",
    "grenade launchers": "Grenade Launchers",
}
CLASS_ORDER = ["Pistols", "Submachine Guns", "Rifles", "Heavy Rifles",
               "Light Machineguns", "Heavy Machineguns", "Shotguns", "Grenade Launchers", "Other"]


def api_get(params):
    params = dict(params); params["format"] = "json"
    url = API + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
        return json.load(r)

def list_attachment_pages():
    out, cont = [], {}
    while True:
        d = api_get({"action": "query", "list": "categorymembers",
                     "cmtitle": "Category:Weapon attachments", "cmtype": "page", "cmlimit": "500", **cont})
        out += [m["title"] for m in d["query"]["categorymembers"]]
        if "continue" in d: cont = d["continue"]
        else: break
    skip = {"Weapon Attachments", "Weapon Attachments (Text Only)", "Muzzle Assembly"}
    return [t for t in out if t not in skip]

def fetch_wikitext_batch(titles):
    """Return {title: wikitext} for up to 50 titles per request."""
    res = {}
    for i in range(0, len(titles), 45):
        chunk = titles[i:i + 45]
        d = api_get({"action": "query", "prop": "revisions", "rvslots": "main",
                     "rvprop": "content", "titles": "|".join(chunk)})
        norm = {n["from"]: n["to"] for n in d["query"].get("normalized", [])}
        for p in d["query"]["pages"].values():
            if "revisions" in p:
                res[p["title"]] = p["revisions"][0]["slots"]["main"]["*"]
        # map any normalized titles back
        for frm, to in norm.items():
            if to in res: res[frm] = res[to]
    return res

def ib(wt, key):
    m = re.search(r'\|\s*' + re.escape(key) + r'\s*=\s*([^\n|]*)', wt)
    return m.group(1).strip() if m else None

def num(s):
    try: return float(s)
    except (TypeError, ValueError): return None

def category_and_subtype(image, suppressed):
    subtype = None
    code = None
    if not image:
        return None, None
    m = re.search(r'T_?([A-Z]+)(\d+)', image)
    if m:
        pref = m.group(1)
        if pref.startswith("ATTMD"):
            subtype = "ATTMD" + pref[5:] if len(pref) > 5 else "ATTMD" + m.group(2)[0]
        # normalize e.g. ATTMD3 in 'ATTMD3' or 'ATTMD' + number
        mm = re.search(r'ATTMD(\d)', image)
        if mm: subtype = "ATTMD" + mm.group(1)
        base = re.match(r'[A-Z]+', pref).group(0)
        for k, v in IMG_CAT.items():
            if image.replace("_", "").upper().startswith("T" + k) or ("_" + k) in ("_" + image.replace("T_", "").upper()):
                code = v; break
        # simpler: match known prefixes directly
        for k, v in IMG_CAT.items():
            if k in image.upper():
                code = v; break
    if code == "MZD" and suppressed:
        code = "SMZD"
    return code, subtype

def display_name(title, code):
    if code in ("OPT",) and title.endswith(" Optic"):
        return title[:-6].strip()
    if title.startswith("Rail Mounted Flashlight"):
        return "Rail Flashlight " + title.split()[-1]
    if title.startswith("Rail Mounted Laser Sight"):
        return "Rail Laser Sight " + title.split()[-1]
    if title.startswith("Suppressed Muzzle Device"):
        return "Sup. Muzzle Device " + title.split()[-1]
    return title

def parse_compat(wt):
    """Return (list of (class_label, weapon, parts_str_or_None))."""
    seg = wt.split("Compatible with", 1)
    if len(seg) < 2:
        return []
    body = seg[1]
    # stop at the next top-level section (== X ==) after the compat block
    body = re.split(r'\n==[^=]', body, 1)[0]
    out = []
    cur = "Other"
    for line in body.splitlines():
        h = re.match(r'\s*={3,4}\s*(.+?)\s*={3,4}\s*$', line)
        if h:
            cur = CLASS_LABEL.get(h.group(1).strip().lower(), h.group(1).strip())
            continue
        m = re.search(r'\{\{\s*WeaponCompatibility\s*\|([^}]*)\}\}', line)
        if not m:
            continue
        args = m.group(1)
        wm = re.search(r'weapon\s*=\s*([^|}]+)', args)
        if not wm:
            continue
        weapon = wm.group(1).strip()
        pm = re.search(r'parts\s*=\s*([^|}]+)', args)
        parts = pm.group(1).strip() if pm else None
        out.append((cur, weapon, parts))
    return out

def main():
    print("Enumerating Category:Weapon attachments …")
    titles = list_attachment_pages()
    print(f"  {len(titles)} attachment pages")
    pages = fetch_wikitext_batch(titles)

    attachments = []
    weapon_class = {}
    for title in titles:
        wt = pages.get(title)
        if not wt:
            print("  ! no wikitext:", title, file=sys.stderr); continue
        image = ib(wt, "image")
        suppressed = (ib(wt, "suppressed") or "").lower().startswith("t")
        code, subtype = category_and_subtype(image, suppressed)
        if not code:
            print("  ? uncategorized:", title, "image=", image, file=sys.stderr); continue
        compat = parse_compat(wt)
        for cls, w, _ in compat:
            weapon_class.setdefault(w, {})
            weapon_class[w][cls] = weapon_class[w].get(cls, 0) + 1
        reqparts = {w: p for (_, w, p) in compat if p}
        attachments.append({
            "id": f"{code}:{display_name(title, code)}",
            "name": display_name(title, code),
            "category": code, "subtype": subtype,
            "buy": ib(wt, "base value"), "level": ib(wt, "level"),
            "weight": ib(wt, "weight"), "volume": ib(wt, "volume"),
            "accuracy": ib(wt, "accuracy"), "stability": ib(wt, "stability"),
            "suppressed": suppressed,
            "compatible": [w for (_, w, _) in compat],
            "reqParts": reqparts,
        })

    # resolve each weapon's class (most frequent header it appears under)
    wclass = {w: max(cc.items(), key=lambda kv: kv[1])[0] for w, cc in weapon_class.items()}

    # invert -> weapon index
    wset = {}
    for a in attachments:
        for w in a["compatible"]:
            wb = wset.setdefault(w, {"byCategory": {}, "needsPart": {}})
            wb["byCategory"].setdefault(a["category"], []).append(a["name"])
            if w in a["reqParts"]:
                wb["needsPart"][a["name"]] = a["reqParts"][w]
    weapons = [{"name": w, "class": wclass.get(w, "Other"),
                "byCategory": wb["byCategory"], "needsPart": wb["needsPart"],
                "total": sum(len(v) for v in wb["byCategory"].values())}
               for w, wb in sorted(wset.items())]

    cats = [{"code": c, "name": CATLABEL[c],
             "count": sum(1 for a in attachments if a["category"] == c)} for c in CAT_ORDER]

    data = {
        "source": "theforeverwinter.wiki.gg - per-attachment pages (Category:Weapon attachments)",
        "generated_note": "Community wiki data. 'needsPart' = a barrel/handguard/upper that must be fitted to unlock that slot on that weapon.",
        "classOrder": CLASS_ORDER, "categories": cats,
        "attachments": attachments, "weapons": weapons,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    for c in cats:
        print(f"  {c['code']:5s} {c['name']:24s} {c['count']}")
    print(f"\n  {len(weapons)} weapons, {len(attachments)} attachments -> {os.path.relpath(OUT)}")

if __name__ == "__main__":
    main()
