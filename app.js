"use strict";

const CATLABEL = {
  MZD: "Muzzle devices", SMZD: "Suppressed muzzle devices", FGR: "Foregrips",
  FLL: "Rail flashlights", LAM: "Rail laser sights", OPT: "Optics", SCP: "Scopes",
};
const CAT_ORDER = ["MZD", "SMZD", "FGR", "FLL", "LAM", "OPT", "SCP"];
const SUBTYPE_LABEL = {
  ATTMD1: "Pistols & PDWs", ATTMD2: "Shotguns", ATTMD3: "Assault rifles & LMGs",
  ATTMD4: "Battle rifles / DMRs", ATTMD5: "Heavy / anti-materiel",
};
const SUBTYPE_ORDER = ["ATTMD1", "ATTMD2", "ATTMD3", "ATTMD4", "ATTMD5"];

let DATA = null;
let WEAPONS = null; // per-weapon stats from data/weapons.json, keyed by lowercased name
let PARTS = null;   // structural parts from data/parts.json (byWeapon -> slot -> [parts])
let AMMO = null; // full ammunition catalogue from data/ammo.json (also feeds weapon-card headshots)
let CRAFT = null; // active crafting recipes (data/crafting.json), lazy-loaded on first Crafting visit
let REBAL = null; // the mod overlay (data/rebalance.json) — Heavy Rifles Rebalance deltas + new content
// Vanilla + rebalance variants of each dataset. The active globals above point at
// one set; setDataset() re-points them. Built once in init()/on first Crafting visit.
let DATA_V = null, DATA_RB = null, WEAPONS_V = null, WEAPONS_RB = null,
    PARTS_V = null, PARTS_RB = null, AMMO_V = null, AMMO_RB = null, CRAFT_V = null, CRAFT_RB = null;
// membership sets (weapon internal ids / ammo keys the mod changes, ids of brand-new
// attachments/parts it adds) — drive the "changed" / "new" badges
const rbAffected = { weapons: new Set(), ammo: new Set(), attAdded: new Set(), partsAdded: new Set() };
const state = { tab: "weapons", weapon: null, att: null, q: "", layout: "split", dataset: "vanilla", ecoMode: "tiers", ecoCat: "all", lootKind: "all", enemyCat: "all" };
const idx = { attById: {}, weaponByName: {}, weaponSubtype: {}, subtypes: {} };
const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

// per-weapon stat card rows (accuracy & magazine first — the two that visibly matter)
const WSTAT_ROWS = [
  ["accuracy", "Accuracy", (v) => v],
  ["magazine", "Magazine", (v) => v],
  ["damage", "Damage", (v) => v],
  ["stability", "Stability", (v) => v],
  ["recoil", "Recoil", (v) => v],
  ["rof", "Rate of fire", (v) => v + " rps"],
  ["firemodes", "Fire modes", (v) => v],
  ["weight", "Weight", (v) => v + " kg"],
  ["value", "Base value", (v) => Number(v).toLocaleString() + " cr"],
];
// stats the game computes on the fly (no stored field) — flagged with a * + hover note
const WSTAT_NOTES = {
  accuracy: "Not a stored value — the game derives it from the bullet-spread (dispersion) system. Higher = tighter grouping, and it's the handling stat worth chasing. The number shown is an aggregate the devs flag as WIP.",
  stability: "Not a stored value — Stability is the input to the weapon's dispersion curves: higher makes your spread grow slower and recover faster (tighter sustained fire). It does not affect recoil kick.",
  recoil: "Not a stored value — a compound of hidden wrist + arm recoil shown as one number. Believed to drive camera shake only (it doesn't move your point of aim), and it's often wrong once the weapon is modified.",
};

const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function init() {
  try {
    DATA = await (await fetch("data/attachments.json", { cache: "no-cache" })).json();
  } catch (e) {
    view.innerHTML = `<p class="empty">Could not load data.<br><small>${esc(e.message)}</small></p>`;
    return;
  }
  // per-weapon stats are optional — a failure here must not break the app
  try {
    const wj = await (await fetch("data/weapons.json", { cache: "no-cache" })).json();
    WEAPONS = {};
    for (const nm in wj.weapons) WEAPONS[nm.toLowerCase()] = wj.weapons[nm];
  } catch (e) { WEAPONS = {}; }
  try {
    PARTS = await (await fetch("data/parts.json", { cache: "no-cache" })).json();
    PARTS.byWeaponLC = {}; // case-insensitive join, mirroring the weapons.json lookup
    for (const nm in (PARTS.byWeapon || {})) PARTS.byWeaponLC[nm.toLowerCase()] = PARTS.byWeapon[nm];
  } catch (e) { PARTS = { byWeapon: {}, byWeaponLC: {}, slotOrder: [] }; }
  try {
    AMMO = await (await fetch("data/ammo.json", { cache: "no-cache" })).json();
    AMMO.byKey = {};
    AMMO.ammo.forEach((a) => (AMMO.byKey[a.key] = a));
  } catch (e) { AMMO = null; }
  // the mod overlay (optional — the app works fine without it)
  try { REBAL = await (await fetch("data/rebalance.json", { cache: "no-cache" })).json(); } catch (e) { REBAL = null; }
  DATA_V = DATA; WEAPONS_V = WEAPONS; PARTS_V = PARTS; AMMO_V = AMMO;
  buildVariants();
  try { const s = localStorage.getItem("fw:wlayout"); if (["list", "grid", "split"].includes(s)) state.layout = s; } catch (e) {}
  try { const m = localStorage.getItem("fw:ecomode"); if (["tiers", "density"].includes(m)) state.ecoMode = m; } catch (e) {}
  try { const d = localStorage.getItem("fw:dataset"); if (["vanilla", "rebalance"].includes(d)) state.dataset = d; } catch (e) {}
  applyLayout();
  applyDataset(); // points the active globals at the chosen dataset and (re)builds the index
  wireChrome();
  // Back/forward, edited URLs, and clicked deep-links all route through applyRoute.
  window.addEventListener("hashchange", () => { if (!routing) applyRoute(); });
  applyRoute(); // hydrate initial state from the URL (deep-link) or default to Weapons
  registerSW();
}

function buildIndex() {
  DATA.attachments.forEach((a) => (idx.attById[a.id] = a));
  DATA.weapons.forEach((w) => (idx.weaponByName[w.name] = w));
  // slug <-> name/id maps for deep-link URLs (weapon names & attachment ids are
  // both unique; slugify is verified collision-free, uniqueSlug is just a guard).
  idx.weaponSlug = {}; idx.slugByWeapon = {};
  DATA.weapons.forEach((w) => { const s = uniqueSlug(slugify(w.name), idx.weaponSlug); idx.weaponSlug[s] = w.name; idx.slugByWeapon[w.name] = s; });
  idx.attSlug = {}; idx.slugByAtt = {};
  DATA.attachments.forEach((a) => { const s = uniqueSlug(slugify(a.id), idx.attSlug); idx.attSlug[s] = a.id; idx.slugByAtt[a.id] = s; });
  // muzzle subtypes -> devices + weapons
  DATA.attachments.forEach((a) => {
    if ((a.category === "MZD" || a.category === "SMZD") && a.subtype) {
      const s = (idx.subtypes[a.subtype] = idx.subtypes[a.subtype] || { mzd: [], smzd: [], weapons: new Set() });
      (a.category === "MZD" ? s.mzd : s.smzd).push(a.name);
      a.compatible.forEach((w) => s.weapons.add(w));
      if (a.category === "MZD") a.compatible.forEach((w) => (idx.weaponSubtype[w] = a.subtype));
    }
  });
  $("#stats").textContent = `${DATA.weapons.length} weapons · ${DATA.attachments.length} attachments`;
}

/* ---------- dataset toggle (Vanilla <-> a mod overlay, e.g. Heavy Rifles Rebalance) ----------
   Every dataset is a bare module global (DATA/WEAPONS/PARTS/AMMO/CRAFT). We build a
   "_RB" variant of each by cloning the vanilla data and layering REBAL's deltas + new
   content on top, then setDataset() just re-points the active globals and re-renders. */
function buildVariants() {
  // default the variants to vanilla so the app is unaffected when no overlay is present
  DATA_RB = DATA_V; WEAPONS_RB = WEAPONS_V; PARTS_RB = PARTS_V; AMMO_RB = AMMO_V;
  rbAffected.weapons = new Set(); rbAffected.ammo = new Set(); rbAffected.attAdded = new Set(); rbAffected.partsAdded = new Set();
  if (!REBAL) return;
  const R = REBAL;

  // weapons: clone the lowercased-name map, apply byInternal overrides (joined on .internal)
  if (WEAPONS_V) {
    WEAPONS_RB = {};
    for (const lc in WEAPONS_V) WEAPONS_RB[lc] = Object.assign({}, WEAPONS_V[lc]);
    const byInt = (R.weapons && R.weapons.byInternal) || {};
    for (const lc in WEAPONS_RB) {
      const w = WEAPONS_RB[lc], d = w.internal && byInt[w.internal];
      if (d) { Object.assign(w, d); rbAffected.weapons.add(w.internal); }
    }
  }

  // ammo: clone, apply per-key headshot overrides, rebuild byKey
  if (AMMO_V) {
    AMMO_RB = clone(AMMO_V);
    const byKey = (R.ammo && R.ammo.byKey) || {};
    AMMO_RB.byKey = {};
    AMMO_RB.ammo.forEach((a) => {
      if (byKey[a.key]) { Object.assign(a, byKey[a.key]); rbAffected.ammo.add(a.key); }
      AMMO_RB.byKey[a.key] = a;
    });
  }

  // parts: clone, merge effect overrides + append new parts into byWeapon, rebuild byWeaponLC
  if (PARTS_V) {
    PARTS_RB = clone(PARTS_V);
    const bw = PARTS_RB.byWeapon || (PARTS_RB.byWeapon = {});
    ((R.parts && R.parts.override) || []).forEach((o) => {
      const arr = bw[o.weapon] && bw[o.weapon][o.slot];
      const p = arr && arr.find((x) => x.name === o.name);
      if (p) p.effects = Object.assign({}, p.effects || {}, o.effects);
    });
    ((R.parts && R.parts.add) || []).forEach((o) => {
      const slots = bw[o.weapon] || (bw[o.weapon] = {});
      const arr = slots[o.slot] || (slots[o.slot] = []);
      if (!arr.some((x) => x.name === o.name)) arr.push({ name: o.name, short: o.short, level: o.level, effects: o.effects, buy: o.buy, mod: true });
      rbAffected.partsAdded.add(o.weapon.toLowerCase() + "|" + o.slot + "|" + o.name);
      if (PARTS_RB.slotOrder && !PARTS_RB.slotOrder.includes(o.slot)) PARTS_RB.slotOrder.push(o.slot);
    });
    PARTS_RB.byWeaponLC = {};
    for (const nm in bw) PARTS_RB.byWeaponLC[nm.toLowerCase()] = bw[nm];
  }

  // attachments: clone, append new attachments, and thread them into each compatible
  // weapon's byCategory (+total) so the weapon-detail card lists them too
  if (DATA_V) {
    DATA_RB = clone(DATA_V);
    const wByName = {}; DATA_RB.weapons.forEach((w) => (wByName[w.name] = w));
    ((R.attachments && R.attachments.add) || []).forEach((a) => {
      if (!DATA_RB.attachments.some((x) => x.id === a.id)) DATA_RB.attachments.push(a);
      rbAffected.attAdded.add(a.id);
      (a.compatible || []).forEach((wn) => {
        const w = wByName[wn]; if (!w) return;
        w.byCategory = w.byCategory || {};
        const cat = (w.byCategory[a.category] = w.byCategory[a.category] || []);
        if (!cat.includes(a.name)) { cat.push(a.name); w.total = (w.total || 0) + 1; }
      });
    });
  }
}

// crafting is lazy (loaded on first Crafting visit); build its overlay then
function buildCraftRB() {
  CRAFT_RB = clone(CRAFT_V);
  const add = REBAL && REBAL.crafting && REBAL.crafting.addGroups;
  if (add) add.forEach((g) => CRAFT_RB.groups.push(Object.assign({}, g, { mod: true })));
}

function applyDataset() {
  const rb = state.dataset === "rebalance";
  DATA = rb ? DATA_RB : DATA_V;
  WEAPONS = rb ? WEAPONS_RB : WEAPONS_V;
  PARTS = rb ? PARTS_RB : PARTS_V;
  AMMO = rb ? AMMO_RB : AMMO_V;
  if (CRAFT_V) CRAFT = rb ? (CRAFT_RB || CRAFT_V) : CRAFT_V;
  document.body.classList.toggle("ds-rebalance", rb);
  buildIndex(); // idx (attachments, weapon-by-name, slugs, subtypes) is derived from the active DATA
}

function setDataset(mode) {
  if (!["vanilla", "rebalance"].includes(mode) || mode === state.dataset) return;
  state.dataset = mode;
  try { localStorage.setItem("fw:dataset", mode); } catch (e) {}
  applyDataset();
  render();
}

// the per-page Vanilla | <mod> control (rendered inside affected pages)
function datasetBar() {
  if (!REBAL) return "";
  const m = REBAL.meta || {}, rb = state.dataset === "rebalance";
  const note = rb
    ? `Showing <b>${esc(m.name || "mod")}</b> values${m.nexusUrl ? ` &middot; <a href="${esc(m.nexusUrl)}" target="_blank" rel="noopener">Nexus&nbsp;#${esc(m.nexus || "")}</a>` : ""}`
    : `Vanilla, datamined from the game. Toggle to overlay a mod.`;
  return `<div class="ds-bar${rb ? " on" : ""}">
    <div class="ds-modes" role="tablist" aria-label="Dataset">
      <button data-dataset="vanilla" class="${rb ? "" : "on"}">Vanilla</button>
      <button data-dataset="rebalance" class="${rb ? "on" : ""}">${esc(m.short || "Mod")}</button>
    </div>
    <span class="ds-note${rb ? "" : " ds-dim"}">${note}</span>
  </div>`;
}
const dsAffectedWeapon = (name) => state.dataset === "rebalance" && WEAPONS && WEAPONS[name.toLowerCase()] && rbAffected.weapons.has(WEAPONS[name.toLowerCase()].internal);

