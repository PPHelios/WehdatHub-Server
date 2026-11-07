// web/routes/map.js — The map. Brokers (/app/map): a pin per compound that has units they can see, with the number of units,
// a search box with suggestions and filters (sale or rent, rooms, unit type, budget); tapping a pin slides up its unit list.
// The CRM owner (/app/owner/map): places, coordinates (pin drop or a pasted Google Maps link), aliases and the first seed.
// Tiles come from one .pmtiles file in Cloudflare R2 (MAP_TILES_URL); the browser reads only the pieces it shows.
"use strict";

const fs = require("fs");
const path = require("path");
const Dash = require("../../services/dashboards");
const Maps = require("../../services/mapPlaces");
const MapRules = require("../../domain/mapPlaces");
const Describe = require("../../domain/describe");
const { html, raw } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
// The first list: places read from the map file (scripts/build-map-seed.js), and a few the owner supplied by hand that the map file lacks.
const SEED_FILES = ["extra.json", "places.json"].map((f) => path.join(__dirname, "..", "..", "data", "map-seed", f));

const labels = (table, lang) => Object.fromEntries(Object.entries(table).map(([k, v]) => [k, lang === "en" ? v[1] : v[0]]));

/** Words the page script needs, in the viewer's language. */
const words = (lang) => ({
  units: L(lang, "وحدة", "units"),
  none: L(lang, "مفيش وحدات بالفلاتر دي.", "No units match these filters."),
  any: L(lang, "الكل", "Any"),
  more: L(lang, "فيه وحدات أكتر في المكان ده، افتح البحث.", "More units here: open Search."),
  nothing: L(lang, "مفيش نتايج", "No matches"),
  mapOff: L(lang, "الخريطة لسه مش متظبطة.", "The map is not set up yet."),
  loadFail: L(lang, "الخريطة معملتش تحميل. جرّب تاني.", "The map did not load. Try again."),
  egp: L(lang, "ج.م", "EGP"),
  k: L(lang, "ألف", "K"),
  m: L(lang, "مليون", "M"),
  from: L(lang, "من", "From"),
  to: L(lang, "إلى", "to"),
  allBudget: L(lang, "أي ميزانية", "Any budget"),
  types: labels(Describe.TYPE_LABELS, lang),
  finishing: labels(Describe.FINISHING_LABELS, lang),
  furnishing: labels(Describe.FURNISHING_LABELS, lang)
});

const ERRORS = (lang) => ({
  name: L(lang, "اكتب اسم المكان بالعربي أو الإنجليزي.", "Enter the place name in Arabic or English."),
  coords: L(lang, "اكتب الإحداثيات أو الصق رابط جوجل ماب.", "Enter the coordinates or paste a Google Maps link."),
  outside_egypt: L(lang, "الإحداثيات برة مصر.", "These coordinates are outside Egypt."),
  link_short: L(lang, "الرابط مختصر. افتحه في جوجل ماب وانسخ الرابط الكامل.", "That is a short link. Open it in Google Maps and copy the full link."),
  link_unreadable: L(lang, "مش قادر أقرأ الرابط ده.", "I can't read that link."),
  duplicate: L(lang, "المكان ده موجود بالفعل.", "That place already exists."),
  missing: L(lang, "المكان مش موجود.", "That place was not found.")
});

// ---- Brokers -------------------------------------------------------------

