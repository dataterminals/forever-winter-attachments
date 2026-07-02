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
const state = { tab: "weapons", weapon: null, att: null, q: "" };
const idx = { attById: {}, weaponByName: {}, weaponSubtype: {}, subtypes: {} };

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
      render();
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
    const el = e.target.closest("[data-weapon],[data-att],[data-goatt],[data-goweapon],[data-back]");
    if (!el) return;
    if (el.dataset.back !== undefined) { view.classList.remove("detail-open"); render(); return; }
    if (el.dataset.weapon) { state.weapon = el.dataset.weapon; openDetail(); }
    else if (el.dataset.att) { state.att = el.dataset.att; openDetail(); }
    else if (el.dataset.goatt) { state.tab = "attachments"; state.att = el.dataset.goatt; syncTabs(); openDetail(); }
    else if (el.dataset.goweapon) { state.tab = "weapons"; state.weapon = el.dataset.goweapon; syncTabs(); openDetail(); }
  });
}
function syncTabs() { document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab)); }
function openDetail() { view.classList.add("detail-open"); render(); window.scrollTo({ top: 0 }); }

/* ---------- render dispatch ---------- */
function render() {
  if (state.tab === "weapons") renderWeapons();
  else if (state.tab === "attachments") renderAttachments();
  else renderMuzzles();
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
  view.innerHTML = `<div class="panes"><div class="list">${list}</div><div class="detail">${detail}</div></div>`;
}

function weaponDetail(w) {
  const st = idx.weaponSubtype[w.name];
  const needs = w.needsPart || {};
  let anyReq = false;
  let html = `<button class="backbtn" data-back>&larr; all weapons</button><div class="card">
    <div class="dhead"><h2>${esc(w.name)}</h2><span class="badge gold">${esc(w.class)}</span>
      <span class="badge">${w.total} attachments</span></div>`;
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
      const sub = a.subtype ? `<span class="rmeta">${a.subtype}</span>` : "";
      list += `<button class="row ${state.att === a.id ? "sel" : ""}" data-att="${esc(a.id)}">
        <span class="rname">${esc(a.name)}</span>
        <span class="rmeta">${a.subtype ? `<span class="count">${esc(a.subtype)}</span>` : ""}<span class="count">${a.compatible.length}</span></span></button>`;
    });
  });
  if (!list) list = `<p class="empty">No attachments match &ldquo;${esc(state.q)}&rdquo;.</p>`;
  const detail = state.att && idx.attById[state.att]
    ? attDetail(idx.attById[state.att])
    : `<div class="placeholder">Pick an attachment to see which weapons it fits.</div>`;
  view.innerHTML = `<div class="panes"><div class="list">${list}</div><div class="detail">${detail}</div></div>`;
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

/* ---------- PWA plumbing ---------- */
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredPrompt = e;
  const b = $("#installBtn"); b.hidden = false;
  b.onclick = async () => { b.hidden = true; deferredPrompt.prompt(); deferredPrompt = null; };
});
window.addEventListener("appinstalled", () => ($("#installBtn").hidden = true));
function registerSW() { if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {}); }

init();