/* ---------- chrome / events ---------- */
function wireChrome() {
  document.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab;
      view.classList.remove("detail-open");
      syncTabs();
      if (state.tab === "maps") activateMaps();
      else { deactivateMaps(); render(); writeHash({ push: true }); }
      window.scrollTo({ top: 0 });
    })
  );
  const s = $("#search"), clr = $("#searchClear");
  s.addEventListener("input", () => {
    state.q = s.value.trim().toLowerCase();
    clr.hidden = !s.value;
    view.classList.remove("detail-open");
    render();
    writeHash();
  });
  clr.addEventListener("click", () => { s.value = ""; state.q = ""; clr.hidden = true; s.focus(); render(); writeHash(); });

  view.addEventListener("click", (e) => {
    // per-section link icon: copy a deep link to this sub-section (must run first,
    // and swallow the event so it doesn't toggle a <details> or trigger a row).
    const al = e.target.closest(".anchor-link");
    if (al) { e.preventDefault(); e.stopPropagation(); copySectionLink(al.dataset.copy); return; }
    const gear = e.target.closest("[data-gear]");
    if (gear) { e.stopPropagation(); gear.closest(".layoutpick").classList.toggle("open"); return; }
    const lay = e.target.closest("[data-layout]");
    if (lay) { setLayout(lay.dataset.layout); return; }
    const ds = e.target.closest("[data-dataset]");
    if (ds) { setDataset(ds.dataset.dataset); return; }
    const em = e.target.closest("[data-ecomode]");
    if (em) { setEcoMode(em.dataset.ecomode); writeHash(); return; }
    const ec = e.target.closest("[data-ecocat]");
    if (ec) { state.ecoCat = ec.dataset.ecocat; render(); writeHash(); return; }
    const et = e.target.closest("[data-ecotier]");
    if (et) {
      if (state.ecoMode !== "tiers") setEcoMode("tiers");
      const sec = document.getElementById("eco-tier-" + et.dataset.ecotier);
      if (sec) { sec.open = true; sec.scrollIntoView({ behavior: "smooth", block: "start" }); }
      writeHash({ sub: "tier-" + et.dataset.ecotier });
      return;
    }
    const enc = e.target.closest("[data-enemycat]");
    if (enc) { state.enemyCat = enc.dataset.enemycat; render(); writeHash(); window.scrollTo({ top: 0 }); return; }
    const goAI = e.target.closest("[data-goai]");
    if (goAI) {
      state.tab = "detection"; syncTabs(); deactivateMaps(); view.classList.remove("detail-open");
      window.scrollTo({ top: 0 });
      renderDetection().then(() => { const s = document.getElementById("det-priority"); if (s) s.scrollIntoView({ behavior: "smooth", block: "start" }); });
      writeHash({ sub: "priority", push: true });
      return;
    }
    const goDet = e.target.closest("[data-godetect]");
    if (goDet) {
      state.tab = "detection"; syncTabs(); deactivateMaps(); view.classList.remove("detail-open");
      window.scrollTo({ top: 0 });
      renderDetection().then(() => { const s = view.querySelector('[data-anchor="enemies"]'); if (s) s.scrollIntoView({ behavior: "smooth", block: "start" }); });
      writeHash({ sub: "enemies", push: true });
      return;
    }
    const goHS = e.target.closest("[data-gohs]");
    if (goHS) {
      state.tab = "ammo"; syncTabs(); deactivateMaps(); view.classList.remove("detail-open");
      const sb = $("#search"), clr = $("#searchClear");
      if (sb) sb.value = ""; if (clr) clr.hidden = true; state.q = ""; // "all calibers" => clear any filter
      render();
      requestAnimationFrame(() => { const s = document.getElementById("ammo-headshots"); if (s) s.scrollIntoView({ behavior: "smooth", block: "start" }); });
      writeHash({ sub: "headshots", push: true });
      return;
    }
    const lk = e.target.closest("[data-lootkind]");
    if (lk) { state.lootKind = lk.dataset.lootkind; render(); writeHash(); return; }
    // Drops "How drops work" panel: jump to a crate type's source card…
    const gsrc = e.target.closest("[data-gosrc]");
    if (gsrc) {
      const key = gsrc.dataset.gosrc;
      const go = () => { const d = document.getElementById("loot-src-" + key); if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); } };
      if (state.lootKind !== "all") { state.lootKind = "all"; Promise.resolve(render()).then(go); } else go();
      writeHash({ sub: key });
      return;
    }
    // …or hop to another tab (e.g. Armaments Bin -> Ammo, boss codex -> Enemies).
    const gtab = e.target.closest("[data-gotab]");
    if (gtab) {
      state.tab = gtab.dataset.gotab; syncTabs(); deactivateMaps(); view.classList.remove("detail-open");
      const sb = $("#search"), clr = $("#searchClear"); if (sb) sb.value = ""; if (clr) clr.hidden = true; state.q = "";
      render(); window.scrollTo({ top: 0 }); writeHash({ push: true });
      return;
    }
    // a container card's "How tiers work" link -> back up to the model (revealing it if a search hid it).
    const gsm = e.target.closest("[data-gosrc-model]");
    if (gsm) {
      const go = () => { const p = view.querySelector('.dropmodel [data-anchor="tier-budget"]') || view.querySelector(".dropmodel"); if (p) p.scrollIntoView({ behavior: "smooth", block: "start" }); };
      if (state.q) { state.q = ""; const sb = $("#search"), clr = $("#searchClear"); if (sb) sb.value = ""; if (clr) clr.hidden = true; Promise.resolve(render()).then(go); }
      else go();
      writeHash({ sub: "how-it-works" });
      return;
    }
    const ge = e.target.closest("[data-goeco]");
    if (ge) {
      state.tab = "economy"; state.ecoCat = "all"; syncTabs(); deactivateMaps(); view.classList.remove("detail-open");
      const sb = $("#search"), clr = $("#searchClear");
      if (sb) { sb.value = ge.dataset.goeco; } if (clr) clr.hidden = false;
      state.q = ge.dataset.goeco.toLowerCase();
      render(); window.scrollTo({ top: 0 });
      writeHash({ push: true });
      return;
    }
    const el = e.target.closest("[data-weapon],[data-att],[data-goatt],[data-goweapon],[data-back]");
    if (!el) return;
    if (el.dataset.back !== undefined) { view.classList.remove("detail-open"); render(); writeHash(); return; }
    if (el.dataset.weapon) { state.weapon = el.dataset.weapon; openDetail(); }
    else if (el.dataset.att) { state.att = el.dataset.att; openDetail(); }
    else if (el.dataset.goatt) { state.tab = "attachments"; state.att = el.dataset.goatt; syncTabs(); openDetail(); }
    else if (el.dataset.goweapon) { state.tab = "weapons"; state.weapon = el.dataset.goweapon; syncTabs(); openDetail(); }
  });

  // close the layout menu on any click outside it
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".layoutpick")) document.querySelectorAll(".layoutpick.open").forEach((p) => p.classList.remove("open"));
  });
}
function syncTabs() { document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab)); }
function openDetail() { view.classList.add("detail-open"); render(); window.scrollTo({ top: 0 }); writeHash({ push: true }); }

/* ---------- maps tab: lazy Leaflet + hand off to the FWMaps module ---------- */
let mapsBooted = false, leafletPromise = null, mapsWriterSet = false;

function ensureLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "assets/vendor/leaflet.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "assets/vendor/leaflet.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Leaflet failed to load"));
    document.head.appendChild(s);
  });
  return leafletPromise;
}

function positionMaps() {
  // Pin the full-bleed atlas just below the top bar + tab strip. The weapon
  // searchwrap is hidden in maps mode, so the tab strip's bottom is the top edge.
  window.scrollTo(0, 0);
  const tabs = document.querySelector(".tabs");
  document.documentElement.style.setProperty("--maps-top", Math.round(tabs.getBoundingClientRect().bottom) + "px");
}

async function activateMaps(route) {
  document.body.classList.add("maps-active");
  positionMaps();
  try {
    await ensureLeaflet();
    // hand the atlas a writer so map/layer/bg changes flow back into the URL
    if (window.FWMaps && !mapsWriterSet) { window.FWMaps.setRouteWriter((rs) => writeHashRaw("#/" + rs)); mapsWriterSet = true; }
    if (!mapsBooted) { await window.FWMaps.init(route || null); mapsBooted = true; } // guard AFTER success so a failed first boot stays retryable
    else if (route && (route.map || (route.layers && route.layers.length) || route.bg != null)) { await window.FWMaps.openRoute(route); }
    window.FWMaps.invalidateSize();
    if (window.FWMaps.syncRoute) window.FWMaps.syncRoute(); // keep the URL == the atlas
  } catch (e) {
    const lt = document.getElementById("loading-text"), l = document.getElementById("loading");
    if (lt) lt.textContent = "Map failed to load: " + e.message;
    if (l) l.classList.add("show");
  }
}

function deactivateMaps() { document.body.classList.remove("maps-active"); }

window.addEventListener("resize", () => { if (document.body.classList.contains("maps-active")) positionMaps(); });

/* ---------- list layout (List / Grid / Split), chosen from the gear menu ---------- */
function applyLayout() {
  document.body.classList.remove("wl-list", "wl-grid", "wl-split");
  document.body.classList.add("wl-" + state.layout);
}
function setLayout(mode) {
  if (!["list", "grid", "split"].includes(mode)) return;
  state.layout = mode;
  try { localStorage.setItem("fw:wlayout", mode); } catch (e) {}
  applyLayout();
  render();
}
function layoutBar(count, noun) {
  const opt = (m, ico, label) =>
    `<button type="button" data-layout="${m}" class="${state.layout === m ? "active" : ""}"><span class="ico">${ico}</span>${label}</button>`;
  return `<div class="viewbar"><span class="viewbar-title">${count} ${esc(noun)}</span>
    <div class="layoutpick">
      <button type="button" class="gear" data-gear title="Change layout" aria-label="Change layout">&#9881;</button>
      <div class="layoutmenu" role="menu">
        ${opt("split", "&#9707;", "Split view")}
        ${opt("grid", "&#9638;", "Compact grid")}
        ${opt("list", "&#9776;", "Vertical list")}
      </div>
    </div></div>`;
}

function setEcoMode(mode) {
  if (!["tiers", "density"].includes(mode)) return;
  state.ecoMode = mode;
  try { localStorage.setItem("fw:ecomode", mode); } catch (e) {}
  render();
}

/* ---------- render dispatch ---------- */
// render() dispatches to the active tab, then decorates the fresh DOM with the
// per-section link icons. It returns a promise that resolves after decoration so
// the router can scroll to a deep-link anchor once the (possibly async) tab is up.
function render() {
  const p = dispatch();
  return Promise.resolve(p).then(() => { if (state.tab !== "maps") decorateAnchors(); });
}
function dispatch() {
  if (state.tab === "maps") return; // the Maps tab is driven by activateMaps(), not #view
  if (state.tab === "weapons") return renderWeapons();
  else if (state.tab === "attachments") return renderAttachments();
  else if (state.tab === "muzzles") return renderMuzzles();
  else if (state.tab === "ammo") return renderAmmo();
  else if (state.tab === "stats") return renderStats();
  else if (state.tab === "detection") return renderDetection();
  else if (state.tab === "enemies") return renderEnemies();
  else if (state.tab === "factions") return renderFactions();
  else if (state.tab === "economy") return renderEconomy();
  else if (state.tab === "crafting") return renderCrafting();
  else return renderLoot();
}
const match = (name) => !state.q || name.toLowerCase().includes(state.q);

/* ---------- weapons tab ---------- */
function renderWeapons() {
  const groups = {};
  DATA.weapons.filter((w) => match(w.name)).forEach((w) => (groups[w.class] = groups[w.class] || []).push(w));
  let list = "";
  const order = DATA.classOrder.concat(Object.keys(groups).filter((c) => !DATA.classOrder.includes(c)));
  order.forEach((cls) => {
    const ws = groups[cls]; if (!ws) return;
    list += `<div class="grp">${esc(cls)}</div>`;
    ws.sort((a, b) => a.name.localeCompare(b.name)).forEach((w) => {
      const dot = dsAffectedWeapon(w.name) ? `<span class="ds-dot" title="Changed by ${esc((REBAL.meta || {}).name || "the mod")}"></span>` : "";
      list += `<button class="row ${state.weapon === w.name ? "sel" : ""}" data-weapon="${esc(w.name)}">
        <span class="rname">${esc(w.name)}${dot}</span>
        <span class="rmeta"><span class="count">${w.total}</span></span></button>`;
    });
  });
  if (!list) list = `<p class="empty">No weapons match &ldquo;${esc(state.q)}&rdquo;.</p>`;

  const detail = state.weapon && idx.weaponByName[state.weapon]
    ? weaponDetail(idx.weaponByName[state.weapon])
    : `<div class="placeholder">Pick a weapon to see everything that fits it.</div>`;
  view.innerHTML = datasetBar() + layoutBar(DATA.weapons.length, "weapons") + `<div class="panes"><div class="list">${list}</div><div class="detail">${detail}</div></div>`;
}

// map a weapon's (wiki) ammo string to an ammo.json key, then look it up in the
// catalogue. .50 PST maps to a real round with a value but no headshot entry;
// Nitro Express has no catalogued ammo item at all (-> null).
function ammoToCal(ammo) {
  ammo = (ammo || "").toLowerCase();
  if (ammo.includes("20x105")) return "20mm";
  if (ammo.includes(".50 bmg")) return "50cal";
  if (ammo.includes(".50 pst")) return "50PST";
  if (ammo.includes("nitro")) return null; // Nitro Express has no catalogued ammo item
  if (ammo.includes("12.7x55")) return "127";
  if (ammo.includes(".45 acp")) return "45acp";
  if (ammo.includes(".357")) return "357";
  if (ammo.includes(".308")) return "308";
  if (ammo.includes("12-gauge") || ammo.includes("buckshot")) return "12g";
  if (ammo.includes("40mm")) return "40mmHE";
  if (ammo.includes("5.56")) return "556";
  if (ammo.includes("5.45")) return "545";
  if (ammo.includes("7.62x39")) return "762";
  if (ammo.includes("7.62x54")) return "54R";
  if (ammo.includes("5.7x28")) return "57x28";
  if (ammo.includes("9x19") || ammo.includes("9mm")) return "919";
  return null;
}
function headshotFor(ammo) {
  const key = ammoToCal(ammo);
  const a = key && AMMO && AMMO.byKey[key];
  if (!a || a.headshot == null) return null;
  return { label: a.name, multi: a.headshot, band: a.band };
}