function filterBar(lang) {
  const rooms = [["", L(lang, "الكل", "Any")], ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["5", "5+"]];
  return html`<div class="map-filters" data-map-filters>
  <div class="seg-row" role="group" aria-label="${L(lang, "بيع أو إيجار", "Sale or rent")}">
    <button type="button" class="chip on" data-f-type="">${L(lang, "الكل", "All")}</button>
    <button type="button" class="chip" data-f-type="sale">${L(lang, "بيع", "Sale")}</button>
    <button type="button" class="chip" data-f-type="rent">${L(lang, "إيجار", "Rent")}</button>
  </div>
  <div class="seg-row" role="group" aria-label="${L(lang, "الغرف", "Rooms")}"><span class="muted small">${L(lang, "غرف", "Rooms")}</span>
    ${rooms.map(([v, t]) => html`<button type="button" class="chip${v === "" ? " on" : ""}" data-f-rooms="${v}">${t}</button>`)}
  </div>
  <label class="map-field"><span class="muted small">${L(lang, "نوع الوحدة", "Unit type")}</span><select data-f-ptype><option value="">${L(lang, "الكل", "Any")}</option></select></label>
  <label class="map-field"><span class="muted small">${L(lang, "التشطيب", "Finishing")}</span><select data-f-fin><option value="">${L(lang, "الكل", "Any")}</option>${Object.entries(labels(Describe.FINISHING_LABELS, lang)).map(([k, t]) => html`<option value="${k}">${t}</option>`)}</select></label>
  <label class="map-field"><span class="muted small">${L(lang, "الفرش", "Furnishing")}</span><select data-f-furn><option value="">${L(lang, "الكل", "Any")}</option>${Object.entries(labels(Describe.FURNISHING_LABELS, lang)).map(([k, t]) => html`<option value="${k}">${t}</option>`)}</select></label>
  <div class="map-budget" data-budget hidden>
    <div class="row between"><span class="muted small">${L(lang, "الميزانية", "Budget")}</span><output data-budget-text></output></div>
    <input type="range" data-f-pmin min="0" max="100" value="0" aria-label="${L(lang, "أقل ميزانية", "Minimum budget")}">
    <input type="range" data-f-pmax min="0" max="100" value="100" aria-label="${L(lang, "أعلى ميزانية", "Maximum budget")}">
  </div>
</div>`;
}

function mapPage(lang, tilesUrl) {
  if (!tilesUrl) return html`<h1>🗺️ ${L(lang, "الخريطة", "Map")}</h1><p class="card">${words(lang).mapOff}</p>`;
  return html`<section class="mapapp" data-mapapp data-pins="/app/map/pins" data-place="/app/map/place/" data-tiles="${tilesUrl}" data-lang="${lang}" data-i18n="${JSON.stringify(words(lang))}">
  <div class="map-top">
    <div class="map-search">
      <input type="search" data-map-q autocomplete="off" inputmode="search" placeholder="${L(lang, "ابحث عن كمبوند…", "Search a compound…")}" aria-label="${L(lang, "ابحث عن كمبوند", "Search a compound")}" role="combobox" aria-expanded="false" aria-controls="map-suggest">
      <ul id="map-suggest" class="map-suggest" data-map-suggest role="listbox" hidden></ul>
    </div>
    <button type="button" class="secondary small" data-map-filter-toggle aria-expanded="false">${L(lang, "فلاتر", "Filters")}</button>
  </div>
  ${filterBar(lang)}
  <p class="muted small map-count" data-map-count aria-live="polite"></p>
  <div class="map-view" data-map role="application" aria-label="${L(lang, "خريطة المشاريع", "Projects map")}"></div>
  <aside class="map-drawer" data-map-drawer hidden aria-live="polite">
    <header class="row between"><strong data-drawer-title></strong><button type="button" class="secondary small" data-drawer-close aria-label="${L(lang, "إغلاق", "Close")}">✕</button></header>
    <div data-drawer-body></div>
  </aside>
  <p class="muted small map-credit">© OpenStreetMap contributors · Protomaps</p>
</section>`;
}

function drawerBody(lang, units, place) {
  if (!units.length) return html`<p class="muted">${words(lang).none}</p>`;
  return html`<ul class="map-units">${units.map((u) => {
    const price = Describe.money(u.price_value, lang) || u.price_display || "—";
    const facts = [Describe.typeLabel(u, lang), u.bedrooms != null ? `${u.bedrooms} ${L(lang, "غرف", "bd")}` : "", u.area_value ? `${Math.round(u.area_value)} m²` : "", u.listing_type === "rent" ? L(lang, "إيجار", "Rent") : L(lang, "بيع", "Sale")].filter(Boolean).join(" · ");
    return html`<li data-unit="${u.code}"><a href="/app/units/${encodeURIComponent(u.code)}"><strong dir="ltr">${u.code}</strong> <span>${facts}</span><span class="map-price">${price}</span></a></li>`;
  })}</ul>${place ? "" : ""}`;
}

