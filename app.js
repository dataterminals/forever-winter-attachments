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
const state = { tab: "weapons", weapon: null, att: null, q: "", layout: "split", ecoMode: "tiers", ecoCat: "all" };
const idx = { attById: {}, weaponByName: {}, weaponSubtype: {}, subtypes: {} };

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
  try { const s = localStorage.getItem("fw:wlayout"); if (["list", "grid", "split"].includes(s)) state.layout = s; } catch (e) {}
  try { const m = localStorage.getItem("fw:ecomode"); if (["tiers", "density"].includes(m)) state.ecoMode = m; } catch (e) {}
  applyLayout();
  buildIndex();
  wireChrome();
  render();
  registerSW();
}

function buildIndex() {
  DATA.attachments.forEach((a) => (idx.attById[a.id] = a));
  DATA.weapons.forEach((w) => (idx.weaponByName[w.name] = w));
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

/* ---------- chrome / events ---------- */
function wireChrome() {
  document.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab;
      view.classList.remove("detail-open");
      syncTabs();
      if (state.tab === "maps") activateMaps();
      else { deactivateMaps(); render(); }
      window.scrollTo({ top: 0 });
    })
  );
  const s = $("#search"), clr = $("#searchClear");
  s.addEventListener("input", () => {
    state.q = s.value.trim().toLowerCase();
    clr.hidden = !s.value;
    view.classList.remove("detail-open");
    render();
  });
  clr.addEventListener("click", () => { s.value = ""; state.q = ""; clr.hidden = true; s.focus(); render(); });

  view.addEventListener("click", (e) => {
    const gear = e.target.closest("[data-gear]");
    if (gear) { e.stopPropagation(); gear.closest(".layoutpick").classList.toggle("open"); return; }
    const lay = e.target.closest("[data-layout]");
    if (lay) { setLayout(lay.dataset.layout); return; }
    const em = e.target.closest("[data-ecomode]");
    if (em) { setEcoMode(em.dataset.ecomode); return; }
    const ec = e.target.closest("[data-ecocat]");
    if (ec) { state.ecoCat = ec.dataset.ecocat; render(); return; }
    const et = e.target.closest("[data-ecotier]");
    if (et) {
      if (state.ecoMode !== "tiers") setEcoMode("tiers");
      const sec = document.getElementById("eco-tier-" + et.dataset.ecotier);
      if (sec) { sec.open = true; sec.scrollIntoView({ behavior: "smooth", block: "start" }); }
      return;
    }
    const bj = e.target.closest("[data-bossjump]");
    if (bj) { const sec = document.getElementById("boss-" + bj.dataset.bossjump); if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const goAI = e.target.closest("[data-goai]");
    if (goAI) {
      state.tab = "detection"; syncTabs(); deactivateMaps(); view.classList.remove("detail-open");
      window.scrollTo({ top: 0 });
      renderDetection().then(() => { const s = document.getElementById("det-priority"); if (s) s.scrollIntoView({ behavior: "smooth", block: "start" }); });
      return;
    }
    const goHS = e.target.closest("[data-gohs]");
    if (goHS) {
      state.tab = "ammo"; syncTabs(); deactivateMaps(); view.classList.remove("detail-open");
      const sb = $("#search"), clr = $("#searchClear");
      if (sb) sb.value = ""; if (clr) clr.hidden = true; state.q = ""; // "all calibers" => clear any filter
      render();
      requestAnimationFrame(() => { const s = document.getElementById("ammo-headshots"); if (s) s.scrollIntoView({ behavior: "smooth", block: "start" }); });
      return;
    }
    const el = e.target.closest("[data-weapon],[data-att],[data-goatt],[data-goweapon],[data-back]");
    if (!el) return;
    if (el.dataset.back !== undefined) { view.classList.remove("detail-open"); render(); return; }
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
function openDetail() { view.classList.add("detail-open"); render(); window.scrollTo({ top: 0 }); }

/* ---------- maps tab: lazy Leaflet + hand off to the FWMaps module ---------- */
let mapsBooted = false, leafletPromise = null;

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

async function activateMaps() {
  document.body.classList.add("maps-active");
  positionMaps();
  try {
    await ensureLeaflet();
    if (!mapsBooted) { await window.FWMaps.init(); mapsBooted = true; } // guard AFTER success so a failed first boot stays retryable
    window.FWMaps.invalidateSize();
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
function render() {
  if (state.tab === "maps") return; // the Maps tab is driven by activateMaps(), not #view
  if (state.tab === "weapons") renderWeapons();
  else if (state.tab === "attachments") renderAttachments();
  else if (state.tab === "muzzles") renderMuzzles();
  else if (state.tab === "ammo") renderAmmo();
  else if (state.tab === "stats") renderStats();
  else if (state.tab === "detection") renderDetection();
  else if (state.tab === "bosses") renderBosses();
  else if (state.tab === "factions") renderFactions();
  else renderEconomy();
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
      list += `<button class="row ${state.weapon === w.name ? "sel" : ""}" data-weapon="${esc(w.name)}">
        <span class="rname">${esc(w.name)}</span>
        <span class="rmeta"><span class="count">${w.total}</span></span></button>`;
    });
  });
  if (!list) list = `<p class="empty">No weapons match &ldquo;${esc(state.q)}&rdquo;.</p>`;

  const detail = state.weapon && idx.weaponByName[state.weapon]
    ? weaponDetail(idx.weaponByName[state.weapon])
    : `<div class="placeholder">Pick a weapon to see everything that fits it.</div>`;
  view.innerHTML = layoutBar(DATA.weapons.length, "weapons") + `<div class="panes"><div class="list">${list}</div><div class="detail">${detail}</div></div>`;
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
  let html = `<button class="backbtn" data-back>&larr; all weapons</button><div class="card">
    <div class="dhead"><h2>${esc(w.name)}</h2><span class="badge gold">${esc(w.class)}</span>
      <span class="badge">${w.total} attachments</span></div>`;
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
        const full = [(p.name && p.name !== label) ? p.name : "", tip].filter(Boolean).join(" — ");
        html += `<span class="chip part"${full ? ` tabindex="0" role="note" aria-label="${esc(label + ": " + full)}"` : ""}>${esc(label)}${lvl}${cap}${full ? `<span class="tip">${esc(full)}</span>` : ""}</span>`;
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
      list += `<button class="row ${state.att === a.id ? "sel" : ""}" data-att="${esc(a.id)}">
        <span class="rname">${esc(a.name)}</span>
        <span class="rmeta"><span class="count">${a.compatible.length}</span></span></button>`;
    });
  });
  if (!list) list = `<p class="empty">No attachments match &ldquo;${esc(state.q)}&rdquo;.</p>`;
  const detail = state.att && idx.attById[state.att]
    ? attDetail(idx.attById[state.att])
    : `<div class="placeholder">Pick an attachment to see which weapons it fits.</div>`;
  view.innerHTML = layoutBar(DATA.attachments.length, "attachments") + `<div class="panes"><div class="list list-att">${list}</div><div class="detail">${detail}</div></div>`;
}