function partEffects(e) {
  if (!e) return "";
  const out = [];
  if (e.mag != null) out.push(e.mag + "-round magazine");
  if (e.acc) out.push("Accuracy +" + (e.acc * 100).toFixed(1) + "%");
  if (e.stab) out.push("Stability +" + (e.stab * 100).toFixed(1) + "%");
  if (e.recoil) out.push("Recoil " + (e.recoil * 100).toFixed(1) + "%");
  if (e.rof) out.push("RoF " + (e.rof > 0 ? "+" : "") + e.rof);
  if (e.dmg) out.push("Damage " + (e.dmg > 0 ? "+" : "") + e.dmg);
  if (e.fov) out.push("FOV " + e.fov);
  return out.join(" · ");
}

function weaponDetail(w) {
  const st = idx.weaponSubtype[w.name];
  const needs = w.needsPart || {};
  let anyReq = false;
  let html = `<button class="backbtn" data-back>&larr; all weapons</button><div class="card" data-anchor="${esc(idx.slugByWeapon[w.name] || slugify(w.name))}">
    <div class="dhead"><h2>${esc(w.name)}</h2><span class="badge gold">${esc(w.class)}</span>
      <span class="badge">${w.total} attachments</span>${dsAffectedWeapon(w.name) ? `<span class="badge rust" title="Stats reflect ${esc((REBAL.meta || {}).name || "the mod")}">${esc((REBAL.meta || {}).badge || (REBAL.meta || {}).short || "Mod")}</span>` : ""}</div>`;
  const ws = WEAPONS && WEAPONS[w.name.toLowerCase()];
  if (ws) {
    const rows = WSTAT_ROWS.filter(([k]) => ws[k] != null).map(([k, label, fmt]) => {
      const note = WSTAT_NOTES[k];
      const mark = note ? ` <span class="statnote" tabindex="0" role="note" aria-label="${esc(label + ": " + note)}">*<span class="tip">${esc(note)}</span></span>` : "";
      return `<div class="stat${k === "accuracy" || k === "magazine" ? " key" : ""}"><div class="k">${esc(label)}${mark}</div><div class="v">${esc(String(fmt(ws[k])))}</div></div>`;
    }).join("");
    if (rows) html += `<div class="statgrid">${rows}</div>`;
    if (ws.ammo) html += `<p class="legend"><b>Ammo:</b> ${esc(ws.ammo)}</p>`;
    const hs = ws.ammo ? headshotFor(ws.ammo) : null;
    if (hs) html += `<p class="legend"><b>Headshot:</b> <b class="hs-${hs.band}">×${hs.multi}</b> <span style="color:var(--dim)">per-caliber (${esc(hs.label)})${hs.band === "high" ? " &mdash; well above the 1.5× baseline; a headshot machine" : hs.band === "low" ? " &mdash; below the 1.5× baseline, body shots hit harder" : ""}.</span> <button class="linklike" data-gohs>all calibers &rarr;</button></p>`;
    html += `<p class="legend"><b>Accuracy</b> &amp; <b>Magazine</b> matter most. Stats marked <span class="req">*</span> are display aggregates the game computes &mdash; hover them for what they really measure (or see the <b>Stats</b> tab).${ws.internal ? ` <span style="color:var(--dim)">&middot; id ${esc(ws.internal)}</span>` : ""}</p>`;
  }
  const wp = PARTS && PARTS.byWeaponLC && PARTS.byWeaponLC[w.name.toLowerCase()];
  if (wp) {
    html += `<div class="section"><h3>Parts <span class="c">unlock at weapon level</span></h3>`;
    (PARTS.slotOrder || []).forEach((slot) => {
      const list = wp[slot];
      if (!list || !list.length) return;
      html += `<div class="lab">${esc(slot)}</div><div class="chips">`;
      list.forEach((p) => {
        const tip = [partEffects(p.effects), p.buy ? Number(p.buy).toLocaleString() + " cr" : ""].filter(Boolean).join(" · ");
        const lvl = (p.level != null) ? `<span class="lvl">L${p.level}</span>` : "";
        const cap = (p.effects && p.effects.mag != null) ? `<span class="cap">${p.effects.mag} rnd</span>` : "";
        const label = p.short || p.name;
        const nu = p.mod ? `<span class="ds-new">new</span>` : "";
        const full = [(p.name && p.name !== label) ? p.name : "", tip].filter(Boolean).join(" — ");
        html += `<span class="chip part${p.mod ? " mod" : ""}"${full ? ` tabindex="0" role="note" aria-label="${esc(label + ": " + full)}"` : ""}>${esc(label)}${lvl}${cap}${nu}${full ? `<span class="tip">${esc(full)}</span>` : ""}</span>`;
      });
      html += `</div>`;
    });
    html += `</div>`;
  }
  if (st) {
    html += `<div class="callout"><b>Muzzle mount: ${st} &mdash; ${esc(SUBTYPE_LABEL[st] || "")}.</b>
      Only accepts muzzle devices from this family.</div>`;
  }
  CAT_ORDER.forEach((code) => {
    const items = w.byCategory[code]; if (!items || !items.length) return;
    html += `<div class="section"><h3>${esc(CATLABEL[code])} <span class="c">&times;${items.length}</span></h3><div class="chips">`;
    items.forEach((nm) => {
      const req = needs[nm];
      if (req) anyReq = true;
      html += `<button class="chip" data-goatt="${esc(code + ":" + nm)}"${req ? ` title="Needs first: ${esc(req)}"` : ""}>${esc(nm)}${req ? '<sup class="req">*</sup>' : ""}</button>`;
    });
    html += `</div></div>`;
  });
  if (anyReq) html += `<p class="legend"><span class="req">*</span> the slot must be unlocked first by fitting a specific barrel / handguard / upper (hover, or open the part, for which one).</p>`;
  if (w.total === 0) html += `<p class="empty">No attachments listed for this weapon.</p>`;
  html += `</div>`;
  return html;
}

/* ---------- attachments tab ---------- */
function renderAttachments() {
  let list = "";
  CAT_ORDER.forEach((code) => {
    const items = DATA.attachments.filter((a) => a.category === code && match(a.name));
    if (!items.length) return;
    list += `<div class="grp">${esc(CATLABEL[code])}</div>`;
    items.forEach((a) => {
      const nu = (state.dataset === "rebalance" && rbAffected.attAdded.has(a.id)) ? `<span class="ds-new">new</span>` : "";
      list += `<button class="row ${state.att === a.id ? "sel" : ""}" data-att="${esc(a.id)}">
        <span class="rname">${esc(a.name)}${nu}</span>
        <span class="rmeta"><span class="count">${a.compatible.length}</span></span></button>`;
    });
  });
  if (!list) list = `<p class="empty">No attachments match &ldquo;${esc(state.q)}&rdquo;.</p>`;
  const detail = state.att && idx.attById[state.att]
    ? attDetail(idx.attById[state.att])
    : `<div class="placeholder">Pick an attachment to see which weapons it fits.</div>`;
  view.innerHTML = datasetBar() + layoutBar(DATA.attachments.length, "attachments") + `<div class="panes"><div class="list list-att">${list}</div><div class="detail">${detail}</div></div>`;
}

function attDetail(a) {
  let html = `<button class="backbtn" data-back>&larr; all attachments</button><div class="card" data-anchor="${esc(idx.slugByAtt[a.id] || slugify(a.id))}">
    <div class="dhead"><h2>${esc(a.name)}</h2><span class="badge olive">${esc(CATLABEL[a.category])}</span>
      ${a.subtype ? `<span class="badge gold">${esc(a.subtype)} · ${esc(SUBTYPE_LABEL[a.subtype] || "")}</span>` : ""}</div>`;
  // stats
  const stats = [];
  if (a.buy) stats.push(["Base value", (+a.buy).toLocaleString() + " cr"]);
  if (a.level && a.level !== "0") stats.push(["Weapon level", a.level]);
  if (a.accuracy && a.accuracy !== "0.0") stats.push(["Accuracy", a.accuracy]);
  if (a.stability && a.stability !== "0.0") stats.push(["Stability", a.stability]);
  if (a.weight) stats.push(["Weight", a.weight + " kg"]);
  if (a.volume) stats.push(["Volume", a.volume]);
  if (a.suppressed) stats.push(["Suppressed", "Yes"]);
  if (stats.length) {
    html += `<div class="statgrid">`;
    stats.forEach(([k, v]) => (html += `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`));
    html += `</div>`;
  }
  // compatible weapons grouped by class
  const groups = {};
  a.compatible.forEach((wn) => {
    const w = idx.weaponByName[wn];
    const cls = w ? w.class : "Other";
    (groups[cls] = groups[cls] || []).push(wn);
  });
  html += `<div class="section"><h3>Fits ${a.compatible.length} weapon${a.compatible.length === 1 ? "" : "s"}</h3>`;
  const order = DATA.classOrder.concat(Object.keys(groups).filter((c) => !DATA.classOrder.includes(c)));
  order.forEach((cls) => {
    if (!groups[cls]) return;
    html += `<div class="lab" style="color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.6px;margin:8px 0 5px">${esc(cls)}</div><div class="chips">`;
    groups[cls].sort().forEach((wn) => {
      const req = a.reqParts && a.reqParts[wn];
      html += `<button class="chip" data-goweapon="${esc(wn)}"${req ? ` title="On ${esc(wn)}: needs ${esc(req)}"` : ""}>${esc(wn)}${req ? '<sup class="req">*</sup>' : ""}</button>`;
    });
    html += `</div>`;
  });
  if (a.reqParts && Object.keys(a.reqParts).length)
    html += `<p class="legend"><span class="req">*</span> on that weapon, this slot must be unlocked by fitting a specific barrel / handguard / upper first.</p>`;
  if (!a.compatible.length) html += `<p class="empty">No compatible weapons listed.</p>`;
  html += `</div></div>`;
  return html;
}

/* ---------- muzzle guide tab ---------- */
function renderMuzzles() {
  let html = `<div class="mz-intro callout">In-game, muzzle devices are just labelled <b>A&ndash;Q</b> (and suppressors <b>A&ndash;F</b>)
    with no hint of what fits where. They actually come in <b>5 mount families</b>. A device only fits weapons in its family &mdash;
    match the family, not the letter.</div><div class="mzgrid">`;
  SUBTYPE_ORDER.forEach((st) => {
    const s = idx.subtypes[st]; if (!s) return;
    if (state.q) {
      const hit = [...s.weapons].some((w) => match(w)) || s.mzd.concat(s.smzd).some((m) => match(m));
      if (!hit) return;
    }
    const weapons = [...s.weapons].sort();
    html += `<div class="mzcard" data-anchor="${st.toLowerCase()}"><h3>${st}</h3><div class="fam">${esc(SUBTYPE_LABEL[st] || "")}</div>
      <div class="lab">Muzzle devices</div><div class="chips">
      ${s.mzd.map((m) => `<button class="chip" data-goatt="${esc("MZD:" + m)}">${esc(m)}</button>`).join("")}</div>`;
    if (s.smzd.length) html += `<div class="lab">Suppressed</div><div class="chips">
      ${s.smzd.map((m) => `<button class="chip" data-goatt="${esc("SMZD:" + m)}">${esc(m)}</button>`).join("")}</div>`;
    html += `<div class="lab">Fits these weapons</div><div class="chips">
      ${weapons.map((w) => `<button class="chip" data-goweapon="${esc(w)}">${esc(w)}</button>`).join("")}</div></div>`;
  });
  html += `</div>`;
  view.innerHTML = html;
}

