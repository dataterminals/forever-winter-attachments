# The Forever Winter — Almanac

A fast, installable, **offline** field companion for *The Forever Winter*: the
interactive **maps**, a **gunsmith** cross-reference for what fits what, and the
**datamined systems** the game keeps to itself — all in one installable PWA.

It began as two separate apps (a map atlas and an attachment gunsmith) and is now
a single tabbed companion. Data comes from the
[official wiki](https://theforeverwinter.wiki.gg) (CC BY-NC-SA / CC BY-SA), and,
for the parts the wiki doesn't cover, straight from the shipping game files.

**39 maps · 46 weapons · 68 attachments · 5 muzzle mount families · the full detection model.**

## The tabs

- **Weapons** — pick a gun, see its **stat card** (damage, accuracy, magazine, RoF,
  fire modes, …) and *everything* that fits it, grouped by slot, with its **muzzle
  mount family** named up front (so you know which muzzle letters are valid).
- **Attachments** — pick an attachment (e.g. *Muzzle Dev. D*), see every weapon it
  fits, its price, loyalty level, and accuracy/stability numbers.
- **Muzzles** — the whole muzzle system on one screen: the **5 mount families**
  (ATTMD1–5), which letters belong to each, and which weapons they fit. The bit the
  game hides worst.
- **Stats** — what each weapon/attachment stat *actually* does, including
  **Stability decoded from the game binary** (it drives bullet-spread, not recoil).
- **Detection** — the datamined **FWAI awareness system**: per-enemy vision / hearing
  / ESP ranges, what makes you visible, noise radii, and how you summon Hunter-Killers.
- **Maps** — the full interactive atlas (Leaflet): 10 surface regions, 16 tunnels and
  12 aerial references, with toggleable marker layers, per-map search, background
  switches, popups with screenshots + wiki links, and a distance-measure tool.

## Features

- 🔎 Search weapons/attachments, or markers on the current map
- 🔗 Tap any chip to jump between a weapon and its attachments (and back)
- 🎯 Muzzle **mount-family** grouping — match the family, not the letter
- 🗺️ Zoom/pan interactive maps with layer toggles, measure tool and marker popups
- 📱 **Installable PWA** — add it to a phone / second monitor home screen
- ✈️ **Works offline** — the app shell and all data are cached on first load; map
  imagery caches as you view it, or tap **⤓ Save all maps offline** to grab it all

## Use it

Open the published page (GitHub Pages) and, optionally, install it:

- **Desktop (Chrome/Edge):** click the install icon in the address bar.
- **Android (Chrome):** menu → *Add to Home screen*.
- **iOS (Safari):** Share → *Add to Home Screen*.

On the **Maps** tab, hit **⤓ Save all maps offline** once so every tile is cached —
handy on a second screen with no connection.

### Maps keyboard shortcuts

| Key | Action |
|-----|--------|
| `M` | toggle the Maps panel |
| `L` | toggle the Layers panel |
| `/` | focus marker search |
| `Esc` | clear search / measure |

## How the compatibility works

- **Structural parts** (barrels, handguards, magazines, stocks, grips) are
  *weapon-specific* and unlocked by weapon level — not covered here.
- **Rail attachments** (optics, scopes, sights, foregrips, lights, lasers) mount on
  any weapon that exposes the matching Picatinny/upper slot.
- **Muzzle devices** come in **5 mount families**. A device only fits weapons in its
  family — the ATTMD1–5 grouping the *Muzzles* tab makes explicit.
- Some slots must be *unlocked* first by fitting the right structural part (e.g. the
  PP-19 needs its B barrel before it takes a suppressor; the SVD needs an upper
  assembly before it takes an optic).

> Stats are flagged **WIP** on the wiki — Accuracy and Magazine Capacity are the only
> stats that visibly change how a weapon performs. Values are community data and may
> lag game patches.

## Updating the data

Both fetchers are stdlib-only Python 3, re-runnable, no dependencies:

```bash
python tools/fetch_attachments.py   # rebuilds data/attachments.json from the wiki
python tools/fetch_weapons.py       # rebuilds data/weapons.json (per-weapon stats) from the wiki
python tools/fetch_maps.py          # rebuilds data/maps.json + per-map JSON, downloads tiles/icons
```

`fetch_maps.py` pulls every page in the wiki's `Map:` namespace, saves source JSON to
`data/`, downloads referenced tiles/icons/photos to `assets/img/`, and regenerates
`data/maps.json` (the map index) and `assets/img-list.json` (the offline cache list).
It skips images already on disk and backs off politely on rate limits.

`data/detection.json` and the *Stats* tab's Stability numbers are **datamined** from
the shipping game (UE4SS usmap + CUE4Parse) and are hand-maintained — there is no
auto-fetch for them yet.

PWA icons: `python tools/generate_icons.py` (Pillow) or `node tools/make_icons.mjs`.

## Layout

```
index.html                          the app shell + tab bar
app.js · app.css                    Weapons/Attachments/Muzzles/Stats/Detection tabs
maps.js · maps.css                  the Maps tab (Leaflet atlas, lazy-loaded, scoped to .maps-app)
sw.js · manifest.webmanifest        PWA / offline (shell precached, imagery runtime-cached)
data/attachments.json               weapon ↔ attachment dataset (wiki)
data/weapons.json                   per-weapon stats (wiki, cross-checked vs datamine)
data/detection.json                 datamined FWAI awareness model
data/maps.json                      map index; data/<map>.json are the per-map sources
assets/img/*                        bundled map tiles, marker icons, popup photos
assets/vendor/                      Leaflet (vendored for offline use)
tools/                              data fetchers + icon generators
```

No build step, no framework — just static files, rendered with Leaflet (`CRS.Simple`)
on the Maps tab.

## Credits & licence

- Compatibility, stats, map data, tiles and icons: **The Forever Winter Wiki**
  (theforeverwinter.wiki.gg) and its contributors — attachment/weapon data under
  **CC BY-NC-SA**, map data/tiles under **CC BY-SA 3.0** — cross-checked against, and
  in places datamined from, the game's own files.
- An unofficial, fan-made convenience app. Not affiliated with Fun Dog Studios or
  wiki.gg. *The Forever Winter* is a trademark of its respective owner.
