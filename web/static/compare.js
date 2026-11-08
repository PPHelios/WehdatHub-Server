// web/static/compare.js — Check all pins: asks the server for 10 places at a time (their saved pin against OpenStreetMap and
// Google), shows the progress, then lists what looks right, the confident moves and the places that need a person.
// Nothing is saved until the owner presses Apply.
(function () {
  "use strict";
  var root = document.querySelector("[data-compare]");
  if (!root) return;
  var tr = {};
  try { tr = JSON.parse(root.getAttribute("data-i18n") || "{}"); } catch (e) { tr = {}; }
  var start = root.querySelector("[data-start]");
  var stop = root.querySelector("[data-stop]");
  var spin = root.querySelector("[data-spin]");
  var bar = root.querySelector("[data-bar]");
  var status = root.querySelector("[data-status]");
  var results = root.querySelector("[data-results]");
  var total = Number(root.getAttribute("data-total")) || 0;
  var stopped = false;
  var groups = { ok: [], move: [], review: [] };
  spin.style.display = "none";

  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  function gm(p) { return "https://www.google.com/maps?q=" + p.lat + "," + p.lng; }
  function link(text, p) {
    var a = el("a", text);
    a.href = gm(p);
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }
  function show(msg) { status.textContent = msg; }

  function line(r, withBox) {
    var li = el("li", null, "card row");
    var label = el("label");
    if (withBox) {
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = true;
      box.value = r.id + "," + r.osm.lat + "," + r.osm.lng;
      box.setAttribute("data-move", "");
      label.appendChild(box);
      label.appendChild(document.createTextNode(" "));
    }
    label.appendChild(el("strong", r.name));
    li.appendChild(label);
    var meta = [];
    if (r.units != null) meta.push(r.units + " " + (tr.units || "units"));
    if (r.dOsm != null) meta.push("OSM " + r.dOsm + " km");
    if (r.dGoogle != null) meta.push("Google " + r.dGoogle + " km");
    li.appendChild(el("span", meta.join(" · "), "muted small"));
    var links = el("span", null, "small");
    if (r.saved) { links.appendChild(link((tr.saved || "Saved") + " ↗", r.saved)); links.appendChild(document.createTextNode(" ")); }
    if (r.osm) { links.appendChild(link("OpenStreetMap ↗", r.osm)); links.appendChild(document.createTextNode(" ")); }
    if (r.google) links.appendChild(link("Google ↗", r.google));
    li.appendChild(links);
    return li;
  }

  function render() {
    results.textContent = "";
    var order = ["move", "review", "ok"];
    order.forEach(function (k) {
      var h = el("h2", (tr[k] || k) + " (" + groups[k].length + ")");
      results.appendChild(h);
      if (k === "ok") return; // counted, not listed: they are only marked as checked
      var ul = el("ul", null, "stack");
      groups[k].forEach(function (r) { ul.appendChild(line(r, k === "move")); });
      results.appendChild(ul);
    });
    var btn = el("button", (tr.apply || "Apply"));
    btn.type = "button";
    btn.addEventListener("click", function () { apply(btn); });
    results.appendChild(btn);
  }

  function apply(btn) {
    btn.disabled = true;
    var body = new URLSearchParams();
    body.append("_csrf", root.getAttribute("data-csrf"));
    body.append("ok", groups.ok.map(function (r) { return r.id; }).join(","));
    var boxes = results.querySelectorAll("input[data-move]");
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) body.append("move", boxes[i].value);
    fetch(root.getAttribute("data-apply"), { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" }, body: body })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (j) { show((tr.applied || "Applied") + ": " + j.checked + " (" + j.moved + " moved)"); results.textContent = ""; })
      .catch(function () { show(tr.fail || "Something went wrong."); btn.disabled = false; });
  }

  function finish() {
    start.hidden = false;
    stop.hidden = true;
    spin.style.display = "none";
    bar.hidden = true;
    if (!groups.ok.length && !groups.move.length && !groups.review.length) return show(tr.none || "Nothing left to check.");
    show((tr.done || "Done") + ": " + (groups.ok.length + groups.move.length + groups.review.length));
    render();
  }

  function run(offset) {
    if (stopped) return finish();
    fetch(root.getAttribute("data-batch") + "?offset=" + offset, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (j) {
        total = j.total || total;
        j.rows.forEach(function (r) { groups[r.verdict === "ok" || r.verdict === "move" ? r.verdict : "review"].push(r); });
        var done = offset + j.count;
        bar.value = total ? Math.min(1, done / total) : 1;
        show((tr.running || "Checking") + " " + Math.min(done, total) + " / " + total);
        if (j.count < 10 || done >= total) return finish();
        run(done);
      })
      .catch(function () { show(tr.fail || "Something went wrong."); finish(); });
  }

  start.addEventListener("click", function () {
    stopped = false;
    groups = { ok: [], move: [], review: [] };
    results.textContent = "";
    start.hidden = true;
    stop.hidden = false;
    spin.style.display = "inline-block";
    bar.hidden = false;
    bar.value = 0;
    run(0);
  });
  stop.addEventListener("click", function () { stopped = true; stop.hidden = true; });
})();