/* ---------- stats guide tab ---------- */
function renderStats() {
  view.classList.remove("detail-open");
  view.innerHTML = `
  <div class="guide">
    <div class="callout" style="margin-top:16px">
      <b>The weapon card is misleading by design.</b> What it shows is an aggregated
      display number, and several of those numbers don't change what they look like they
      change. Here's what each stat <em>actually</em> does — and which ones to ignore.
    </div>

    <div class="card" data-anchor="basics">
      <div class="section" style="margin-top:0"><h3>The only two stats that visibly matter</h3></div>
      <div class="gdef"><span class="term">Accuracy</span><span>How tightly your shots land. At ~90 accuracy a gun puts rounds dead-centre (hip-fire <em>or</em> aimed); lower accuracy widens a random spread cone. This is the single handling number worth chasing, and it's the one attachments meaningfully raise.</span></div>
      <div class="gdef"><span class="term">Magazine capacity</span><span>Rounds per reload. Obvious, and real. Note: mag size is changed by <b>weapon parts</b> (different magazines), <b>not</b> by attachments.</span></div>
    </div>

    <div class="card" data-anchor="display-only">
      <div class="section" style="margin-top:0"><h3>Stats that are display-only, buggy, or disputed</h3></div>
      <div class="gdef"><span class="term">Recoil</span><span>Shown as a single number but it's a <b>compound</b> of hidden values ("wrist" + "arm" recoil). It's theorised to drive <em>camera shake</em> only — it does <b>not</b> move your point of aim under fire. The wild numbers you see when swapping parts are aggregation errors, not real changes.</span></div>
      <div class="gdef"><span class="term">Stability</span><span><b>Real, and higher is better.</b> Decoded from the game data: Stability feeds the <b>bullet-spread (dispersion)</b> system — <b>higher Stability = tighter sustained fire</b> — and never touches the recoil kick. This overturns the old "keep it low" advice. Numbers in <a href="#underhood">Under the hood</a>, just below.</span></div>
      <div class="gdef"><span class="term">The stat card as a whole</span><span>It aggregates several parameters into display values and is frequently wrong when a weapon is modified. Trust behaviour in the shooting range over the card.</span></div>
    </div>

    <div class="card" id="underhood" data-anchor="underhood">
      <div class="section" style="margin-top:0"><h3>Under the hood: what Stability really does <span class="badge gold">from the game files</span></h3></div>
      <p>Read straight out of the shipping game's weapon code (the compiled <code>FWWeapon</code> module), "handling" is actually <b>three separate systems</b> — which is exactly why the card confuses everyone:</p>
      <div class="gdef"><span class="term">1 · Recoil — the kick</span><span>The visual muzzle climb: <code>RecoilWristYaw/Pitch</code>, <code>RecoilArmAngle</code>, <code>RecoilWristRecoveryBlend</code>, <code>ScaleRecoilADS</code> — a wrist + arm model, which is why the displayed "Recoil" is a compound. Parts tune it through <code>RecoilWristRelBuff</code> / <code>RecoilArmRelBuff</code>. <b>Stability is not an input here</b>, so "stability doesn't change recoil" is literally correct.</span></div>
      <div class="gdef"><span class="term">2 · Dispersion — the spread <em>(this is Stability)</em></span><span>Your real accuracy under fire: a spread cone that grows at <code>MaxDispersionRate</code> while you hold the trigger and shrinks via <code>DispersionCoolDownStart/Rate</code> once you stop. The weapon carries three curves — <code>StabilityMaxDispersionRateCurve</code>, <code>StabilityDispersionCoolDownStartCurve</code>, <code>StabilityDispersionCoolDownStopCurve</code> — that convert the <b>Stability</b> stat into those spread values. So Stability governs <b>how fast your spread blooms and how quickly it recovers</b> — not the kick you see. And <b>higher Stability = tighter</b> (exact numbers below).</span></div>
      <div class="gdef"><span class="term">3 · Aim-lag — the sway/settle</span><span>A spring system (<code>AimLagSpringStiffness/Damping/Mass</code>, <code>MaxAimLagYaw/Pitch</code>) with <code>StabilizeFireTime</code> and the <code>StabilizeTimeRelBuff</code> / <code>StabilizeScalarRelBuff</code> buffs — how fast the reticle re-settles after firing or moving. This is what item cards call "stabilization speed / length".</span></div>
      <p class="gnote"><b>So the argument resolves cleanly:</b> testers who watched the <em>recoil kick</em> saw no change (right — wrong system); players who felt tighter <em>sustained fire</em> were feeling dispersion. <b>Stability = spread, Recoil = kick, Stabilize = sway.</b></p>
      <div class="section"><h3>The actual numbers <span class="c">assault rifles (AK family)</span></h3></div>
      <p class="gnote">Decoded straight from the weapon's <code>Stability…DispersionCurve</code> assets. As the <b>Stability</b> stat rises from 0 → 1:</p>
      <div class="gtable-wrap"><table class="gtable">
        <thead><tr><th>What it sets</th><th>Stability 0</th><th>Stability 1</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td>Max spread-growth rate</td><td>3.0</td><td>1.5</td><td>spread blooms <b>half as fast</b></td></tr>
          <tr><td>Recovery start delay</td><td>0.33 s</td><td>0.17 s</td><td>starts tightening <b>sooner</b></td></tr>
          <tr><td>Recovery rate</td><td>0.175</td><td>0.35</td><td>tightens <b>twice as fast</b></td></tr>
        </tbody>
      </table></div>
      <div class="callout" style="border-left-color:var(--olive)"><b>Verdict: higher Stability = tighter sustained fire, unambiguously.</b> Spread grows slower <em>and</em> recovers faster. It never touches recoil (the kick values are fixed per weapon). So the old "keep Stability low" advice is backwards — it was confusing Stability with recoil.</div>
      <p class="legend">Method: property/curve names from the shipping binary; curve values decoded from the game assets via a UE4SS-dumped type mapping. Cross-checked against the wiki (AK <code>WeaponDamage</code> 150 &amp; fire rate 0.09 s both matched exactly).</p>
    </div>

    <div class="card" data-anchor="damage">
      <div class="section" style="margin-top:0"><h3>Damage (the hidden part)</h3></div>
      <div class="gdef"><span class="term">Base damage</span><span>Tied to the weapon (balanced around caliber/type), <b>not</b> to which ammo you load. The card often <b>under-reports</b> real damage — e.g. the AT-43 MASS deals roughly double what it lists, and shotguns and Painless read low too. Don't dismiss a gun by its listed damage alone.</span></div>
      <div class="gdef"><span class="term">Critical / headshot damage</span><span>A per-<b>caliber</b> multiplier that lives on your <b>ammo</b>, not the gun &mdash; a head hit multiplies the weapon's listed damage by it. Most rounds sit at the <b>1.5×</b> baseline, but a few big single-shot calibers <b>triple</b> it and <b>shotguns are penalised</b>, so a lower-damage, high-crit caliber can out-perform a bigger gun on consistent headshots. Some enemies (notably melee cyborgs) also have headshot <em>resistance</em>. <button class="linklike" data-gohs>See the full per-caliber table on the <b>Ammo</b> tab &rarr;</button></span></div>
    </div>
    </div>

    <div class="card" data-anchor="attachment-effects">
      <div class="section" style="margin-top:0"><h3>What each attachment type really changes</h3></div>
      <p class="gnote">Within a category every item gives the <b>same</b> bonus — only the look differs (the displayed % also scales per weapon). Relative effect:</p>
      <div class="gtable-wrap"><table class="gtable">
        <thead><tr><th>Attachment</th><th>Accuracy</th><th>Handling*</th><th>Works?</th><th>Real reason to fit it</th></tr></thead>
        <tbody>
          <tr><td>Optic (red dot)</td><td>—</td><td>—</td><td class="ok">yes</td><td><b>Zero stat change</b> — purely the sight picture. Pick for a clear view (Spook occludes least).</td></tr>
          <tr><td>Foregrip</td><td>+++</td><td>+++</td><td class="ok">yes</td><td><b>Biggest</b> accuracy/handling gain of the common parts. If a slot's open, fit one.</td></tr>
          <tr><td>Muzzle device</td><td>+</td><td>+</td><td class="ok">yes</td><td>Small tune; choice within a mount family is basically cosmetic.</td></tr>
          <tr><td>Suppressor</td><td>+</td><td>+</td><td class="ok">yes</td><td>Quieter shots (stealth) at almost no stat cost — the real reason to run one.</td></tr>
          <tr><td>Scope (magnified)</td><td>+++</td><td>+++</td><td class="bad">no</td><td>Big numbers + zoom, but flagged <b>non-functional</b> right now.</td></tr>
          <tr><td>Laser sight</td><td>+</td><td>+</td><td class="bad">no</td><td>Minor on paper; currently <b>non-functional</b>.</td></tr>
          <tr><td>Flashlight</td><td>~</td><td>~</td><td class="bad">buggy</td><td>Negligible, and causes fog glare — devs suggest avoiding for now.</td></tr>
        </tbody>
      </table></div>
      <p class="gnote">*Handling = the recoil / stabilisation numbers — real-world benefit is small given how unreliable those stats are. The accuracy bump is the part that actually helps.</p>
    </div>

    <div class="card" data-anchor="glossary">
      <div class="section" style="margin-top:0"><h3>Attachment stat glossary</h3></div>
      <div class="gdef"><span class="term">Accuracy</span><span>Tighter shot grouping. The meaningful one.</span></div>
      <div class="gdef"><span class="term">Recoil (1st / 3rd person)</span><span>Camera kick you see while aiming / that others see. Cosmetic-ish; doesn't shift your aim.</span></div>
      <div class="gdef"><span class="term">Stabilization speed / length</span><span>How fast, and for how long, the sight re-settles after a shot. Theorised, minor.</span></div>
      <div class="gdef"><span class="term">ADS speed</span><span>How quickly you aim down sights.</span></div>
      <div class="gdef"><span class="term">Reload speed</span><span>Reload time. (Attachments here don't change it — it's 0 across the board.)</span></div>
      <div class="gdef"><span class="term">FOV</span><span>Zoom, on scopes only.</span></div>
      <div class="gdef"><span class="term">Damage / Mag capacity</span><span>Not touched by attachments — those come from the weapon and its parts.</span></div>
    </div>

    <div class="callout">
      <b>Bottom line.</b> Chase <b>accuracy</b> and <b>magazine size</b>; ignore the recoil/stability
      numbers. Fit a <b>foregrip</b> where you can, pick <b>optics by how clearly you can see</b>, and run a
      <b>suppressor</b> for stealth. Treat scopes, laser sights, flashlights, bipods and bayonets as
      currently non-functional.
    </div>
    <p class="legend">Sources: <a href="https://theforeverwinter.wiki.gg/wiki/Weapons" target="_blank" rel="noopener">Weapons</a> &amp; <a href="https://theforeverwinter.wiki.gg/wiki/Weapon_Attachments" target="_blank" rel="noopener">Weapon Attachments</a> wiki pages + community testing. Mechanics are WIP and stats are flagged unreliable by the devs — verify in the shooting range.</p>
  </div>`;
}

/* ---------- ammo tab ---------- */
async function renderAmmo() {
  view.classList.remove("detail-open");
  if (!AMMO) {
    view.innerHTML = `<div class="placeholder" style="margin-top:16px">Loading ammunition&hellip;</div>`;
    try {
      AMMO = await (await fetch("data/ammo.json", { cache: "no-cache" })).json();
      AMMO.byKey = {}; AMMO.ammo.forEach((a) => (AMMO.byKey[a.key] = a));
    } catch (e) { view.innerHTML = `<p class="empty">Could not load ammo data.<br><small>${esc(e.message)}</small></p>`; return; }
  }
  drawAmmo();
}

// which weapons fire each caliber — inverted live from the weapon list so it
// always tracks the Weapons tab (variants share their parent caliber's guns).
function ammoUsedBy() {
  const by = {};
  ((DATA && DATA.weapons) || []).forEach((w) => {
    const ws = WEAPONS && WEAPONS[w.name.toLowerCase()];
    const key = ws && ws.ammo ? ammoToCal(ws.ammo) : null;
    if (key) (by[key] = by[key] || []).push(w.name);
  });
  return by;
}

const ammoUnit = (u) => ` <small style="font-size:11px;color:var(--dim)">${u}</small>`;
function ammoCard(a, usedBy) {
  const cell = (k, v) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const grid = [
    a.headshot != null ? `<div class="stat"><div class="k">Headshot</div><div class="v hs-${a.band}">&times;${a.headshot}</div></div>` : "",
    a.value != null ? cell("Sell value", bNum(a.value) + ammoUnit("cr")) : "",
    a.xp != null ? cell("Extract XP", a.xp) : "",
    a.weight != null ? cell("Weight", a.weight + ammoUnit("kg")) : "",
    a.volume != null ? cell("Volume", a.volume) : "",
  ].filter(Boolean).join("");
  const guns = usedBy[a.weaponKey] || [];
  const chips = guns.length
    ? `<div class="ammo-usedby"><div class="lab">Used by</div><div class="chips">${guns.map((g) => `<button class="chip" data-goweapon="${esc(g)}">${esc(g)}</button>`).join("")}</div></div>`
    : "";
  return `<div class="ammo-card" data-anchor="${esc(a.key)}">
    <div class="ammo-head"><span class="ammo-name">${esc(a.name)}</span>
      ${a.faction ? `<span class="badge">${esc(a.faction)}</span>` : ""}${(state.dataset === "rebalance" && rbAffected.ammo.has(a.key)) ? `<span class="badge rust" title="Changed by ${esc((REBAL.meta || {}).name || "the mod")}">${esc((REBAL.meta || {}).badge || (REBAL.meta || {}).short || "Mod")}</span>` : ""}</div>
    ${grid ? `<div class="statgrid ammo-stats">${grid}</div>` : ""}
    ${a.desc ? `<p class="ammo-desc">${esc(a.desc)}</p>` : ""}
    ${chips}
  </div>`;
}

function drawAmmo() {
  const D = AMMO;
  const usedBy = ammoUsedBy();
  const matchAmmo = (a) => match(a.name) || match(a.desc || "") || match(a.key);
  const base = D.headshotBaseline;

  let html = `<div class="guide">` + datasetBar() +
    `<div class="callout" style="margin-top:16px"><b>Every round in the game.</b> ${esc(D.note)}</div>`;

  // headshot-at-a-glance table (the datamined per-caliber multipliers, moved here
  // from Stats). It's a reference chart, so it's shown only when not searching.
  if (!state.q) {
    const hsRows = D.ammo.filter((a) => a.headshot != null).slice()
      .sort((x, y) => y.headshot - x.headshot || x.name.localeCompare(y.name));
    html += `<div class="card" id="ammo-headshots" data-anchor="headshots"><div class="section" style="margin-top:0"><h3>Headshot multipliers <span class="c">per caliber &middot; ${base}&times; baseline</span></h3></div>
      <p class="gnote">A head hit multiplies the weapon's <b>listed damage</b> by this. It lives on the <b>ammo</b>, not the gun &mdash; so a lower-damage, high-crit caliber can beat a bigger gun on consistent headshots.</p>
      <div class="gtable-wrap"><table class="gtable"><thead><tr><th>Caliber</th><th class="num">Headshot</th><th>vs ${base}&times; baseline</th></tr></thead><tbody>${
        hsRows.map((a) => `<tr><td>${esc(a.name)}</td><td class="num ${a.band === "high" ? "ok" : a.band === "low" ? "bad" : ""}">&times;${a.headshot}</td><td>${a.band === "high" ? "<b>higher crit</b> &mdash; reward headshots" : a.band === "low" ? "lower &mdash; body shots hit harder" : "baseline"}</td></tr>`).join("")
      }</tbody></table></div>
      <p class="gnote">Some enemies (notably melee cyborgs) also carry headshot <em>resistance</em>. <b>.50 PST</b> and Nitro Express have no datamined headshot value.</p></div>`;
  }

  // one card per category, each holding its ammo rows
  let sections = "";
  D.categories.forEach((c) => {
    const list = D.ammo.filter((a) => a.category === c.key && matchAmmo(a));
    if (!list.length) return;
    sections += `<div class="card" data-anchor="${esc(c.key)}"><div class="section" style="margin-top:0"><h3>${esc(c.label)} <span class="c">&times;${list.length}</span></h3></div>
      <p class="gnote">${esc(c.note)}</p>
      ${list.map((a) => ammoCard(a, usedBy)).join("")}</div>`;
  });
  if (!sections && state.q) html += `<p class="empty">No ammo matches &ldquo;${esc(state.q)}&rdquo;.</p>`;
  else html += sections;

  html += `<p class="legend">Method: merged from <code>ItemDetailsData</code> (names, blurbs, weight/volume), <code>ValueV2_AMMO</code> (sell value + extraction XP) and <code>DT_CaliberToHeadshotMulti</code> via CUE4Parse (build ${D.build}). Which weapons fire each round is cross-referenced live against the Weapons list; the &ldquo;used by&rdquo; chips open the weapon.</p></div>`;
  view.innerHTML = html;
}

/* ---------- crafting / manufacturing tab ---------- */
async function renderCrafting() {
  view.classList.remove("detail-open");
  if (!CRAFT_V) {
    view.innerHTML = `<div class="placeholder" style="margin-top:16px">Loading crafting recipes&hellip;</div>`;
    try { CRAFT_V = await (await fetch("data/crafting.json", { cache: "no-cache" })).json(); }
    catch (e) { view.innerHTML = `<p class="empty">Could not load crafting data.<br><small>${esc(e.message)}</small></p>`; return; }
    buildCraftRB();
    CRAFT = state.dataset === "rebalance" ? CRAFT_RB : CRAFT_V;
  }
  drawCrafting();
}

