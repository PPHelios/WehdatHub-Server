// web/static/map.js — The Map page (/app/map) and the owner's pin picker (/app/owner/map): Leaflet draws the vector map from
// one .pmtiles file; pins carry the number of units; filters, search suggestions and the slide-up unit list sit on top.
(function () {
  "use strict";
  var root = document.querySelector("[data-map]");
  if (!root) return;
  var app = document.querySelector("[data-mapapp]");
  var cfg = app || root;
  var tr = {};
  try { tr = JSON.parse(cfg.getAttribute("data-i18n") || "{}"); } catch (e) { tr = {}; }
  var lang = cfg.getAttribute("data-lang") === "en" ? "en" : "ar";
  var tiles = cfg.getAttribute("data-tiles");

  function ready(fn) {
    if (window.L && window.protomapsL) return fn();
    var tries = 0;
    var t = setInterval(function () {
      tries += 1;
      if (window.L && window.protomapsL) { clearInterval(t); fn(); }
      else if (tries > 100) { clearInterval(t); root.textContent = tr.loadFail || "Map failed to load."; }
    }, 100);
  }

  function fmtMoney(n) {
    if (n >= 1e6) return (Math.round(n / 1e5) / 10) + " " + (tr.m || "M");
    if (n >= 1e3) return Math.round(n / 1e3) + " " + (tr.k || "K");
    return String(Math.round(n));
  }
  var norm = function (s) {
    return String(s || "").toLowerCase().replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").trim();
  };

  ready(function () {
    // Going to a unit and back returns here: the view, filters, search and open place are kept for this tab.
    var KEY = "wh-map-state";
    var saved = null;
    if (!root.hasAttribute("data-pick")) {
      try { saved = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { saved = null; }
    }
    var map = L.map(root, { zoomControl: true, attributionControl: false, minZoom: 5, maxZoom: 17, tap: true })
      .setView(saved && saved.c ? saved.c : [30.05, 31.45], saved && saved.z ? saved.z : 9);
    protomapsL.leafletLayer({ url: tiles, flavor: "light", lang: lang }).addTo(map);

    // The owner's picker: tap the map to drop the pin into the latitude and longitude fields.
    if (root.hasAttribute("data-pick")) {
      var latEl = document.querySelector("[data-lat]");
      var lngEl = document.querySelector("[data-lng]");
      var marker = null;
      var nameEl = document.querySelector("[name=name_en]") || document.querySelector("[name=name_ar]");
      var put = function (lat, lng, move) {
        if (!isFinite(lat) || !isFinite(lng)) return;
        if (!marker) marker = L.circleMarker([lat, lng], { radius: 9, weight: 3, color: "#b91c1c", fillColor: "#ef4444", fillOpacity: 0.9 }).addTo(map); else marker.setLatLng([lat, lng]);
        if (nameEl && nameEl.value && !marker.getTooltip()) marker.bindTooltip(nameEl.value, { permanent: true, direction: "top", offset: [0, -8] });
        if (move) map.setView([lat, lng], Math.max(map.getZoom(), 14));
      };
      put(parseFloat(latEl.value), parseFloat(lngEl.value), true);
      // Every approved place that has a position: its name on hover, tap to edit it.
      var all = [];
      try { all = JSON.parse(root.getAttribute("data-places") || "[]"); } catch (e) { all = []; }
      all.forEach(function (p) {
        L.circleMarker([p.lat, p.lng], { radius: 6, weight: 1, color: "#1d4ed8", fillColor: "#3b82f6", fillOpacity: 0.8 })
          .bindTooltip(String(p.n), { direction: "top" })
          .on("click", function () { window.location.href = "/app/owner/map?edit=" + encodeURIComponent(p.id) + "#place-form"; })
          .addTo(map);
      });
      map.on("click", function (e) {
        latEl.value = e.latlng.lat.toFixed(6);
        lngEl.value = e.latlng.lng.toFixed(6);
        put(e.latlng.lat, e.latlng.lng, false);
      });
      var follow = function () { put(parseFloat(latEl.value), parseFloat(lngEl.value), true); };
      latEl.addEventListener("change", follow);
      lngEl.addEventListener("change", follow);
      return;
    }

    // ---- Pins ----
    var state = { type: "", rooms: "", ptype: "", fin: "", furn: "", deal: "", pmin: null, pmax: null };
    var facets = { types: [], pmin: null, pmax: null };
    var pinsData = [];
    var idleData = [];
    var idleMarker = null;
    var layer = L.layerGroup().addTo(map);
    var countEl = app.querySelector("[data-map-count]");
    var drawer = app.querySelector("[data-map-drawer]");
    var drawerBody = app.querySelector("[data-drawer-body]");
    var drawerTitle = app.querySelector("[data-drawer-title]");
    var typeSel = app.querySelector("[data-f-ptype]");
    var budget = app.querySelector("[data-budget]");
    var sMin = app.querySelector("[data-f-pmin]");
    var sMax = app.querySelector("[data-f-pmax]");
    var budgetText = app.querySelector("[data-budget-text]");
    var minBox = app.querySelector("[data-pmin-box]");
    var maxBox = app.querySelector("[data-pmax-box]");
    var fill = app.querySelector("[data-dual-fill]");
    var pending = 0;
    var openId = null;
    var restoring = !!saved;
    function remember() {
      try {
        var c = map.getCenter();
        sessionStorage.setItem(KEY, JSON.stringify({ c: [c.lat, c.lng], z: map.getZoom(), s: state, slider: [sMin.value, sMax.value], q: input.value, fin: finSel.value, furn: furnSel.value, deal: dealSel.value, place: openId }));
      } catch (e) { /* storage can be off: the page still works */ }
    }
    function markChips(attr, val) {
      app.querySelectorAll("[" + attr + "]").forEach(function (b) { b.classList.toggle("on", b.getAttribute(attr) === String(val || "")); });
    }

    function query() {
      var q = [];
      if (state.type) q.push("type=" + state.type);
      if (state.rooms) q.push("rooms=" + state.rooms);
      if (state.ptype) q.push("ptype=" + encodeURIComponent(state.ptype));
      if (state.fin) q.push("fin=" + state.fin);
      if (state.furn) q.push("furn=" + state.furn);
      if (state.deal) q.push("deal=" + state.deal);
      if (state.pmin !== null) q.push("pmin=" + Math.round(state.pmin));
      if (state.pmax !== null) q.push("pmax=" + Math.round(state.pmax));
      return q.join("&");
    }

    // Slider position (0 to 100) to a price: logarithmic, so sale and rent prices both sit comfortably on one bar.
    function toPrice(t) {
      var lo = facets.pmin, hi = facets.pmax;
      if (!lo || !hi || hi <= lo) return lo || 0;
      return lo * Math.pow(hi / lo, t / 100);
    }
    function fromPrice(p) {
      var lo = facets.pmin, hi = facets.pmax;
      if (!lo || !hi || hi <= lo || p <= lo) return 0;
      if (p >= hi) return 100;
      return (100 * Math.log(p / lo)) / Math.log(hi / lo);
    }
    // "5m", "250k", "5,000,000" -> a number, or null.
    function parseMoney(t) {
      var m = String(t || "").toLowerCase().replace(/[,\s]/g, "").match(/^(\d+(?:\.\d+)?)([mk]?)$/);
      if (!m) return null;
      return Number(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1);
    }
    function budgetLabel() {
      var a = Number(sMin.value), b = Number(sMax.value);
      budgetText.textContent = a <= 0 && b >= 100 ? tr.allBudget : fmtMoney(toPrice(a)) + " – " + fmtMoney(toPrice(b)) + " " + (tr.egp || "");
      fill.style.left = a + "%";
      fill.style.width = Math.max(0, b - a) + "%";
      if (document.activeElement !== minBox) minBox.value = state.pmin === null ? "" : fmtMoney(state.pmin);
      if (document.activeElement !== maxBox) maxBox.value = state.pmax === null ? "" : fmtMoney(state.pmax);
    }

    function setFacets(f) {
      facets = f || facets;
      var cur = state.ptype;
      typeSel.innerHTML = "";
      var any = document.createElement("option");
      any.value = ""; any.textContent = tr.any || "Any";
      typeSel.appendChild(any);
      (facets.types || []).forEach(function (t) {
        var o = document.createElement("option");
        o.value = t; o.textContent = (tr.types && tr.types[t]) || t.replace(/_/g, " ");
        typeSel.appendChild(o);
      });
      typeSel.value = cur;
      budget.hidden = !(facets.pmin && facets.pmax && facets.pmax > facets.pmin);
      budgetLabel();
    }

    function pinIcon(p) {
      var el = document.createElement("div");
      el.className = "pin";
      var n = document.createElement("span");
      n.className = "pin-n";
      n.textContent = p.n > 99 ? "99+" : String(p.n);
      var t = document.createElement("span");
      t.className = "pin-t";
      t.textContent = lang === "en" ? p.name_en || p.name_ar : p.name_ar || p.name_en;
      el.appendChild(n); el.appendChild(t);
      return L.divIcon({ className: "pin-wrap", html: el, iconSize: null });
    }

    function render(first) {
      layer.clearLayers();
      pinsData.forEach(function (p) {
        var m = L.marker([p.lat, p.lng], { icon: pinIcon(p), keyboard: true, title: p.name });
        m.on("click", function () { openDrawer(p); });
        layer.addLayer(m);
      });
      if (first && pinsData.length) {
        map.fitBounds(L.latLngBounds(pinsData.map(function (p) { return [p.lat, p.lng]; })), { padding: [30, 30], maxZoom: 13 });
      }
    }

    function load(first) {
      var id = ++pending;
      fetch("/app/map/pins?" + query(), { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (id !== pending) return;
          pinsData = d.pins || [];
          idleData = d.idle || [];
          if (first || !facets.types.length) setFacets(d.facets);
          else if (d.facets && !state.ptype && state.pmin === null && state.pmax === null) setFacets(d.facets);
          countEl.textContent = d.total + " " + (tr.units || "units") + " · " + pinsData.length + " " + (lang === "en" ? "places" : "مكان");
          render(first && !restoring);
          if (restoring) {
            restoring = false;
            var sp = saved && saved.place;
            saved = null;
            var hit = sp && pinsData.concat(idleData).filter(function (p) { return p.id === sp; })[0];
            if (hit) openDrawer(hit, true);
          }
          remember();
        })
        .catch(function () { countEl.textContent = tr.loadFail || ""; });
    }

    function openDrawer(p, quiet) {
      drawerTitle.textContent = lang === "en" ? p.name_en || p.name_ar : p.name_ar || p.name_en;
      drawerBody.innerHTML = "";
      drawer.hidden = false;
      requestAnimationFrame(function () { drawer.classList.add("open"); });
      var q = query();
      fetch("/app/map/place/" + p.id + (q ? "?" + q : ""), { credentials: "same-origin" })
        .then(function (r) { return r.text(); })
        .then(function (h) { drawerBody.innerHTML = h; })
        .catch(function () { drawerBody.textContent = tr.loadFail || ""; });
      if (!quiet) map.panTo([p.lat, p.lng]);
      openId = p.id;
      remember();
    }
    function closeDrawer() {
      drawer.classList.remove("open");
      openId = null;
      remember();
      setTimeout(function () { drawer.hidden = true; }, 200);
    }
    app.querySelector("[data-drawer-close]").addEventListener("click", closeDrawer);
    map.on("click", closeDrawer);

    // ---- Filters ----
    function chips(attr, key) {
      var all = app.querySelectorAll("[" + attr + "]");
      all.forEach(function (b) {
        b.addEventListener("click", function () {
          all.forEach(function (x) { x.classList.remove("on"); });
          b.classList.add("on");
          state[key] = b.getAttribute(attr);
          if (key === "type") { state.pmin = null; state.pmax = null; sMin.value = 0; sMax.value = 100; facets = { types: facets.types, pmin: null, pmax: null }; }
          load(key === "type");
          if (key === "type") loadFacetsOnly();
        });
      });
    }
    function loadFacetsOnly() {
      // A new sale or rent choice changes the price range: take it from the answer.
      var id = pending;
      fetch("/app/map/pins?" + query(), { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (d) {
        if (id === pending) setFacets(d.facets);
      });
    }
    chips("data-f-type", "type");
    chips("data-f-rooms", "rooms");
    typeSel.addEventListener("change", function () { state.ptype = typeSel.value; load(false); });
    var finSel = app.querySelector("[data-f-fin]");
    var furnSel = app.querySelector("[data-f-furn]");
    finSel.addEventListener("change", function () { state.fin = finSel.value; load(false); });
    furnSel.addEventListener("change", function () { state.furn = furnSel.value; load(false); });
    var dealSel = app.querySelector("[data-f-deal]");
    dealSel.addEventListener("change", function () { state.deal = dealSel.value; load(false); });
    function sliderChange() {
      var a = Number(sMin.value), b = Number(sMax.value);
      if (a > b) { if (this === sMin) sMin.value = b; else sMax.value = a; a = Number(sMin.value); b = Number(sMax.value); }
      state.pmin = a <= 0 ? null : toPrice(a);
      state.pmax = b >= 100 ? null : toPrice(b);
      budgetLabel();
    }
    [sMin, sMax].forEach(function (s) {
      s.addEventListener("input", sliderChange);
      s.addEventListener("change", function () { sliderChange.call(s); load(false); });
    });
    // The boxes take exact numbers and move the handles.
    function boxChange() {
      var a = parseMoney(minBox.value), b = parseMoney(maxBox.value);
      state.pmin = a && a > 0 ? a : null;
      state.pmax = b && b > 0 ? b : null;
      if (state.pmin !== null && state.pmax !== null && state.pmin > state.pmax) { var t = state.pmin; state.pmin = state.pmax; state.pmax = t; }
      sMin.value = state.pmin === null ? 0 : fromPrice(state.pmin);
      sMax.value = state.pmax === null ? 100 : fromPrice(state.pmax);
      budgetLabel();
      load(false);
    }
    [minBox, maxBox].forEach(function (b) { b.addEventListener("change", boxChange); });
    var toggle = app.querySelector("[data-map-filter-toggle]");
    var bar = app.querySelector("[data-map-filters]");
    toggle.addEventListener("click", function () {
      var open = !bar.classList.contains("open");
      bar.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      setTimeout(function () { map.invalidateSize(); }, 50);
    });

    // ---- Search with suggestions ----
    var input = app.querySelector("[data-map-q]");
    var list = app.querySelector("[data-map-suggest]");
    function hideList() { list.hidden = true; input.setAttribute("aria-expanded", "false"); }
    function suggest() {
      var q = norm(input.value);
      list.innerHTML = "";
      if (!q) return hideList();
      var hits = pinsData.concat(idleData).filter(function (p) {
        return norm([p.name_en, p.name_ar, p.developer, p.district, p.terms].join(" ")).indexOf(q) !== -1;
      }).slice(0, 8);
      if (!hits.length) {
        var li0 = document.createElement("li");
        li0.className = "muted"; li0.textContent = tr.nothing || "No matches";
        list.appendChild(li0);
      }
      hits.forEach(function (p) {
        var li = document.createElement("li");
        li.setAttribute("role", "option");
        li.tabIndex = 0;
        var name = document.createElement("strong");
        name.textContent = lang === "en" ? p.name_en || p.name_ar : p.name_ar || p.name_en;
        var meta = document.createElement("span");
        meta.className = "muted small";
        meta.textContent = [p.developer, p.district].filter(Boolean).join(" · ") + " · " + p.n;
        li.appendChild(name); li.appendChild(meta);
        var go = function () {
          hideList(); input.value = name.textContent; map.setView([p.lat, p.lng], 15);
          if (idleMarker) { map.removeLayer(idleMarker); idleMarker = null; }
          if (p.n) return openDrawer(p);
          // A place with no visible units still gets its pin, marked "0 units".
          idleMarker = L.marker([p.lat, p.lng], { icon: pinIcon(p), title: name.textContent }).addTo(map);
          idleMarker.getElement() && idleMarker.getElement().classList.add("pin-idle");
        };
        li.addEventListener("click", go);
        li.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
        list.appendChild(li);
      });
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }
    input.addEventListener("input", suggest);
    input.addEventListener("focus", suggest);
    document.addEventListener("click", function (e) { if (!app.querySelector(".map-search").contains(e.target)) hideList(); });

    map.on("zoomend", function () { root.classList.toggle("zoomed", map.getZoom() >= 12); });
    map.on("moveend", remember);
    if (saved) {
      if (saved.s) state = saved.s;
      if (saved.slider) { sMin.value = saved.slider[0]; sMax.value = saved.slider[1]; }
      if (saved.fin) finSel.value = saved.fin;
      if (saved.furn) furnSel.value = saved.furn;
      if (saved.deal) dealSel.value = saved.deal;
      input.value = saved.q || "";
      markChips("data-f-type", state.type);
      markChips("data-f-rooms", state.rooms);
    }
    load(true);
  });
})();
