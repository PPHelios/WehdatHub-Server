// web/static/catalogueSearch.js — The catalogue's search box: the unit box's suggestions (places, then features) plus developers and projects.
// Picking one sets that filter and searches; the chips come back from the server, so the page works the same on a reload.
(function () {
  "use strict";

  function init(form) {
    if (!form || form.hasAttribute("data-cs-on")) return;
    form.setAttribute("data-cs-on", "");
    var input = form.querySelector("[data-csearch-input]");
    var list = form.querySelector("[data-csearch-list]");
    var field = form.querySelector("[data-csearch-field]");
    var msg = function (k, s) { return (form.getAttribute("data-msg-" + k) || "").replace("%s", s || ""); };
    var items = [];
    var at = -1;
    var timer = null;
    var asked = "";

    function close() { list.hidden = true; list.innerHTML = ""; items = []; at = -1; }
    function mark(n) {
      var opts = list.querySelectorAll("[role=option]");
      at = Math.max(-1, Math.min(opts.length - 1, n));
      for (var i = 0; i < opts.length; i++) opts[i].setAttribute("aria-selected", i === at ? "true" : "false");
      if (opts[at]) opts[at].scrollIntoView({ block: "nearest" });
    }
    function hidden(name, value, single) {
      if (single) { var old = form.querySelector('input[type="hidden"][name="' + name + '"]'); if (old) old.remove(); }
      var h = document.createElement("input");
      h.type = "hidden"; h.name = name; h.value = value;
      form.appendChild(h);
    }
    function choose(it) {
      if (!it) return;
      if (it.kind === "project") { window.location.href = "/app/catalogue/projects/" + it.id; return; }
      if (it.kind === "compound" || it.kind === "subzone" || it.kind === "area") hidden("pl", it.id, true);
      else if (it.kind === "feature") hidden("f", it.key, false);
      else if (it.kind === "developer") hidden("dev", it.id, true);
      if (it.kind !== "text") input.value = "";
      form.submit();
    }
    function render(q, found) {
      list.innerHTML = "";
      items = [];
      var group = function (title) { var g = document.createElement("div"); g.className = "ubox-group"; g.textContent = title; list.appendChild(g); };
      var add = function (it, label, sub, cls) {
        var b = document.createElement("button");
        b.type = "button"; b.setAttribute("role", "option"); b.className = "ubox-opt " + (cls || "");
        b.setAttribute("data-i", String(items.length));
        var s = document.createElement("strong"); s.textContent = label; b.appendChild(s);
        if (sub) { var t = document.createElement("span"); t.textContent = sub; b.appendChild(t); }
        list.appendChild(b);
        items.push(it);
      };
      var of = function (fn) { return found.filter(fn); };
      var places = of(function (it) { return it.kind === "compound" || it.kind === "subzone" || it.kind === "area"; });
      var feats = of(function (it) { return it.kind === "feature"; });
      var devs = of(function (it) { return it.kind === "developer"; });
      var projs = of(function (it) { return it.kind === "project"; });
      if (places.length) group(msg("places"));
      places.forEach(function (it) { add(it, it.label, [it.path].concat(it.zones || []).filter(Boolean).join(" · ")); });
      if (feats.length) group(msg("features"));
      feats.forEach(function (it) { add(it, it.label, ""); });
      if (devs.length) group(msg("developers"));
      devs.forEach(function (it) { add(it, it.label, ""); });
      if (projs.length) group(msg("projects"));
      projs.forEach(function (it) { add(it, it.label, ""); });
      add({ kind: "text" }, msg("text", q), "", "ubox-act");
      list.hidden = false;
      mark(0);
    }
    function ask(q) {
      asked = q;
      fetch(form.getAttribute("data-url") + "?q=" + encodeURIComponent(q), { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : { items: [] }; })
        .catch(function () { return { items: [] }; })
        .then(function (d) { if (asked === q && input.value.trim() === q) render(q, d.items || []); });
    }

    input.addEventListener("input", function () {
      var q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { close(); return; }
      timer = setTimeout(function () { ask(q); }, 180);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (list.hidden) return;
        e.preventDefault();
        mark(at + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Enter") {
        // A marked suggestion is picked; with none open the typed words are the search.
        if (!list.hidden && items[at]) { e.preventDefault(); choose(items[at]); }
      } else if (e.key === "Escape") close();
    });
    list.addEventListener("mousedown", function (e) { e.preventDefault(); });
    list.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-i]");
      if (b) choose(items[Number(b.getAttribute("data-i"))]);
    });
    input.addEventListener("blur", function () { setTimeout(close, 150); });
    field.addEventListener("click", function (e) { if (e.target === field) input.focus(); });
  }

  init(document.querySelector("[data-csearch]"));
})();