function recipeCard(r) {
  const io = (x) => `${x.qty > 1 ? `<span class="rq">${x.qty}&times;</span> ` : ""}${esc(x.name)}`;
  const ins = (r.inputs || []).map(io).join(`<span class="rplus">+</span>`) || "&mdash;";
  const outs = (r.outputs || []).map(io).join(`<span class="rplus">+</span>`) || "&mdash;";
  const req = (r.required && r.required.length) ? `<span class="craft-req" title="Requires ${esc(r.required.join(", "))}">&#128274; gated</span>` : "";
  const t = (r.time && r.time !== "Instant") ? `&#9201; ${esc(r.time)}` : "Instant";
  return `<div class="recipe">
    <div class="recipe-out">${outs}</div>
    <div class="recipe-in"><span class="rlab">from</span> ${ins}</div>
    <div class="recipe-meta"><span class="craft-time">${t}</span>${req}</div>
  </div>`;
}

function drawCrafting() {
  const D = CRAFT, rb = state.dataset === "rebalance", q = state.q;
  const recMatch = (r) => !q || r.name.toLowerCase().includes(q)
    || (r.inputs || []).some((i) => i.name.toLowerCase().includes(q))
    || (r.outputs || []).some((o) => o.name.toLowerCase().includes(q));
  const cats = D.categoryOrder || [];
  const byCat = {};
  D.groups.forEach((g) => (byCat[g.category] = byCat[g.category] || []).push(g));
  const order = cats.map((c) => c.key).concat(Object.keys(byCat).filter((k) => !cats.some((c) => c.key === k)));

  let html = `<div class="guide craft">` + datasetBar() +
    `<div class="callout" style="margin-top:16px"><b>Manufacturing.</b> Every crafting recipe in the game, pulled straight from its data tables &mdash; what each makes, what it costs, and how long it takes.${rb ? ` Overlaid with <b>${esc((REBAL.meta || {}).name)}</b>&rsquo;s added recipes.` : ""}</div>`;

  let any = false;
  order.forEach((ck) => {
    const gs = byCat[ck]; if (!gs) return;
    const label = (cats.find((c) => c.key === ck) || {}).label || ck;
    let inner = "";
    gs.forEach((g) => {
      const recs = (g.recipes || []).filter(recMatch);
      if (!recs.length) return;
      any = true;
      inner += `<div class="craft-group" data-anchor="craft-${esc(g.key)}"><div class="section" style="margin-top:0"><h3>${esc(g.name)}${g.mod ? ` <span class="ds-badge">${esc((REBAL.meta || {}).badge || (REBAL.meta || {}).short || "Mod")}</span>` : ""} <span class="c">&times;${recs.length}</span></h3></div>${g.subtext ? `<p class="gnote">${esc(g.subtext)}</p>` : ""}<div class="craft-recipes">${recs.map(recipeCard).join("")}</div></div>`;
    });
    if (inner) html += `<div class="grp craft-cat">${esc(label)}</div>${inner}`;
  });
  if (!any) html += `<p class="empty">No recipes match &ldquo;${esc(q)}&rdquo;.</p>`;
  html += `<p class="legend">Source: datamined <code>DT_ManufactoringRecipies</code> + <code>DT_ManufactoringGroups</code>; ingredient names resolved via <code>ItemDetailsData</code> / <code>DanglyDetailsData</code>. Craft times are the game&rsquo;s real-world timers.</p></div>`;
  view.innerHTML = html;
}

/* ---------- detection / stealth tab ---------- */
let DET = null;
async function renderDetection() {
  view.classList.remove("detail-open");
  if (!DET) {
    view.innerHTML = `<div class="placeholder" style="margin-top:16px">Loading detection data…</div>`;
    try { DET = await (await fetch("data/detection.json", { cache: "no-cache" })).json(); }
    catch (e) { view.innerHTML = `<p class="empty">Could not load detection data.<br><small>${esc(e.message)}</small></p>`; return; }
  }
  const D = DET;
  const gm = D.globalModel;
  const num = (v) => (v === null || v === undefined) ? "—" : v;
  const mrow = (m) => {
    const good = m.acc >= 1 && m.decay <= 1;
    const bad = m.acc < 1 || m.decay > 1;
    const cls = good ? "ok" : (bad ? "bad" : "");
    const tag = good ? "stealthier" : (bad ? "easier to spot" : "mixed");
    return `<tr><td>${esc(m.factor)}</td><td class="${cls}">${tag}</td><td>${esc(m.effect)}</td></tr>`;
  };
  const erow = (e) => `<tr title="${esc(e.notes)}">
      <td>${esc(e.name)}<div class="esub">${esc(e.class)}</div></td>
      <td>${e.visionFar ? `${num(e.visionNear)} → ${num(e.visionFar)} m` : "—"}</td>
      <td>${e.coneH ? e.coneH + "°" : "—"}</td>
      <td>${e.hearing ? e.hearing + " m" : "—"}</td>
      <td>${e.esp ? esc(e.esp) : "—"}</td></tr>`;
  const nmax = Math.max(...D.noise.map((n) => n.radius || 0.1));
  const nrow = (n) => {
    const pct = Math.max(2, Math.round((Math.log10((n.radius || 0.5) + 1) / Math.log10(nmax + 1)) * 100));
    return `<div class="noise-row"><span class="noise-name">${esc(n.action)}</span>
      <span class="noise-bar"><span style="width:${pct}%"></span></span>
      <span class="noise-val">${n.radius === 0 ? esc(n.label || "silent") : (n.label ? esc(n.label) : n.radius + " m")}</span></div>`;
  };

  view.innerHTML = `<div class="guide">
    <div class="callout" style="margin-top:16px"><b>Datamined from the game's own AI, not the forums.</b>
      These are the real numbers behind how enemies detect you — sight, sound, and the through-wall "sixth sense".
      Ranges are converted to metres.</div>

    <div class="card" data-anchor="senses">
      <div class="section" style="margin-top:0"><h3>The six ways they sense you</h3></div>
      ${D.senses.map((s) => `<div class="gdef"><span class="term">${esc(s.name)}</span><span>${esc(s.desc)}</span></div>`).join("")}
    </div>

    <div class="card" data-anchor="enemies">
      <div class="section" style="margin-top:0"><h3>Per-enemy senses <span class="c">hover a row for tactics</span></h3></div>
      <div class="gtable-wrap"><table class="gtable">
        <thead><tr><th>Enemy</th><th>Vision (near→far)</th><th>Cone</th><th>Hearing</th><th>ESP</th></tr></thead>
        <tbody>${D.enemies.map(erow).join("")}</tbody>
      </table></div>
      <p class="gnote">Vision is a line-of-sight cone; you build detection faster up close (near range) than at the edge (far range). ESP ignores walls. "∞" = effectively omniscient at range (turrets, Hunter-Killers).</p>
    </div>

    ${D.hunterKillers ? `<div class="card" id="hunterkillers" data-anchor="hunter-killers">
      <div class="section" style="margin-top:0"><h3>Hunter-Killers: how you summon them <span class="badge gold">datamined</span></h3></div>
      <p class="gnote">${esc(D.hunterKillers.intro)}</p>
      <div class="section"><h3 style="color:var(--rust)">Any one of these trips it</h3></div>
      ${D.hunterKillers.triggers.map((t) => `<div class="gdef"><span class="term">${esc(t.label)}</span><span>${esc(t.detail)}</span></div>`).join("")}
      <div class="section"><h3>What happens when it trips</h3></div>
      ${D.hunterKillers.behavior.map((b) => `<div class="gdef"><span class="term">${esc(b.k)}</span><span>${esc(b.v)}</span></div>`).join("")}
      <div class="callout" style="border-left-color:var(--rust)"><b>Quest link.</b> ${esc(D.hunterKillers.questNote)}</div>
      <p class="gnote">${esc(D.hunterKillers.escalation)}</p>
    </div>` : ""}

    <div class="card" data-anchor="visibility">
      <div class="section" style="margin-top:0"><h3>What makes <em>you</em> visible</h3></div>
      <div class="gtable-wrap"><table class="gtable">
        <thead><tr><th>Factor</th><th>Effect</th><th>What it does</th></tr></thead>
        <tbody>${D.modifiers.map(mrow).join("")}</tbody>
      </table></div>
      <p class="gnote">${esc(D.note)}</p>
    </div>

    <div class="card" data-anchor="noise">
      <div class="section" style="margin-top:0"><h3>Noise you make (audible radius)</h3></div>
      <div class="noise-list">${D.noise.map(nrow).join("")}</div>
      <p class="gnote">Crouch-moving emits <b>no</b> noise event at all. Sprinting is ~3× louder than walking; a single gunshot is heard 75–100 m away.</p>
    </div>

    <div class="card" data-anchor="timing">
      <div class="section" style="margin-top:0"><h3>Timing &amp; memory</h3></div>
      <div class="statgrid">
        <div class="stat"><div class="k">Confirm a target</div><div class="v">${esc(gm.identifyTime)}</div></div>
        <div class="stat"><div class="k">Lose you — Rookies</div><div class="v">${esc(gm.lostTarget["Rookies"])}</div></div>
        <div class="stat"><div class="k">Lose you — Career</div><div class="v">${esc(gm.lostTarget["Career Soldiers"])}</div></div>
        <div class="stat"><div class="k">Lose you — Special Forces</div><div class="v">${esc(gm.lostTarget["Special Forces"])}</div></div>
        <div class="stat"><div class="k">Search last-known</div><div class="v">${esc(gm.hiddenSearch)}</div></div>
        <div class="stat"><div class="k">Area stays hot</div><div class="v">${esc(gm.alertnessCooldown)}</div></div>
      </div>
      <p class="gnote">${esc(gm.alertnessNote)}</p>
      <div class="callout"><b>Squad transference.</b> ${esc(D.transference.desc)}</div>
    </div>

    ${D.targetPriority ? `<div class="card" id="det-priority" data-anchor="priority">
      <div class="section" style="margin-top:0"><h3>How enemies choose a target <span class="badge gold">datamined</span></h3></div>
      <p class="gnote">${esc(D.targetPriority.intro)}</p>
      <div class="gtable-wrap"><table class="gtable">
        <thead><tr><th>What it weighs</th><th class="num">Weight</th><th>Meaning</th></tr></thead>
        <tbody>${D.targetPriority.weights.map((w) => `<tr><td>${esc(w.factor)}</td><td class="num gold">${w.weight}</td><td>${esc(w.desc)}</td></tr>`).join("")}</tbody>
      </table></div>
      <p class="gnote">${esc(D.targetPriority.note)}</p>
      <div class="callout">${esc(D.targetPriority.badgeNote)}</div>
    </div>` : ""}

    <p class="legend">Method: decoded from the shipping game's <code>FWAI</code> awareness assets (vision/hearing/ESP sensor definitions, noise events, transference) via a UE4SS type mapping + CUE4Parse. Ranges: Unreal units ÷100 = metres. Modifier directions verified against in-game roles (crouch stealthier, shooting louder).</p>
  </div>`;
}