// ---- The CRM owner ---------------------------------------------------------

function placeForm(lang, p) {
  const v = p || {};
  return html`<form method="post" action="${v.id ? `/app/owner/map/${v.id}` : "/app/owner/map"}" class="card stack" data-place-form>
  <h2>${v.id ? L(lang, "تعديل مكان", "Edit place") : L(lang, "إضافة مكان", "Add a place")}</h2>
  <div class="grid">
    <label>${L(lang, "الاسم بالإنجليزي", "English name")}<input name="name_en" value="${v.name_en || ""}" maxlength="120" dir="ltr"></label>
    <label>${L(lang, "الاسم بالعربي", "Arabic name")}<input name="name_ar" value="${v.name_ar || ""}" maxlength="120"></label>
    <label>${L(lang, "المطور", "Developer")}<input name="developer" value="${v.developer || ""}" maxlength="120"></label>
    <label>${L(lang, "المنطقة", "District")}<input name="district" value="${v.district || ""}" maxlength="120"></label>
    <label>${L(lang, "خط العرض", "Latitude")}<input name="lat" value="${v.lat ?? ""}" inputmode="decimal" dir="ltr" data-lat></label>
    <label>${L(lang, "خط الطول", "Longitude")}<input name="lng" value="${v.lng ?? ""}" inputmode="decimal" dir="ltr" data-lng></label>
  </div>
  <label>${L(lang, "أو الصق رابط جوجل ماب الكامل", "Or paste the full Google Maps link")}<input name="maps_link" inputmode="url" dir="ltr" placeholder="https://www.google.com/maps/…@30.01,31.49"></label>
  <label>${L(lang, "أسماء تانية (بفاصلة)", "Other names (comma separated)")}<input name="aliases" value="${(v.aliases || []).join(", ")}" maxlength="400"></label>
  <label class="row"><input type="checkbox" name="verified" ${v.verified ? raw("checked") : ""}> ${L(lang, "راجعت الإحداثيات", "Coordinates checked")}</label>
  <p class="muted small">${L(lang, "ممكن تدوس على الخريطة تحت عشان تحط الدبوس.", "You can also tap the map below to drop the pin.")}</p>
  <button type="submit">${L(lang, "حفظ", "Save")}</button>${v.id ? html` <a class="btn secondary" href="/app/owner/map">${L(lang, "إلغاء", "Cancel")}</a>` : ""}
</form>`;
}