function attDetail(a) {
  let html = `<button class="backbtn" data-back>&larr; all attachments</button><div class="card">
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
    html += `<div class="mzcard"><h3>${st}</h3><div class="fam">${esc(SUBTYPE_LABEL[st] || "")}</div>
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

    <div class="card">
      <div class="section" style="margin-top:0"><h3>The only two stats that visibly matter</h3></div>
      <div class="gdef"><span class="term">Accuracy</span><span>How tightly your shots land. At ~90 accuracy a gun puts rounds dead-centre (hip-fire <em>or</em> aimed); lower accuracy widens a random spread cone. This is the single handling number worth chasing, and it's the one attachments meaningfully raise.</span></div>
      <div class="gdef"><span class="term">Magazine capacity</span><span>Rounds per reload. Obvious, and real. Note: mag size is changed by <b>weapon parts</b> (different magazines), <b>not</b> by attachments.</span></div>
    </div>

    <div class="card">
      <div class="section" style="margin-top:0"><h3>Stats that are display-only, buggy, or disputed</h3></div>
      <div class="gdef"><span class="term">Recoil</span><span>Shown as a single number but it's a <b>compound</b> of hidden values ("wrist" + "arm" recoil). It's theorised to drive <em>camera shake</em> only — it does <b>not</b> move your point of aim under fire. The wild numbers you see when swapping parts are aggregation errors, not real changes.</span></div>
      <div class="gdef"><span class="term">Stability</span><span><b>Real, and higher is better.</b> Decoded from the game data: Stability feeds the <b>bullet-spread (dispersion)</b> system — <b>higher Stability = tighter sustained fire</b> — and never touches the recoil kick. This overturns the old "keep it low" advice. Numbers in <a href="#underhood">Under the hood</a>, just below.</span></div>
      <div class="gdef"><span class="term">The stat card as a whole</span><span>It aggregates several parameters into display values and is frequently wrong when a weapon is modified. Trust behaviour in the shooting range over the card.</span></div>
    </div>

    <div class="card" id="underhood">
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

    <div class="card">
      <div class="section" style="margin-top:0"><h3>Damage (the hidden part)</h3></div>
      <div class="gdef"><span class="term">Base damage</span><span>Tied to the weapon (balanced around caliber/type), <b>not</b> to which ammo you load. The card often <b>under-reports</b> real damage — e.g. the AT-43 MASS deals roughly double what it lists, and shotguns and Painless read low too. Don't dismiss a gun by its listed damage alone.</span></div>
      <div class="gdef"><span class="term">Critical / headshot damage</span><span>A per-<b>caliber</b> multiplier that lives on your <b>ammo</b>, not the gun &mdash; a head hit multiplies the weapon's listed damage by it. Most rounds sit at the <b>1.5×</b> baseline, but a few big single-shot calibers <b>triple</b> it and <b>shotguns are penalised</b>, so a lower-damage, high-crit caliber can out-perform a bigger gun on consistent headshots. Some enemies (notably melee cyborgs) also have headshot <em>resistance</em>. <button class="linklike" data-gohs>See the full per-caliber table on the <b>Ammo</b> tab &rarr;</button></span></div>
    </div>
    </div>

    <div class="card">
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

    <div class="card">
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
  return `<div class="ammo-card">
    <div class="ammo-head"><span class="ammo-name">${esc(a.name)}</span>
      ${a.faction ? `<span class="badge">${esc(a.faction)}</span>` : ""}</div>
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

  let html = `<div class="guide">
    <div class="callout" style="margin-top:16px"><b>Every round in the game.</b> ${esc(D.note)}</div>`;

  // headshot-at-a-glance table (the datamined per-caliber multipliers, moved here
  // from Stats). It's a reference chart, so it's shown only when not searching.
  if (!state.q) {
    const hsRows = D.ammo.filter((a) => a.headshot != null).slice()
      .sort((x, y) => y.headshot - x.headshot || x.name.localeCompare(y.name));
    html += `<div class="card" id="ammo-headshots"><div class="section" style="margin-top:0"><h3>Headshot multipliers <span class="c">per caliber &middot; ${base}&times; baseline</span></h3></div>
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
    sections += `<div class="card"><div class="section" style="margin-top:0"><h3>${esc(c.label)} <span class="c">&times;${list.length}</span></h3></div>
      <p class="gnote">${esc(c.note)}</p>
      ${list.map((a) => ammoCard(a, usedBy)).join("")}</div>`;
  });
  if (!sections && state.q) html += `<p class="empty">No ammo matches &ldquo;${esc(state.q)}&rdquo;.</p>`;
  else html += sections;

  html += `<p class="legend">Method: merged from <code>ItemDetailsData</code> (names, blurbs, weight/volume), <code>ValueV2_AMMO</code> (sell value + extraction XP) and <code>DT_CaliberToHeadshotMulti</code> via CUE4Parse (build ${D.build}). Which weapons fire each round is cross-referenced live against the Weapons list; the &ldquo;used by&rdquo; chips open the weapon.</p></div>`;
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

    <div class="card">
      <div class="section" style="margin-top:0"><h3>The six ways they sense you</h3></div>
      ${D.senses.map((s) => `<div class="gdef"><span class="term">${esc(s.name)}</span><span>${esc(s.desc)}</span></div>`).join("")}
    </div>

    <div class="card">
      <div class="section" style="margin-top:0"><h3>Per-enemy senses <span class="c">hover a row for tactics</span></h3></div>
      <div class="gtable-wrap"><table class="gtable">
        <thead><tr><th>Enemy</th><th>Vision (near→far)</th><th>Cone</th><th>Hearing</th><th>ESP</th></tr></thead>
        <tbody>${D.enemies.map(erow).join("")}</tbody>
      </table></div>
      <p class="gnote">Vision is a line-of-sight cone; you build detection faster up close (near range) than at the edge (far range). ESP ignores walls. "∞" = effectively omniscient at range (turrets, Hunter-Killers).</p>
    </div>

    ${D.hunterKillers ? `<div class="card" id="hunterkillers">
      <div class="section" style="margin-top:0"><h3>Hunter-Killers: how you summon them <span class="badge gold">datamined</span></h3></div>
      <p class="gnote">${esc(D.hunterKillers.intro)}</p>
      <div class="section"><h3 style="color:var(--rust)">Any one of these trips it</h3></div>
      ${D.hunterKillers.triggers.map((t) => `<div class="gdef"><span class="term">${esc(t.label)}</span><span>${esc(t.detail)}</span></div>`).join("")}
      <div class="section"><h3>What happens when it trips</h3></div>
      ${D.hunterKillers.behavior.map((b) => `<div class="gdef"><span class="term">${esc(b.k)}</span><span>${esc(b.v)}</span></div>`).join("")}
      <div class="callout" style="border-left-color:var(--rust)"><b>Quest link.</b> ${esc(D.hunterKillers.questNote)}</div>
      <p class="gnote">${esc(D.hunterKillers.escalation)}</p>
    </div>` : ""}

    <div class="card">
      <div class="section" style="margin-top:0"><h3>What makes <em>you</em> visible</h3></div>
      <div class="gtable-wrap"><table class="gtable">
        <thead><tr><th>Factor</th><th>Effect</th><th>What it does</th></tr></thead>
        <tbody>${D.modifiers.map(mrow).join("")}</tbody>
      </table></div>
      <p class="gnote">${esc(D.note)}</p>
    </div>

    <div class="card">
      <div class="section" style="margin-top:0"><h3>Noise you make (audible radius)</h3></div>
      <div class="noise-list">${D.noise.map(nrow).join("")}</div>
      <p class="gnote">Crouch-moving emits <b>no</b> noise event at all. Sprinting is ~3× louder than walking; a single gunshot is heard 75–100 m away.</p>
    </div>

    <div class="card">
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

    ${D.targetPriority ? `<div class="card" id="det-priority">
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

/* ---------- bosses tab ---------- */
let BOSSDATA = null;
const bNum = (n) => Number(n).toLocaleString();
const mdb = (s) => esc(s == null ? "" : String(s)).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
const CAL_LABEL = { "545": "5.45mm", "556": "5.56mm", "762": "7.62mm", "919": "9mm", "308": ".308", "40m": "40mm", "12G": "12ga" };

async function renderBosses() {
  view.classList.remove("detail-open");
  if (!BOSSDATA) {
    view.innerHTML = `<div class="placeholder" style="margin-top:16px">Loading boss intel&hellip;</div>`;
    try { BOSSDATA = await (await fetch("data/bosses.json", { cache: "no-cache" })).json(); }
    catch (e) { view.innerHTML = `<p class="empty">Could not load boss data.<br><small>${esc(e.message)}</small></p>`; return; }
  }
  drawBosses();
}

function bossStaggerVal(s) {
  if (!s) return "&mdash;";
  if (s.damage >= 99999) return `${bNum(s.damage)} <span class="dim">&middot; ≈immune</span>`;
  return `${bNum(s.damage)}${s.window ? ` <span class="dim">in ${s.window}s</span>` : ""}`;
}
function bossGrabVal(g) {
  if (!g || !g.vsPlayer) return null;
  if (g.hpAlways) return `<b>Any</b> health &middot; ${g.rangeM} m`;
  return `&le; ${bNum(g.hpThreshold)} HP &middot; ${g.rangeM} m`;
}

function bossCard(b) {
  let h = `<div class="card boss" id="boss-${esc(b.id)}">
    <div class="dhead"><h2>${esc(b.name)}</h2>
      <span class="badge gold">${esc(b.faction)}</span>
      <span class="badge olive">${esc(b.type)}</span>
      ${b.aka ? `<span class="badge">${esc(b.aka)}</span>` : ""}
      ${b.threat ? `<button class="badge boss-threat" data-goai title="The enemy AI's internal target-priority tier for this unit — an input to how squads pick who to shoot, not a danger rating. Click for how it works.">AI priority: ${esc(b.threat)} <small>(internal)</small></button>` : ""}</div>
    <p class="boss-blurb">${mdb(b.blurb)}</p>
    <p class="boss-desc">${mdb(b.desc)}</p>`;

  const grab = bossGrabVal(b.grab);
  h += `<div class="statgrid">`;
  if (b.health && b.health.total) h += `<div class="stat"><div class="k">Health</div><div class="v">${bNum(b.health.total)}</div></div>`;
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
    [w.damage != null ? bNum(w.damage) + " dmg" : "", w.rps ? `${w.rps}/s` : "", w.caliber ? (CAL_LABEL[w.caliber] || w.caliber) : "", w.knockdown ? "knockdown" : ""].filter(Boolean).join(" &middot; ")]));
  if (rows.length) {
    h += `<div class="section"><h3>Attacks</h3><div class="gtable-wrap"><table class="gtable"><tbody>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</tbody></table></div></div>`;
  }

  if (b.weakpoint) h += `<div class="callout" style="border-left-color:var(--olive)"><b>Weak point.</b> ${mdb(b.weakpoint)}</div>`;

  if (b.weaknesses && b.weaknesses.length) {
    h += `<div class="section"><h3>Weaknesses</h3><ul class="boss-weak">${b.weaknesses.map((w) => `<li>${mdb(w)}</li>`).join("")}</ul></div>`;
  }

  if (b.codexReward) {
    h += `<p class="boss-codex"><b>${esc(b.codexReward.name)}</b>${b.codexReward.upgrade ? ` &rarr; unlocks ${esc(b.codexReward.upgrade)}` : ""} &middot; ${bNum(b.codexReward.xp)} XP &middot; ${bNum(b.codexReward.cr)} cr</p>`;
  }
  h += `</div>`;
  return h;
}

function drawBosses() {
  const D = BOSSDATA;
  const bosses = D.bosses.filter((b) => match(b.name) || match(b.type) || (b.aka && match(b.aka)) || match(b.faction));
  let html = `<div class="guide">
    <div class="callout" style="margin-top:16px"><b>Datamined from each boss's own AI, not the forums.</b>
      Health, the stun threshold, melee &amp; dash damage, the grab that instakills you, and every mounted gun &mdash; read straight from the game's <code>FWAIPawnDefinition</code> files. The tactics are built from those numbers.</div>
    <div class="callout" style="border-left-color:var(--olive)"><b>Two mechanics decide most fights.</b>
      <b>Stagger</b> &mdash; burst that much damage into it inside the window and it's stunned (only <em>your</em> damage counts &mdash; which is why one railgun shot can freeze what a whole magazine can't). <b>The grab</b> &mdash; a sync-kill that ends the raid on the spot; most only trigger at low health, so simply <em>staying healthy</em> is a defence.</div>`;

  html += `<div class="chips boss-jump">` + bosses.map((b) => `<button class="chip" data-bossjump="${esc(b.id)}">${esc(b.name)}</button>`).join("") + `</div>`;

  if (!bosses.length) html += `<p class="empty">No bosses match &ldquo;${esc(state.q)}&rdquo;.</p>`;
  else html += bosses.map(bossCard).join("");

  html += `<p class="legend">Method: decoded from the shipping game's <code>FW/AI/Characters/&hellip;/AIDEF_*</code> pawn definitions and <code>DA_WPN_*</code> weapon defs via a UE4SS type mapping + CUE4Parse (build ${D.build}). Ranges: Unreal units &divide; 100 = metres. Codex values &amp; tactics cross-checked against the wiki and community testing.</p></div>`;
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
  let h = `<div class="fac-action"><div class="fac-action-head">
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

  html += `<div class="card"><div class="section" style="margin-top:0"><h3>Who controls each map <span class="c">starting split</span></h3></div>`;
  const maps = D.maps.filter((m) => match(m.name));
  if (!maps.length) html += `<p class="empty">No maps match &ldquo;${esc(state.q)}&rdquo;.</p>`;
  else maps.forEach((m) => { html += `<div class="fac-map"><div class="fac-map-name">${esc(m.name)}</div>${facBar(m.control)}</div>`; });
  html += `<p class="gnote">Each army starts with a share of every surface map; whoever holds more fields more units there. These are the <b>default</b> weights &mdash; live control drifts as the war (and players) push it. Hubs (${(D.hubs || []).map((h) => esc(h.name)).join(", ")}) are Scavenger-held.</p></div>`;

  html += `<div class="card"><div class="section" style="margin-top:0"><h3>The sabotage playbook <span class="c">shift the war yourself</span></h3></div>
    <p class="gnote">Each is a droppable objective on its map. Pull it off and it ripples to <em>other</em> maps &mdash; server-wide, for the listed real-world hours &mdash; changing who you'll face there.</p>`;
  D.actions.filter((a) => match(a.name) || match(a.where) || (a.desc && match(a.desc))).forEach((a) => { html += facActionCard(a); });
  html += `</div>`;

  const rep = D.reputation;
  html += `<div class="card"><div class="section" style="margin-top:0"><h3>Faction standing <span class="c">your personal rep</span></h3></div>
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
  html += `<div class="card"><div class="section" style="margin-top:0"><h3>The loot economy at a glance <span class="c">${D.count} sellable items</span></h3></div>
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
    html += `<details class="eco-det" id="eco-tier-${t.key}"${open ? " open" : ""}>
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
  return `<div class="section eco-sec"><h3>By space-efficiency <span class="c">${ranked.length} items &middot; credits per unit of bin volume</span></h3></div>
    <p class="gnote">Rig space is the real constraint. When your small-item bins are nearly full, grab the <b>densest</b> loot first &mdash;
    the top of this list is the most credits per cubic unit. Destroyed weapons and Large items use dedicated bins (no small-item volume),
    so they sink to the bottom.</p>
    <div class="gtable-wrap"><table class="gtable eco-table">
      <thead><tr><th>Item</th><th>Tier</th><th>Category</th><th class="num">Value</th><th class="num">cr / cu</th><th class="num">cr / kg</th></tr></thead>
      <tbody>${ranked.map((it) => ecoRow(it, catCell, dens, true)).join("")}</tbody>
    </table></div>`;
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

init();