/* ---------- enemies tab ---------- */
let ENEMYDATA = null;
const bNum = (n) => Number(n).toLocaleString();
const mdb = (s) => esc(s == null ? "" : String(s)).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*([^*\n]+?)\*/g, "<i>$1</i>").replace(/`([^`]+)`/g, "<code>$1</code>");
const CAL_LABEL = { "545": "5.45mm", "556": "5.56mm", "762": "7.62mm", "919": "9mm", "308": ".308", "40m": "40mm", "12G": "12ga" };

async function renderEnemies() {
  view.classList.remove("detail-open");
  if (!ENEMYDATA) {
    view.innerHTML = `<div class="placeholder" style="margin-top:16px">Loading enemy intel&hellip;</div>`;
    try { ENEMYDATA = await (await fetch("data/enemies.json", { cache: "no-cache" })).json(); }
    catch (e) { view.innerHTML = `<p class="empty">Could not load enemy data.<br><small>${esc(e.message)}</small></p>`; return; }
  }
  drawEnemies();
}

function bossStaggerVal(s) {
  if (!s || s.damage == null) return "&mdash;";
  if (s.damage >= 999999) return `<span class="dim">Immune</span>`;
  if (s.damage >= 99999) return `${bNum(s.damage)} <span class="dim">&middot; ≈immune</span>`;
  return `${bNum(s.damage)}${s.window ? ` <span class="dim">in ${s.window}s</span>` : ""}`;
}
function bossGrabVal(g) {
  if (!g || !g.vsPlayer) return null;
  if (g.hpAlways) return `<b>Any</b> health &middot; ${g.rangeM} m`;
  return `&le; ${bNum(g.hpThreshold)} HP &middot; ${g.rangeM} m`;
}

function unitCard(b) {
  const isBoss = b.tier === "boss";
  let h = `<div class="card boss${isBoss ? "" : " unit"}" id="enemy-${esc(b.id)}" data-anchor="${esc(b.id)}">
    <div class="dhead"><h2>${esc(b.name)}</h2>
      <span class="badge gold">${esc(b.faction)}</span>
      <span class="badge olive">${esc(b.type)}</span>
      ${b.aka ? `<span class="badge">${esc(b.aka)}</span>` : ""}
      ${b.threat ? `<button class="badge boss-threat" data-goai title="The enemy AI's internal target-priority tier for this unit — an input to how squads pick who to shoot, not a danger rating. Click for how it works.">AI priority: ${esc(b.threat)} <small>(internal)</small></button>` : ""}</div>`;
  if (isBoss && b.blurb) h += `<p class="boss-blurb">${mdb(b.blurb)}</p>`;
  if (b.desc) h += `<p class="boss-desc">${mdb(b.desc)}</p>`;
  if (!isBoss) {
    const meta = [];
    if (b.variants) meta.push(`<b>Variants:</b> ${esc(b.variants)}`);
    if (b.location) meta.push(`<b>Found:</b> ${esc(b.location)}`);
    if (meta.length) h += `<p class="unit-meta">${meta.join(" &middot; ")}</p>`;
  }

  const grab = bossGrabVal(b.grab);
  // durability slot — every card gets one: armour sum, real HP, ∞ for the
  // sentinel-HP bosses (defeated by mechanics/evasion, not damage), or "Heavy" for tanks.
  let durLabel = "Health", durVal = null;
  const dpKill = b.codexKill && (b.codexKill.method === "detpack" || b.codexKill.method === "uncertain");
  if (dpKill) {
    durLabel = "Body HP";
    const hp = b.realHp ? bNum(b.realHp) : "1,000,000,000";
    durVal = `<span class="help" title="Datamined body HP = ${hp} — gunfire can't drop it. You stun it (only your damage builds stagger) and plant Special Units DetPacks while it's stunned; 3 plants trigger a scripted kill that bypasses the HP pool, then you drill the corpse for the Codex.">&infin; <small class="dim">DetPack kill</small></span>`;
  }
  else if (b.health && b.health.total) { durLabel = "Armour"; durVal = bNum(b.health.total); }
  else if (b.hp) { durVal = bNum(b.hp); }
  else if (b.hpNote === "invincible") { durVal = `<span class="help" title="Datamined max HP = 1,000,000,000 — invincible to gunfire. Defeated by stunning it and planting Special Units DetPacks, or simply evaded.">&infin; <small class="dim">invincible</small></span>`; }
  h += `<div class="statgrid">`;
  if (durVal) h += `<div class="stat"><div class="k">${durLabel}</div><div class="v">${durVal}</div></div>`;
  h += `<div class="stat key"><div class="k">Stagger &middot; stun</div><div class="v">${bossStaggerVal(b.stagger)}</div></div>`;
  if (grab) h += `<div class="stat"><div class="k">Instakill grab</div><div class="v">${grab}</div></div>`;
  h += `<div class="stat"><div class="k">Kill XP</div><div class="v">${b.killXp ? bNum(b.killXp) : "&mdash;"}</div></div>`;
  h += `</div>`;

  if (b.health && b.health.components) {
    h += `<div class="section"><h3>Armour zones <span class="c">${bNum(b.health.total)} total</span></h3><div class="chips">`;
    b.health.components.forEach((c) => {
      h += `<span class="chip static boss-zone${c.critical ? " crit" : ""}">${esc(c.tag)} <b>${bNum(c.hp)}</b>${c.impact != null ? ` <small>&times;${c.impact}</small>` : ""}</span>`;
    });
    h += `</div><p class="gnote">Each zone is its own hit-box; <b>&times;</b> is the fraction of damage it takes &mdash; the <span style="color:var(--rust)">vulnerable</span> zone takes full damage, the heavy plate soaks 90%.</p></div>`;
  }

  const rows = [];
  if (b.melee) rows.push(["Melee", `${b.melee.hits > 1 ? b.melee.hits + "-hit combo &middot; " : ""}${bNum(b.melee.min)}${b.melee.max !== b.melee.min ? "&ndash;" + bNum(b.melee.max) : ""} dmg`]);
  if (b.dash) rows.push(["Dash / lunge", `${bNum(b.dash.damage)} dmg &middot; ${b.dash.minM}&ndash;${b.dash.maxM} m reach &middot; ${b.dash.cooldown}s cd`]);
  (b.weapons || []).forEach((w) => rows.push([esc(w.name),
    w.builtin ? `<span class="dim">built-in mount</span>` :
    [w.damage != null ? bNum(w.damage) + " dmg" : "", w.rps ? `${w.rps}/s` : "", w.caliber ? (CAL_LABEL[w.caliber] || w.caliber) : "", w.knockdown ? "knockdown" : ""].filter(Boolean).join(" &middot; ")]));
  if (rows.length) {
    h += `<div class="section"><h3>Attacks</h3><div class="gtable-wrap"><table class="gtable"><tbody>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</tbody></table></div></div>`;
  }

  if (b.senses) {
    const s = b.senses, bits = [];
    bits.push(s.visionFar ? `<b>Vision</b> ${s.visionNear}&rarr;${s.visionFar} m${s.coneH ? ` <span class="dim">${s.coneH}&deg;</span>` : ""}`
                          : `<b>Vision</b> <span class="dim">none — blind</span>`);
    if (s.hearing) bits.push(`<b>Hearing</b> ${s.hearing} m`);
    if (s.esp) bits.push(`<b>ESP</b> ${esc(s.esp)}`);
    h += `<div class="section"><h3>Senses <button class="linklike" data-godetect>full detection model &rarr;</button></h3>
      <div class="unit-senses">${bits.join(` <span class="dim">&middot;</span> `)}</div>
      ${s.notes ? `<p class="gnote">${mdb(s.notes)}</p>` : ""}</div>`;
  }

  if (b.weakpoint) h += `<div class="callout" style="border-left-color:var(--olive)"><b>Weak point.</b> ${mdb(b.weakpoint)}</div>`;

  if (b.weaknesses && b.weaknesses.length) {
    h += `<div class="section"><h3>Weaknesses</h3><ul class="boss-weak">${b.weaknesses.map((w) => `<li>${mdb(w)}</li>`).join("")}</ul></div>`;
  }

  if (b.codexKill) {
    const ck = b.codexKill;
    let how;
    if (ck.method === "gunfire") how = "Finite HP — kill it with sustained anti-tank / heavy fire.";
    else if (ck.method === "detpack") how = `Gunfire can't kill it. Stun it (**${bNum(ck.stunThreshold)}**${ck.stunWindow ? ` in ${ck.stunWindow}s` : ""}, your damage only) and plant **${ck.plants} Special Units DetPacks** while it's stunned — 3 plants trigger a scripted kill.`;
    else how = "Kill method unconfirmed in the datamine.";
    const codexBit = !ck.hasCodex ? " Drops no Codex of its own."
      : ck.codexDelivery === "placed" ? " Its Codex spawns as a lootable item nearby, not a corpse drill."
      : " Drill the corpse for its Codex.";
    h += `<div class="callout" style="border-left-color:var(--gold)"><b>How to kill.</b> ${mdb(how + codexBit)}${ck.note ? ` <span class="dim">${mdb(ck.note)}</span>` : ""}</div>`;
  }

  if (b.codexReward) {
    const cr = b.codexReward;
    const bits = [];
    if (cr.upgrade) bits.push(`unlocks ${esc(cr.upgrade)}`);
    if (cr.xp != null) bits.push(`${bNum(cr.xp)} XP`);
    if (cr.cr != null) bits.push(`${bNum(cr.cr)} cr`);
    h += `<p class="boss-codex"><b>${esc(cr.name)}</b>${bits.length ? ` &middot; ${bits.join(" &middot; ")}` : ""}</p>`;
  }
  h += `</div>`;
  return h;
}

function enemyMatches(u) {
  return match(u.name) || match(u.type) || (u.aka && match(u.aka)) || match(u.faction)
    || (u.desc && match(u.desc)) || (u.variants && match(u.variants));
}

function drawEnemies() {
  const D = ENEMYDATA;
  const cat = state.enemyCat || "all";
  const shown = D.units.filter((u) => (cat === "all" || u.category === cat) && enemyMatches(u));

  let html = `<div class="guide">
    <div class="callout" style="margin-top:16px"><b>Datamined from each unit's own AI, not the forums.</b>
      Threat class, health, the stun threshold, melee &amp; dash damage, the grab that instakills you, and every mounted gun &mdash; read straight from the game's <code>FWAIPawnDefinition</code> files. The 10 bosses keep hand-written tactics; every other unit is a datamined summary.</div>
    <div class="callout" style="border-left-color:var(--olive)"><b>Two mechanics decide most fights.</b>
      <b>Stagger</b> &mdash; burst that much damage in and it's stunned (only <em>your</em> damage counts &mdash; one railgun shot can freeze what a magazine can't); the big machines are effectively <em>immune</em>. <b>The grab</b> &mdash; a sync-kill that ends the raid on the spot; most only trigger at low health, so <em>staying healthy</em> is a defence.</div>`;

  const chip = (id, label, n) => `<button class="chip ${cat === id ? "on" : ""}" data-enemycat="${esc(id)}">${esc(label)}${n != null ? ` <small>${n}</small>` : ""}</button>`;
  html += `<div class="chips enemy-cats">` + chip("all", "All", D.units.length)
    + D.categories.map((c) => chip(c.id, c.name, D.units.filter((u) => u.category === c.id).length)).join("") + `</div>`;

  if (!shown.length) {
    html += `<p class="empty">No enemies match &ldquo;${esc(state.q)}&rdquo;.</p>`;
  } else {
    D.categories.forEach((c) => {
      if (cat !== "all" && cat !== c.id) return;
      const us = shown.filter((u) => u.category === c.id);
      if (!us.length) return;
      html += `<section class="enemy-cat-sec" id="enemy-cat-${esc(c.id)}" data-anchor="cat-${esc(c.id)}">
        <div class="enemy-cat-head"><h2>${esc(c.name)} <span class="c">${us.length}</span></h2>
        <span class="enemy-cat-blurb">${esc(c.blurb)}</span></div>`;
      html += us.map(unitCard).join("");
      html += `</section>`;
    });
  }

  html += `<p class="legend">Method: decoded from the shipping game's <code>FW/AI/Characters/&hellip;/AIDEF_*</code> pawn definitions, <code>BP_AI_*</code> health components and <code>DA_WPN_*</code> weapon defs via a UE4SS type mapping + CUE4Parse (build ${D.build}). Ranges: Unreal units &divide; 100 = metres. Values cross-checked against the wiki and community testing.</p></div>`;
  view.innerHTML = html;
}

/* ---------- factions / tug-of-war tab ---------- */
let FACTIONDATA = null;
const FCOLOR = { Eurasia: "var(--rust)", Europa: "var(--blue)", Euruska: "var(--olive)", Scavenger: "var(--gold)", "Scav NPC": "var(--gold)", "Water Thieves": "var(--muted)" };

async function renderFactions() {
  view.classList.remove("detail-open");
  if (!FACTIONDATA) {
    view.innerHTML = `<div class="placeholder" style="margin-top:16px">Loading faction control&hellip;</div>`;
    try { FACTIONDATA = await (await fetch("data/factions.json", { cache: "no-cache" })).json(); }
    catch (e) { view.innerHTML = `<p class="empty">Could not load faction data.<br><small>${esc(e.message)}</small></p>`; return; }
  }
  drawFactions();
}

function facBar(control) {
  return `<div class="fac-bar">${control.map((c) => `<span class="fac-seg" style="width:${c.pct}%;background:${FCOLOR[c.faction] || "var(--dim)"}" title="${esc(c.faction)} ${c.pct}%">${c.pct >= 12 ? Math.round(c.pct) : ""}</span>`).join("")}</div>`;
}

function facActionCard(a) {
  const groups = {};
  (a.effects || []).forEach((e) => {
    const key = e.faction + "|" + e.pct;
    (groups[key] = groups[key] || { faction: e.faction, pct: e.pct, maps: [] }).maps.push(e.map);
  });
  const gArr = Object.values(groups).sort((x, y) => y.pct - x.pct);
  let h = `<div class="fac-action" data-anchor="action-${esc(slugify(a.id || a.name))}"><div class="fac-action-head">
      <span class="fac-action-name">${esc(a.name)}</span>
      <span class="badge">${esc(a.where)}</span>
      ${a.durationHours ? `<span class="badge gold">${a.durationHours} h</span>` : ""}</div>`;
  if (a.desc) h += `<p class="fac-action-desc">&ldquo;${esc(a.desc)}&rdquo;</p>`;
  if (gArr.length) {
    h += `<div class="fac-effects">${gArr.map((g) => {
      const up = g.pct >= 0;
      return `<span class="fac-eff ${up ? "up" : "down"}"><span class="fac-dot" style="background:${FCOLOR[g.faction] || "var(--dim)"}"></span>${esc(g.faction)} ${up ? "+" : "−"}${Math.abs(g.pct)}%<small> in ${g.maps.map(esc).join(", ")}</small></span>`;
    }).join("")}</div>`;
  } else {
    h += `<p class="gnote">Local effect &mdash; no cross-map control shift in the data.</p>`;
  }
  return h + `</div>`;
}

function drawFactions() {
  const D = FACTIONDATA;
  let html = `<div class="guide">
    <div class="callout" style="margin-top:16px"><b>Datamined from the game's Tug-of-War system.</b> ${esc(D.note)}</div>
    <div class="callout" style="border-left-color:var(--olive)"><b>Two different faction systems.</b> <b>Map control</b> (below) is a shared, server-wide tug-of-war over each map, shifted by sabotage and lasting hours. <b>Standing</b> (bottom) is your <em>personal</em> reputation with each army &mdash; how hostile they are to <em>you</em>.</div>
    <div class="fac-legend">${D.factions.map((f) => `<span class="fac-key"><span class="fac-dot" style="background:${FCOLOR[f.name] || "var(--dim)"}"></span>${esc(f.name)}</span>`).join("")}</div>`;

  html += `<div class="card" data-anchor="control"><div class="section" style="margin-top:0"><h3>Who controls each map <span class="c">starting split</span></h3></div>`;
  const maps = D.maps.filter((m) => match(m.name));
  if (!maps.length) html += `<p class="empty">No maps match &ldquo;${esc(state.q)}&rdquo;.</p>`;
  else maps.forEach((m) => { html += `<div class="fac-map" data-anchor="map-${esc(slugify(m.id || m.name))}"><div class="fac-map-name">${esc(m.name)}</div>${facBar(m.control)}</div>`; });
  html += `<p class="gnote">Each army starts with a share of every surface map; whoever holds more fields more units there. These are the <b>default</b> weights &mdash; live control drifts as the war (and players) push it. Hubs (${(D.hubs || []).map((h) => esc(h.name)).join(", ")}) are Scavenger-held.</p></div>`;

  html += `<div class="card" data-anchor="sabotage"><div class="section" style="margin-top:0"><h3>The sabotage playbook <span class="c">shift the war yourself</span></h3></div>
    <p class="gnote">Each is a droppable objective on its map. Pull it off and it ripples to <em>other</em> maps &mdash; server-wide, for the listed real-world hours &mdash; changing who you'll face there.</p>`;
  D.actions.filter((a) => match(a.name) || match(a.where) || (a.desc && match(a.desc))).forEach((a) => { html += facActionCard(a); });
  html += `</div>`;

  const rep = D.reputation;
  html += `<div class="card" data-anchor="standing"><div class="section" style="margin-top:0"><h3>Faction standing <span class="c">your personal rep</span></h3></div>
    <p class="gnote">${esc(rep.note)}</p>
    <div class="gtable-wrap"><table class="gtable"><thead><tr><th>Damage dealt to&hellip;</th><th class="num">Standing shift / HP</th></tr></thead>
      <tbody>${rep.perDamage.map((p) => `<tr><td>${esc(p.faction)}</td><td class="num">${p.perHp}</td></tr>`).join("")}</tbody></table></div>
    <div class="callout" style="border-left-color:var(--rust)"><b>Destroying a heavy: ${bNum(rep.bossKill)}.</b> ${esc(rep.bossKillNote)}</div></div>`;

  html += `<p class="legend">Method: decoded from <code>FW/TugOfWar/DT_*</code> (per-map faction splits, level actions + their percentage shifts) and <code>FactionAdjustmentsViaBattle</code> via CUE4Parse (build ${D.build}). Effect durations are the game's own real-world marker timers.</p></div>`;
  view.innerHTML = html;
}