async function ownerPage(req, pool, lang, tilesUrl) {
  const q = String(req.query.q || "").trim().slice(0, 80);
  const filter = req.query.v === "1" ? true : req.query.v === "0" ? false : null;
  const pageNo = Math.max(1, Math.floor(Number(req.query.p) || 1));
  const [list, unmatched, editing] = await Promise.all([
    Maps.list(pool, { q, verified: filter, limit: 50, offset: (pageNo - 1) * 50 }),
    Maps.unmatched(pool, 30),
    req.query.edit ? Maps.place(pool, req.query.edit) : null
  ]);
  const msg = String(req.query.msg || "");
  const err = ERRORS(lang)[String(req.query.err || "")];
  const notice = err ? html`<p class="warn" role="alert">${err}</p>` : msg ? html`<p class="ok" role="status">${L(lang, { saved: "اتحفظ.", deleted: "اتمسح.", alias: "اتضاف الاسم.", seed: `اتضاف ${req.query.n || 0} مكان من القايمة.` }[msg] || "تمام.", { saved: "Saved.", deleted: "Deleted.", alias: "Name added.", seed: `${req.query.n || 0} places added from the seed.` }[msg] || "Done.")}</p>` : "";
  const next = list.rows.length === 50 ? html`<a class="btn secondary" href="/app/owner/map?q=${encodeURIComponent(q)}&p=${pageNo + 1}">${L(lang, "التالي", "Next")}</a>` : "";
  return html`<h1>🗺️ ${L(lang, "أماكن الخريطة", "Map places")}</h1>
${notice}
<p class="muted">${L(lang, `${list.total} مكان، ${list.verified} منهم مراجَع.`, `${list.total} places, ${list.verified} checked.`)}</p>
${placeForm(lang, editing)}
<div class="map-view map-pick" data-map data-pick role="application" aria-label="${L(lang, "اختار مكان الدبوس", "Pick the pin")}" data-tiles="${tilesUrl}" data-i18n="${JSON.stringify(words(lang))}" data-lang="${lang}"></div>
<section class="card stack" id="seed"><h2>${L(lang, "القايمة الأولى", "First list")}</h2>
  <p class="muted">${L(lang, "بتضيف الأماكن اللي مش عندك بس. اللي موجود مبيتغيرش.", "Adds only the places you do not have yet. Existing ones are not changed.")}</p>
  <form method="post" action="/app/owner/map/import" data-confirm="${L(lang, "تضيف القايمة الأولى؟", "Add the first list?")}"><button type="submit" class="secondary">${L(lang, "ضيف القايمة الأولى", "Add the first list")}</button></form>
</section>
<section class="card stack" id="unmatched"><h2>${L(lang, "أسماء عليها وحدات ومالهاش مكان", "Unit names with no place")}</h2>
  ${unmatched.length
    ? html`<ul class="stack">${unmatched.map((r) => html`<li data-unmatched><strong>${r.compound_en || r.compound}</strong> <span class="muted">${r.compound && r.compound_en ? r.compound : ""} · ${r.n} ${L(lang, "وحدة", "units")}</span>
      <form method="post" action="/app/owner/map/alias" class="row"><input type="hidden" name="alias" value="${r.compound_en || r.compound}"><input name="place" placeholder="${L(lang, "اسم المكان", "Place name")}" required maxlength="80"><button type="submit" class="secondary small">${L(lang, "اربط", "Link")}</button></form></li>`)}</ul>`
    : html`<p class="muted">${L(lang, "مفيش.", "None.")}</p>`}
</section>
<section class="card stack" id="places"><h2>${L(lang, "الأماكن", "Places")}</h2>
  <form method="get" action="/app/owner/map" class="row"><input type="search" name="q" value="${q}" placeholder="${L(lang, "ابحث", "Search")}"><select name="v"><option value="">${L(lang, "الكل", "All")}</option><option value="1"${filter === true ? raw(" selected") : ""}>${L(lang, "مراجَع", "Checked")}</option><option value="0"${filter === false ? raw(" selected") : ""}>${L(lang, "لسه", "Not yet")}</option></select><button type="submit" class="secondary">${L(lang, "ابحث", "Search")}</button></form>
  <div class="scroll"><table><thead><tr><th>${L(lang, "الاسم", "Name")}</th><th>${L(lang, "المنطقة", "District")}</th><th>${L(lang, "الموقع", "Location")}</th><th></th></tr></thead>
  <tbody>${list.rows.map((p) => html`<tr data-place="${p.id}"><td>${p.name_en || ""}<br><span class="muted">${p.name_ar || ""}</span>${p.verified ? html` ✅` : ""}</td><td>${p.district || "—"}</td><td dir="ltr">${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</td>
    <td class="row"><a class="btn secondary small" href="/app/owner/map?edit=${p.id}#place-form">${L(lang, "تعديل", "Edit")}</a>
    <form method="post" action="/app/owner/map/${p.id}/delete" data-confirm="${L(lang, "تمسح المكان ده؟", "Delete this place?")}"><button type="submit" class="secondary small">${L(lang, "امسح", "Delete")}</button></form></td></tr>`)}</tbody></table></div>
  ${next}
</section>`;
}

function register(web, { pool, page, assets }) {
  const ownerOnly = (fn) => async (req, res, next) => {
    try {
      if (!Dash.isOwner(req.session.broker)) return res.status(404).send("Not found");
      return await fn(req, res, langOf(req));
    } catch (e) {
      return next(e);
    }
  };
  const tiles = () => require("../../config").getConfig().map.tilesUrl;
  const mapHead = () =>
    html`<link rel="stylesheet" href="${assets.url("leaflet.css")}"><script src="${assets.url("leaflet.js")}" defer></script><script src="${assets.url("protomaps-leaflet.js")}" defer></script><script src="${assets.url("map.js")}" defer></script>`;
  const goOwner = (res, q) => res.redirect(303, `/app/owner/map?${q}`);

  // Brokers
  web.get("/map", async (req, res) => {
    const lang = langOf(req);
    if (Dash.isOwner(req.session.broker)) return res.redirect(303, "/app/owner/map");
    return page(req, res, { title: L(lang, "الخريطة", "Map"), nav: "map", head: tiles() ? mapHead() : null, body: mapPage(lang, tiles()) });
  });

  web.get("/map/pins", async (req, res) => {
    const broker = req.session.broker;
    if (Dash.isOwner(broker)) return res.status(404).json({ error: "not_found" });
    const [p, facets] = await Promise.all([Maps.pins(pool, broker, req.query), Maps.facets(pool, broker, req.query)]);
    return res.json({ pins: p.pins, total: p.total, unmapped: p.unmapped, facets });
  });

  web.get("/map/place/:id", async (req, res) => {
    const lang = langOf(req);
    const broker = req.session.broker;
    if (Dash.isOwner(broker)) return res.status(404).send("Not found");
    const place = await Maps.place(pool, req.params.id);
    if (!place) return res.status(404).send("Not found");
    const units = await Maps.unitsAt(pool, broker, place.id, req.query);
    return res.type("html").send(String(html`<div data-place-title="${L(lang, place.name_ar || place.name_en, place.name_en || place.name_ar)}">${drawerBody(lang, units)}</div>`));
  });

  // The CRM owner
  web.get("/owner/map", ownerOnly(async (req, res, lang) =>
    page(req, res, { title: L(lang, "أماكن الخريطة", "Map places"), nav: "owner", head: tiles() ? mapHead() : null, body: await ownerPage(req, pool, lang, tiles()) })
  ));

  const savePlace = (id) => ownerOnly(async (req, res) => {
    const out = await Maps.save(pool, id, req.body || {});
    return goOwner(res, out.ok ? "msg=saved" : `err=${out.error}${id ? `&edit=${id}` : ""}`);
  });
  web.post("/owner/map", savePlace(null));

  web.post("/owner/map/:id/delete", ownerOnly(async (req, res) => {
    await Maps.remove(pool, req.params.id);
    return goOwner(res, "msg=deleted");
  }));

  web.post("/owner/map/alias", ownerOnly(async (req, res) => {
    const id = await Maps.findByName(pool, req.body.place);
    if (!id) return goOwner(res, "err=missing#unmatched");
    await Maps.addAlias(pool, id, req.body.alias);
    return goOwner(res, "msg=alias#unmatched");
  }));

  web.post("/owner/map/import", ownerOnly(async (req, res) => {
    let rows = [];
    try {
      rows = SEED_FILES.flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8")));
    } catch {
      return goOwner(res, "err=missing");
    }
    const out = await Maps.importSeed(pool, rows);
    return goOwner(res, `msg=seed&n=${out.added}`);
  }));

  // Last, so "alias" and "import" are not read as an id.
  web.post("/owner/map/:id", (req, res, next) => savePlace(req.params.id)(req, res, next));
}

module.exports = { register, drawerBody, words, MapRules };
