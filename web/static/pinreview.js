// web/static/pinreview.js — The owner's pin review map (Check saved pins, Missing pins): one map above the list. Picking a place in
// the list shows its saved, OpenStreetMap and Google pins; tapping the map sets the owner's own spot for that place.
(function () {
  "use strict";
  var COLORS = { saved: "#b91c1c", osm: "#2563eb", google: "#16a34a", mine: "#d97706" };
  var KEYS = ["saved", "osm", "google"];

  function ready(fn) {
    if (window.L && window.protomapsL) return fn();
    var tries = 0;
    var t = setInterval(function () {
      tries += 1;
      if (window.L && window.protomapsL) { clearInterval(t); fn(); }
      else if (tries > 100) clearInterval(t);
    }, 100);
  }

  function setup(root) {
    if (root.getAttribute("data-ready")) return;
    root.setAttribute("data-ready", "1");
    var rows = [];
    var tr = {};
    try { rows = JSON.parse(root.getAttribute("data-rows") || "[]"); } catch (e) { rows = []; }
    try { tr = JSON.parse(root.getAttribute("data-i18n") || "{}"); } catch (e) { tr = {}; }
    var lang = root.getAttribute("data-lang") === "en" ? "en" : "ar";
    var satKey = root.getAttribute("data-sat-key") || "";
    var scope = root.parentNode;
    var sat = scope.querySelector("[data-sat]");
    var form = scope.querySelector("form");
    var map = L.map(root, { zoomControl: true, attributionControl: false, minZoom: 5, maxZoom: 17, tap: true }).setView([30.05, 31.45], 9);
    protomapsL.leafletLayer({ url: root.getAttribute("data-tiles"), flavor: "light", lang: lang }).addTo(map);
    var layer = L.layerGroup().addTo(map);
    var current = null;

    function dot(kind, p) {
      return L.circleMarker([p.lat, p.lng], { radius: 8, weight: 3, color: COLORS[kind], fillColor: COLORS[kind], fillOpacity: 0.85 })
        .bindTooltip(tr[kind] || kind, { permanent: true, direction: "top", offset: [0, -6] });
    }

    // A satellite picture of the same pins (Google Static Maps), only when a browser key is set.
    function showSat(row) {
      if (!sat || !satKey) return;
      var marks = [];
      var labels = { saved: "S", osm: "O", google: "G" };
      KEYS.forEach(function (k) {
        if (row[k]) marks.push("markers=color:" + (k === "saved" ? "red" : k === "osm" ? "blue" : "green") + "%7Clabel:" + labels[k] + "%7C" + row[k].lat + "," + row[k].lng);
      });
      if (!marks.length) { sat.hidden = true; return; }
      sat.src = "https://maps.googleapis.com/maps/api/staticmap?size=640x320&scale=2&maptype=satellite&" + marks.join("&") + "&key=" + encodeURIComponent(satKey);
      sat.hidden = false;
    }

    function select(id) {
      var row = rows.filter(function (r) { return r.id === id; })[0];
      if (!row) return;
      current = row;
      layer.clearLayers();
      var pts = [];
      KEYS.forEach(function (k) {
        if (row[k]) { dot(k, row[k]).addTo(layer); pts.push([row[k].lat, row[k].lng]); }
      });
      if (row.mine) { dot("mine", row.mine).addTo(layer); pts.push([row.mine.lat, row.mine.lng]); }
      if (pts.length) map.fitBounds(L.latLngBounds(pts), { maxZoom: 15, padding: [30, 30] });
      var items = scope.querySelectorAll("[data-row]");
      for (var i = 0; i < items.length; i++) items[i].classList.toggle("is-selected", items[i].getAttribute("data-row") === id);
      showSat(row);
    }

    // The owner's own spot: it fills the hidden choice of that place, so the form sends it.
    map.on("click", function (e) {
      if (!current || !form) return;
      var lat = Number(e.latlng.lat.toFixed(6));
      var lng = Number(e.latlng.lng.toFixed(6));
      var box = form.querySelector('[data-custom="' + current.id + '"]');
      if (!box) return;
      current.mine = { lat: lat, lng: lng };
      box.value = box.type === "radio" ? lat + "," + lng : current.id + "," + lat + "," + lng;
      box.checked = true;
      var note = form.querySelector('[data-custom-note="' + current.id + '"]');
      if (note) { note.textContent = (tr.mine || "Your spot") + ": " + lat + ", " + lng; note.hidden = false; }
      select(current.id);
    });

    scope.addEventListener("click", function (e) {
      var li = e.target.closest && e.target.closest("[data-row]");
      if (li) select(li.getAttribute("data-row"));
    });
    if (rows.length) select(rows[0].id);
  }

  function init(scope) {
    var roots = (scope || document).querySelectorAll("[data-review]");
    if (!roots.length) return;
    ready(function () { for (var i = 0; i < roots.length; i++) setup(roots[i]); });
  }
  init(document);
  document.addEventListener("lazy:loaded", function (e) { init(e.detail); });
})();