/* ---------- economy / loot tab ---------- */
let ECO = null;
const TIER_COLOR = {
  junk: "var(--dim)", cheap: "var(--muted)", worth: "var(--blue)", good: "var(--olive)",
  valuable: "var(--olive)", prime: "var(--gold)", jackpot: "var(--rust)",
};
const ecoCr = (n) => Number(n).toLocaleString();
const ecoCompact = (n) => (n >= 1e6 ? +(n / 1e6).toFixed(2) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : "" + n);
const ecoRange = (t) => {
  const c = (n) => (n >= 1000 ? n / 1000 + "k" : "" + n);
  return t.hi == null ? c(t.lo) + "+" : c(t.lo) + "–" + c(t.hi);
};

async function renderEconomy() {
  view.classList.remove("detail-open");
  if (!ECO) {
    view.innerHTML = `<div class="placeholder" style="margin-top:16px">Loading loot economy&hellip;</div>`;
    try { ECO = await (await fetch("data/economy.json", { cache: "no-cache" })).json(); }
    catch (e) { view.innerHTML = `<p class="empty">Could not load economy data.<br><small>${esc(e.message)}</small></p>`; return; }
    ECO.byKey = {}; ECO.tiers.forEach((t) => (ECO.byKey[t.key] = t));
  }
  drawEconomy();
}

function drawEconomy() {
  const D = ECO;
  const tiersDesc = D.tiers.slice().reverse(); // lead with the best loot (Jackpot → Junk)
  const items = D.items.filter((it) => (state.ecoCat === "all" || it.cat === state.ecoCat) && match(it.name));
  const dens = (v) => (v == null ? '<span class="dim">&mdash;</span>' : ecoCr(v));
  const catCell = (it) => `<button class="eco-cat" data-ecocat="${esc(it.cat)}">${esc(it.catLabel)}</button>`;

  let html = `<div class="guide eco">
    <div class="callout" style="margin-top:16px"><b>What your scavenging is worth.</b>
      Every lootable item you can sell, pulled <b>straight from the game's own data</b> and bucketed by
      credit value. Values are the game's Rep&nbsp;2 / 100%-efficiency reference, so read them as
      <em>relative</em> worth &mdash; your real payout shifts with vendor, reputation and faction. Where the
      game tags it, a <span class="eco-loc">Tunnels</span> / <span class="eco-loc">Regions</span> mark shows
      which map-type it spawns in.</div>`;

  // distribution strip
  const maxC = Math.max(...D.tiers.map((t) => t.count));
  html += `<div class="card" data-anchor="overview"><div class="section" style="margin-top:0"><h3>The loot economy at a glance <span class="c">${D.count} sellable items</span></h3></div>
    <div class="eco-strip">`;
  tiersDesc.forEach((t) => {
    const w = Math.max(3, Math.round((t.count / maxC) * 100));
    html += `<button class="eco-tierbar" data-ecotier="${t.key}" title="Jump to ${esc(t.label)}">
      <span class="eco-tname">${esc(t.label)} <small>${ecoRange(t)}</small></span>
      <span class="eco-tbarwrap"><span class="eco-tbar" style="width:${w}%;background:${TIER_COLOR[t.key]}"></span></span>
      <span class="eco-tmeta">${t.count} <small>&middot; ${ecoCompact(t.sumCr)} cr</small></span></button>`;
  });
  html += `</div>
    <p class="gnote">How many sellable items land in each value band. Tap one to jump to it &mdash; a single
    high-tier find can outweigh a full bin of junk.</p></div>`;

  // controls: mode toggle + category filter
  html += `<div class="eco-controls"><div class="eco-modes">
      <button data-ecomode="tiers" class="${state.ecoMode === "tiers" ? "on" : ""}">Value tiers</button>
      <button data-ecomode="density" class="${state.ecoMode === "density" ? "on" : ""}">Space-efficiency</button>
    </div></div>
    <div class="chips eco-cats">
      <button class="chip ${state.ecoCat === "all" ? "on" : ""}" data-ecocat="all">All <small>${D.count}</small></button>`;
  D.categories.forEach((c) => {
    html += `<button class="chip ${state.ecoCat === c.key ? "on" : ""}" data-ecocat="${esc(c.key)}">${esc(c.label)} <small>${c.count}</small></button>`;
  });
  html += `</div>`;

  if (!items.length) {
    html += `<p class="empty">No loot matches ${state.q ? `&ldquo;${esc(state.q)}&rdquo;` : "this filter"}.</p></div>`;
    view.innerHTML = html; return;
  }

  html += state.ecoMode === "density" ? ecoDensityTable(items, catCell, dens) : ecoTierSections(items, tiersDesc, catCell, dens);

  html += `<p class="legend">Source: read straight from the game's <b>current</b> item &amp; value tables (its in-game &ldquo;EconV2&rdquo; economy)${D.build ? `, decoded from build ${D.build}` : ""}.
    Credits = raw value &divide; ${D.divisor.toFixed(2)} (the game's Rep&nbsp;2 / 100% cost-efficiency reference). Accurate to this build &mdash; values shift with patches.</p></div>`;
  view.innerHTML = html;
}

function ecoRow(it, catCell, dens, withTier) {
  const tierBadge = withTier ? `<td><span class="eco-tier" style="--tc:${TIER_COLOR[it.tier]}">${esc(ECO.byKey[it.tier].label)}</span></td>` : "";
  const q = it.quest ? ` <span class="eco-q" title="Quest item">&#10022;</span>` : "";
  const loc = it.loc ? ` <span class="eco-loc" title="Spawns in ${esc(it.loc)}">${esc(it.loc === "Tunnels & Regions" ? "Both" : it.loc)}</span>` : "";
  return `<tr><td>${esc(it.name)}${q}${loc}</td>${tierBadge}<td>${catCell(it)}</td>
    <td class="num gold">${ecoCr(it.cr)}</td><td class="num">${dens(it.perVol)}</td><td class="num">${dens(it.perWgt)}</td></tr>`;
}

function ecoTierSections(items, tiers, catCell, dens) {
  // Collapsed by default (the strip is the summary); filtering/searching expands
  // every matching tier since the result set is then small. Jackpot always leads open.
  const expandAll = state.ecoCat !== "all" || !!state.q;
  let html = "";
  tiers.forEach((t) => {
    const grp = items.filter((it) => it.tier === t.key);
    if (!grp.length) return;
    const sum = grp.reduce((a, it) => a + it.cr, 0);
    const open = expandAll || t.key === "jackpot";
    html += `<details class="eco-det" id="eco-tier-${t.key}" data-anchor="tier-${t.key}"${open ? " open" : ""}>
      <summary class="eco-sum"><span class="eco-dot" style="background:${TIER_COLOR[t.key]}"></span>
        <span class="eco-sum-name">${esc(t.label)}</span>
        <span class="c">${ecoRange(t)} cr &middot; ${grp.length} item${grp.length === 1 ? "" : "s"} &middot; ${ecoCompact(sum)} cr total</span></summary>
      <div class="gtable-wrap"><table class="gtable eco-table">
        <thead><tr><th>Item</th><th>Category</th><th class="num">Value</th><th class="num">cr / cu</th><th class="num">cr / kg</th></tr></thead>
        <tbody>${grp.map((it) => ecoRow(it, catCell, dens, false)).join("")}</tbody>
      </table></div></details>`;
  });
  return html;
}

function ecoDensityTable(items, catCell, dens) {
  const ranked = items.slice().sort((a, b) => {
    if ((a.perVol == null) !== (b.perVol == null)) return a.perVol == null ? 1 : -1;
    return (b.perVol || 0) - (a.perVol || 0);
  });
  return `<div class="section eco-sec" data-anchor="density"><h3>By space-efficiency <span class="c">${ranked.length} items &middot; credits per unit of bin volume</span></h3></div>
    <p class="gnote">Rig space is the real constraint. When your small-item bins are nearly full, grab the <b>densest</b> loot first &mdash;
    the top of this list is the most credits per cubic unit. Destroyed weapons and Large items use dedicated bins (no small-item volume),
    so they sink to the bottom.</p>
    <div class="gtable-wrap"><table class="gtable eco-table">
      <thead><tr><th>Item</th><th>Tier</th><th>Category</th><th class="num">Value</th><th class="num">cr / cu</th><th class="num">cr / kg</th></tr></thead>
      <tbody>${ranked.map((it) => ecoRow(it, catCell, dens, true)).join("")}</tbody>
    </table></div>`;
}

/* ---------- drops / loot-source tab ---------- */
let LOOT = null;
let DROPMODEL = null;
const RAR_COLOR = { 5: "var(--muted)", 4: "var(--blue)", 3: "var(--olive)", 2: "var(--gold)", 1: "var(--rust)" };

async function renderLoot() {
  view.classList.remove("detail-open");
  if (!LOOT) {
    view.innerHTML = `<div class="placeholder" style="margin-top:16px">Loading loot sources&hellip;</div>`;
    try { LOOT = await (await fetch("data/loot.json", { cache: "no-cache" })).json(); }
    catch (e) { view.innerHTML = `<p class="empty">Could not load loot data.<br><small>${esc(e.message)}</small></p>`; return; }
    LOOT.kindLabel = {}; LOOT.kinds.forEach((k) => (LOOT.kindLabel[k.key] = k.label));
  }
  if (!DROPMODEL) {
    // the "How drops work" panel is a nicety — if it can't load, the source index still renders.
    try { DROPMODEL = await (await fetch("data/drops-model.json", { cache: "no-cache" })).json(); }
    catch (e) { DROPMODEL = { _err: true }; }
  }
  drawLoot();
}

// Context-first "How drops work" panel (Drops tab): the placement/tier/contents model,
// the crate-type taxonomy, quest spawn rates and the other drop sources. Curated from
// data/drops-model.json (regen: forever-winter-datamine/tools/parse_crate_types.py).
function dropModelPanel() {
  const D = DROPMODEL;
  if (!D || D._err) return "";
  const b = D.tierBudget || {};
  const kcr = (n) => (n >= 1000 ? n / 1000 + "k" : String(n));

  const layers = (D.model || []).map((m, i) => `
    <div class="dm-layer">
      <div class="dm-num">${i + 1}</div>
      <div class="dm-layer-body"><h4>${esc(m.title)}</h4>
        <p class="dm-lead">${mdb(m.lead)}</p>
        <p class="dm-detail">${mdb(m.body)}</p></div>
    </div>`).join("");

  const tiers = ["T1", "T2", "T3", "T4"].filter((t) => b[t] != null);
  const budgetStrip = `<div class="dm-budget" data-anchor="tier-budget">
    <span class="dm-budget-label">Tier&nbsp;=&nbsp;credit budget</span>
    <span class="dm-budget-scale">${tiers.map((t) => `<span class="dm-b"><b>${t}</b> ${kcr(b[t])}</span>`).join('<span class="dm-arrow">&rarr;</span>')}</span>
  </div>`;

  const typeRow = (c) => {
    const name = c.file === "gear"
      ? `<button class="dm-type" data-gotab="${esc(c.tab)}">${esc(c.type)}</button> <button class="dm-gear" data-gotab="${esc(c.tab)}">${esc(c.tab)} tab &rarr;</button>`
      : `<button class="dm-type" data-gosrc="${esc(c.source)}">${esc(c.type)}</button>`;
    return `<tr><td>${name}</td><td class="num">${c.cap}</td><td class="num">${c.pool}</td>
      <td class="dm-inside">${mdb(c.inside)}</td></tr>`;
  };
  const typeTable = `<details class="loot-src dm-det" data-anchor="crate-types" open>
    <summary class="loot-sum"><span class="loot-src-name">Crate types &mdash; what each is &amp; holds</span>
      <span class="c">${(D.crateTypes || []).length} types</span></summary>
    <div class="gtable-wrap"><table class="gtable dm-type-table">
      <thead><tr><th>Type</th><th class="num">Cap</th><th class="num">Pool</th><th>What&rsquo;s inside</th></tr></thead>
      <tbody>${(D.crateTypes || []).map(typeRow).join("")}</tbody></table></div>
    <p class="gnote">Every tier of a type shares one pool; the tier only sets the budget it fills toward. <b>Cap</b> = most items it can hold &middot; <b>Pool</b> = distinct items it can draw.</p></details>`;

  const pctVar = (c) => (c >= 1 ? "--olive" : c >= 0.6 ? "--gold" : "--rust");
  const spawnRow = (q) => `<tr><td>${esc(q.spawner)}</td>
    <td class="num"><b class="dm-pct" style="color:var(${pctVar(q.chance)})">${Math.round(q.chance * 100)}%</b></td>
    <td class="dm-inside">${esc(q.note || "")}</td></tr>`;
  const spawnTable = `<details class="loot-src dm-det" data-anchor="spawn-rates">
    <summary class="loot-sum"><span class="loot-src-name">Quest-crate spawn rates</span>
      <span class="c">the only real spawn roll</span></summary>
    <p class="gnote dm-gnote">${mdb(D.questSpawnNote || "")}</p>
    <div class="gtable-wrap"><table class="gtable">
      <thead><tr><th>Spawner</th><th class="num">Chance</th><th>Notes</th></tr></thead>
      <tbody>${(D.questSpawn || []).map(spawnRow).join("")}</tbody></table></div></details>`;

  const specialList = `<details class="loot-src dm-det" data-anchor="other-drops">
    <summary class="loot-sum"><span class="loot-src-name">Other drop sources</span>
      <span class="c">${(D.special || []).length}</span></summary>
    <div class="dm-special">${(D.special || []).map((s) =>
      `<div class="dm-sp"><b>${esc(s.name)}.</b> ${mdb(s.body)}${s.goto ? ` <button class="dm-type" data-gotab="${esc(s.goto)}">${esc(s.goto)} tab &rarr;</button>` : ""}</div>`).join("")}</div></details>`;

  return `<section class="dropmodel" data-anchor="how-it-works">
    <div class="section dm-head"><h3>How drops work</h3></div>
    <p class="dm-tldr">${mdb(D.tldr || "")}</p>
    <div class="dm-layers">${layers}</div>
    ${budgetStrip}${typeTable}${spawnTable}${specialList}
  </section>`;
}

const lootVal = (it) => (it.cr != null ? `<span class="gold">${ecoCr(it.cr)}</span>` : `<span class="dim">&mdash;</span>`);
const lootItemCell = (it) => `<td><button class="loot-item" data-goeco="${esc(it.name)}" title="See value &amp; details on the Economy tab">${esc(it.name)}</button></td>`;

