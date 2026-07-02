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
  else if (state.tab === "muzzles") renderMuzzles();
  else renderStats();
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
      <div class="section" style="margin-top:0"><h3>Damage &amp; headshots (the hidden part)</h3></div>
      <div class="gdef"><span class="term">Base damage</span><span>Tied to the weapon (balanced around caliber/type), <b>not</b> to which ammo you load. The card often <b>under-reports</b> real damage — e.g. the AT-43 MASS deals roughly double what it lists, and shotguns and Painless read low too. Don't dismiss a gun by its listed damage alone.</span></div>
      <div class="gdef"><span class="term">Critical / headshot damage</span><span>A hidden, per-<b>caliber</b> multiplier that lives on your <b>ammo</b>, not the gun. A lower-damage caliber with a high crit modifier can out-perform a higher-damage one on consistent headshots. Some enemies (notably melee cyborgs) have headshot <em>resistance</em>.</span></div>
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