// single-rarity row (non-tiered sources)
function lootRow(it) {
  return `<tr>${lootItemCell(it)}
    <td><span class="loot-rar" style="--rc:${RAR_COLOR[it.rarity]}"><span class="loot-dot"></span>${esc(it.rarityLabel)}</span></td>
    <td class="num">${it.share}%</td>
    <td class="num">${lootVal(it)}</td></tr>`;
}

// one tier's dot: filled + coloured if present, hollow if the item can't spawn in that tier
function lootDot(it, t) {
  const b = it.byTier && it.byTier[t];
  if (!b) return `<span class="loot-tdot gap" title="${t}: not in this tier"></span>`;
  return `<span class="loot-tdot" style="--rc:${RAR_COLOR[b.r]}" title="${t}: ${esc(LOOT.rarityLabels[b.r] || "")} · ${b.s}% of pool"></span>`;
}
// tiered row (crate categories): a rarity dot per tier, showing the T1→T4 progression
function lootRowTiered(it, tiers) {
  return `<tr>${lootItemCell(it)}${tiers.map((t) => `<td class="tc">${lootDot(it, t)}</td>`).join("")}
    <td class="num">${lootVal(it)}</td></tr>`;
}

// If this source is one of the datamined crate types, pull its budget/cap from the
// drops-model so the "tier = credit budget" mechanic shows right where you read contents.
function crateTypeFor(key) {
  return DROPMODEL && !DROPMODEL._err && (DROPMODEL.crateTypes || []).find((c) => c.source === key);
}
const fmtK = (n) => (n >= 1000 ? n / 1000 + "k" : String(n));

function lootCard(s, items, open) {
  const tierBadge = s.tiers && s.tiers.length ? ` <span class="badge">${s.tiers.join(" · ")}</span>` : "";
  let head, rows;
  if (s.tiered && s.tiers.length) {
    head = `<tr><th>Item</th>${s.tiers.map((t) => `<th class="tc">${t}</th>`).join("")}<th class="num">Value</th></tr>`;
    rows = items.map((it) => lootRowTiered(it, s.tiers)).join("");
  } else {
    head = `<tr><th>Item</th><th>Rarity</th><th class="num">Pool share</th><th class="num">Value</th></tr>`;
    rows = items.map(lootRow).join("");
  }
  const ct = crateTypeFor(s.key), tb = DROPMODEL && DROPMODEL.tierBudget;
  const budgetNote = ct && tb ? `<p class="gnote loot-budgetnote">Fills toward a credit budget &mdash; <b>T1 ${fmtK(tb.T1)} &rarr; T4 ${fmtK(tb.T4)}</b> &mdash; and holds at most <b>${ct.cap} items</b> per open. <button class="linklike" data-gosrc-model>How tiers work &rarr;</button></p>` : "";
  return `<details class="loot-src" id="loot-src-${esc(s.key)}" data-anchor="${esc(s.key)}"${open ? " open" : ""}>
    <summary class="loot-sum"><span class="loot-src-name">${esc(s.label)}</span>${tierBadge}
      <span class="c">${items.length} item${items.length === 1 ? "" : "s"}</span></summary>
    ${budgetNote}<div class="gtable-wrap"><table class="gtable loot-table${s.tiered ? " loot-tiered" : ""}">
      <thead>${head}</thead><tbody>${rows}</tbody></table></div></details>`;
}

function drawLoot() {
  const D = LOOT;
  const q = state.q;
  let html = `<div class="guide">`;
  // The "How drops work" model leads the tab; hidden during a search so results stay focused.
  if (!q) html += dropModelPanel() +
    `<div class="section dm-sources-head" data-anchor="sources"><h3>Loot sources <span class="c">what drops from where, ranked by how common</span></h3></div>`;
  html += `<p class="gnote">Rarity is <b>per pool</b>: cheap filler like Drywall can read <span style="color:var(--rust)">Ultra&nbsp;Rare</span> just because it's an unlikely pull &mdash; not because it's a prize. Search an item to see <b>every</b> source that drops it.</p>
    <div class="loot-legend"><span class="c">Rarity</span>${[5, 4, 3, 2, 1].map((r) => `<span class="loot-key"><span class="loot-dot" style="--rc:${RAR_COLOR[r]}"></span>${esc(D.rarityLabels[r])}</span>`).join("")}<span class="loot-key"><span class="loot-tdot gap"></span>not in tier</span></div>`;

  // kind filter chips
  const kinds = D.kinds.filter((k) => D.sources.some((s) => s.kind === k.key));
  html += `<div class="chips loot-kinds">
    <button class="chip ${state.lootKind === "all" ? "on" : ""}" data-lootkind="all">All <small>${D.sources.length}</small></button>`;
  kinds.forEach((k) => {
    const n = D.sources.filter((s) => s.kind === k.key).length;
    html += `<button class="chip ${state.lootKind === k.key ? "on" : ""}" data-lootkind="${esc(k.key)}">${esc(k.label)} <small>${n}</small></button>`;
  });
  html += `</div>`;

  // sources, grouped by kind (D.sources is pre-sorted by kind order)
  const pool = D.sources.filter((s) => state.lootKind === "all" || s.kind === state.lootKind);
  let body = "", curKind = null, shown = 0;
  pool.forEach((s) => {
    const labelHit = match(s.label);
    const items = q && !labelHit ? s.items.filter((it) => match(it.name)) : s.items;
    if (q && !labelHit && !items.length) return;
    shown++;
    if (s.kind !== curKind) {
      curKind = s.kind;
      const n = pool.filter((x) => x.kind === s.kind).length;
      body += `<div class="section loot-kindhead" data-anchor="kind-${esc(s.kind)}"><h3>${esc(D.kindLabel[s.kind])}${q ? "" : ` <span class="c">${n} source${n === 1 ? "" : "s"}</span>`}</h3></div>`;
    }
    body += lootCard(s, items, !!q);
  });

  if (!shown) html += `<p class="empty">No sources match ${q ? `&ldquo;${esc(state.q)}&rdquo;` : "this filter"}.</p>`;
  else html += body;

  html += `<p class="legend">Source: <code>RandomContainerLootData</code> + <code>DT_GachaLootTable</code> + <code>BP_RareLootManager</code>, decoded from build ${D.build}.
    Pool share = the item's weight in that source's loot table; real per-raid odds also depend on how many items a source rolls. ${D.count} sources.</p></div>`;
  view.innerHTML = html;
}

/* ---------- deep-link router (hash-based; static-host & offline safe) ----------
   URL shape:  #/<tab>[/<sub>][?q=&mode=&cat=&kind=&layers=&bg=]
   The "#/" prefix keeps us clear of the browser's native "scroll to #id" behaviour.
   The URL is the source of truth on load / hashchange (applyRoute); every in-app
   navigation mirrors state back into it (writeHash). Maps owns its own sub-route. */
const TAB_SLUG = { loot: "drops" };   // internal tab key -> pretty URL slug
const TAB_KEY = { drops: "loot", bosses: "enemies" };  // pretty URL slug -> internal tab key (bosses = legacy alias)
const VALID_TABS = ["weapons", "attachments", "muzzles", "ammo", "crafting", "stats", "detection", "enemies", "factions", "economy", "loot", "maps"];
const tabToSlug = (t) => TAB_SLUG[t] || t;
const slugToTab = (s) => TAB_KEY[s] || s;
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
function uniqueSlug(base, taken) { let s = base || "x", i = 2; while (Object.prototype.hasOwnProperty.call(taken, s)) s = (base || "x") + "-" + i++; return s; }

let routing = false; // true only while we programmatically write the hash (suppresses the echo)
const ANCHOR_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4v-2H7a5.1 5.1 0 1 0 0 10.2h4v-2H7A3.1 3.1 0 0 1 3.9 12Zm5.1 1h6v-2H9v2Zm8-6h-4v2h4a3.1 3.1 0 1 1 0 6.2h-4v2h4a5.1 5.1 0 0 0 0-10.2Z"/></svg>';

function parseHash() {
  let h = (location.hash || "").replace(/^#/, "").replace(/^\//, "");
  let qs = ""; const qi = h.indexOf("?");
  if (qi >= 0) { qs = h.slice(qi + 1); h = h.slice(0, qi); }
  const parts = h.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch (e) { return p; } });
  const query = {};
  qs.split("&").filter(Boolean).forEach((kv) => {
    const i = kv.indexOf("="); const k = i < 0 ? kv : kv.slice(0, i); const v = i < 0 ? "" : kv.slice(i + 1);
    try { query[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) { query[k] = v; }
  });
  return { tab: slugToTab(parts[0] || ""), sub: parts.slice(1).join("/"), query };
}

function writeHashRaw(hash, push) {
  if (location.hash === hash) return;
  routing = true;
  try { push ? history.pushState(null, "", hash) : history.replaceState(null, "", hash); }
  catch (e) { location.hash = hash; }
  routing = false;
}

// Serialise the current state into the hash. `opts.sub` sets an explicit
// sub-anchor; `opts.push` adds a history entry (used for tab / detail nav).
function writeHash(opts) {
  opts = opts || {};
  const t = state.tab;
  if (t === "maps") return; // the atlas writes its own #/maps/... route via FWMaps
  let path = "/" + tabToSlug(t);
  const detOpen = view.classList.contains("detail-open");
  if (t === "weapons" && state.weapon && detOpen && idx.slugByWeapon[state.weapon]) path += "/" + idx.slugByWeapon[state.weapon];
  else if (t === "attachments" && state.att && detOpen && idx.slugByAtt[state.att]) path += "/" + idx.slugByAtt[state.att];
  else if (opts.sub) path += "/" + opts.sub;
  const q = [];
  if (state.q) q.push("q=" + encodeURIComponent(state.q));
  if (t === "economy") { if (state.ecoMode === "density") q.push("mode=density"); if (state.ecoCat && state.ecoCat !== "all") q.push("cat=" + encodeURIComponent(state.ecoCat)); }
  if (t === "loot" && state.lootKind && state.lootKind !== "all") q.push("kind=" + encodeURIComponent(state.lootKind));
  if (t === "enemies" && state.enemyCat && state.enemyCat !== "all") q.push("cat=" + encodeURIComponent(state.enemyCat));
  writeHashRaw("#" + path + (q.length ? "?" + q.join("&") : ""), opts.push);
}

// The single reader: hash -> state -> render -> scroll. Runs on load & hashchange.
function applyRoute() {
  const r = parseHash();
  const tab = VALID_TABS.includes(r.tab) ? r.tab : "weapons";
  state.tab = tab;
  state.q = (r.query.q || "").trim().toLowerCase();
  if (r.query.mode) state.ecoMode = r.query.mode === "density" ? "density" : "tiers";
  if (r.query.cat) state.ecoCat = r.query.cat;
  if (r.query.kind) state.lootKind = r.query.kind;
  state.enemyCat = (tab === "enemies" && r.query.cat) ? r.query.cat : "all";
  state.weapon = null; state.att = null;
  let sub = r.sub || "";
  if (tab === "weapons" && sub && idx.weaponSlug[sub]) { state.weapon = idx.weaponSlug[sub]; sub = ""; }
  else if (tab === "attachments" && sub && idx.attSlug[sub]) { state.att = idx.attSlug[sub]; sub = ""; }
  if (tab === "economy") { if (sub === "density") state.ecoMode = "density"; else if (sub.indexOf("tier-") === 0) state.ecoMode = "tiers"; }
  syncTabs();
  const sb = $("#search"), clr = $("#searchClear");
  if (sb) { sb.value = state.q; if (clr) clr.hidden = !state.q; }

  if (tab === "maps") {
    activateMaps({ map: sub || null, layers: r.query.layers ? r.query.layers.split(",").filter(Boolean) : null, bg: (r.query.bg != null && r.query.bg !== "") ? +r.query.bg : null });
    return;
  }
  deactivateMaps();
  view.classList.toggle("detail-open", !!(state.weapon || state.att));
  // setTimeout (not rAF) so the scroll still runs if the tab is backgrounded
  // when a deep-link lands (rAF is paused in non-visible tabs).
  Promise.resolve(render()).then(() => { if (sub) setTimeout(() => scrollToAnchor(sub), 0); });
}

function scrollToAnchor(sub) {
  if (!sub) return;
  let el;
  try { el = view.querySelector('[data-anchor="' + ((window.CSS && CSS.escape) ? CSS.escape(sub) : sub) + '"]'); } catch (e) { el = null; }
  if (!el) return;
  const det = el.closest("details"); if (det) det.open = true;
  if (el.tagName === "DETAILS") el.open = true;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// After each render, inject a copy-link icon into every [data-anchor] section head.
function decorateAnchors() {
  view.querySelectorAll("[data-anchor]").forEach((box) => {
    const head = box.matches("summary") ? box : box.querySelector("summary, .dhead, .ammo-head, .fac-map-name, .fac-action-head, h2, h3");
    if (!head || head.querySelector(":scope > .anchor-link")) return;
    const b = document.createElement("button");
    b.type = "button"; b.className = "anchor-link"; b.dataset.copy = box.getAttribute("data-anchor");
    b.title = "Copy link to this section"; b.setAttribute("aria-label", "Copy link to this section");
    b.innerHTML = ANCHOR_ICON;
    head.appendChild(b);
  });
}

function copySectionLink(sub) {
  const hash = "#/" + tabToSlug(state.tab) + (sub ? "/" + sub : "");
  const url = location.origin + location.pathname + hash;
  copyText(url).then((ok) => { writeHashRaw(hash); toast(ok ? "Link copied" : "Copy this link: " + url); });
}

// clipboard with a legacy fallback (navigator.clipboard is undefined on http/file://)
async function copyText(t) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(t); return true; } } catch (e) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = t; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  } catch (e) { return false; }
}

let toastTimer = null;
function toast(msg) {
  let t = document.getElementById("fw-toast");
  if (!t) { t = document.createElement("div"); t.id = "fw-toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 1900);
}

/* ---------- PWA plumbing ---------- */
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredPrompt = e;
  const b = $("#installBtn"); b.hidden = false;
  b.onclick = async () => { b.hidden = true; deferredPrompt.prompt(); deferredPrompt = null; };
});
window.addEventListener("appinstalled", () => ($("#installBtn").hidden = true));
function registerSW() {
  // Skip on localhost so cache-first serving doesn't shadow live dev edits.
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  if ("serviceWorker" in navigator && !local) navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Defer boot until maps.js has defined window.FWMaps (it loads after app.js), so a
// cold #/maps/<id> deep-link can hand off to the atlas immediately.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
