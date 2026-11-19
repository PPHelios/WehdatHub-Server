// web/static/unitBox.js — The add/edit unit form's one box: where the unit is (one place chip) and what it has (feature chips).
// Typing asks GET /app/places/box for places and features; a pasted message asks POST /app/places/box/resolve (no AI). The
// box keeps the form's own fields current (compound, area_id, subzone_id, feature, features_other, compound_new), so the
// save, the review and every server check are the same as before. Rules: docs/plans/unified-unit-box.md.
(function () {
  "use strict";
  var LONG = 30; // a paste longer than this is a message to read, not a name to search

  function init(form) {
    var box = form && form.querySelector("[data-ubox]");
    if (!box || box.hasAttribute("data-ubox-on")) return;
    box.setAttribute("data-ubox-on", "");
    var field = box.querySelector("[data-ubox-field]");
    var chips = box.querySelector("[data-ubox-chips]"); // the chips sit under the typing line
    var input = box.querySelector("[data-ubox-input]");
    var list = box.querySelector("[data-ubox-list]");
    var ctx = box.querySelector("[data-ubox-context]");
    var warn = box.querySelector("[data-ubox-warn]");
    var compound = box.querySelector("[data-ubox-compound]");
    var other = box.querySelector("[data-ubox-other]");
    var panel = box.querySelector("[data-ubox-new]");
    var isNew = box.querySelector('input[name="compound_new"]');
    var newName = box.querySelector("[data-ubox-new-name]");
    var areaSel = form.querySelector('select[name="area_id"]');
    var subSel = form.querySelector('select[name="subzone_id"]');
    var areaInput = form.querySelector('input[data-area-input="area_id"]');
    var subInput = form.querySelector('input[data-area-input="subzone_id"]');
    var msg = function (k, s) { return (box.getAttribute("data-msg-" + k) || "").replace("%s", s || ""); };
    var items = [];
    var at = -1;
    var timer = null;
    var asked = "";

    // Something in the box changed: the review and the Save check listen for a change event on the form.
    function changed(el) { (el || compound).dispatchEvent(new Event("change", { bubbles: true })); }
    function svg(d) { return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + d + "</svg>"; }
    var PIN = svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>');
    var X = svg('<path d="M6 6l12 12M18 6L6 18"/>');

    function chip(kind, label, extra) {
      var c = document.createElement("span");
      c.className = "chip chip-" + kind;
      c.setAttribute("data-ubox-chip", kind);
      var t = document.createElement("span");
      t.setAttribute("data-chip-text", "");
      t.textContent = label;
      if (kind === "place") c.insertAdjacentHTML("beforeend", PIN);
      c.appendChild(t);
      if (extra) {
        var tag = document.createElement("em");
        tag.className = "chip-tag";
        tag.textContent = extra;
        c.appendChild(document.createTextNode(" "));
        c.appendChild(tag);
      }
      var x = document.createElement("button");
      x.type = "button"; x.className = "chip-x"; x.setAttribute("data-ubox-remove", "");
      x.setAttribute("aria-label", msg("remove", label));
      x.innerHTML = X;
      c.appendChild(x);
      return c;
    }
    function placeChip() { return chips.querySelector('[data-ubox-chip="place"]'); }
    function setSelect(sel, value) {
      if (!sel || sel.value === (value || "")) return;
      sel.value = value || "";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function setContext(parts) {
      var t = (parts || []).filter(Boolean).join(" · ");
      ctx.querySelector("[data-ubox-context-text]").textContent = t;
      ctx.hidden = !t;
    }
    function openNew(open, name) {
      panel.hidden = !open;
      isNew.disabled = !open;
      if (open) {
        newName.value = name || "";
        areaInput.setAttribute("required", "required");
        setSelect(areaSel, ""); setSelect(subSel, "");
        areaInput.value = ""; if (subInput) subInput.value = "";
        areaInput.focus();
      } else areaInput.removeAttribute("required");
    }

    // One place at a time: a second pick replaces the first (and says so).
    function pickPlace(it) {
      var old = placeChip();
      if (old) old.remove();
      var c = chip("place", it.label || it.name_ar || it.name_en);
      c.setAttribute("data-state", "known");
      chips.insertBefore(c, chips.firstChild);
      openNew(false);
      compound.value = it.kind === "compound" ? (it.label || it.name_ar || it.name_en) : "";
      setSelect(areaSel, it.area_id || "");
      setSelect(subSel, it.subzone_id || "");
      setContext([it.path].concat(it.zones || []).concat(it.governorate ? [it.governorate] : []));
      warn.hidden = true;
      if (old) announce(msg("swap", it.label));
      changed();
    }
    function requestNew(name) {
      var old = placeChip();
      if (old) old.remove();
      var c = chip("place", name, msg("new"));
      c.setAttribute("data-state", "new");
      chips.insertBefore(c, chips.firstChild);
      compound.value = name;
      setContext([]);
      warn.hidden = true;
      openNew(true, name);
      changed();
    }
    function hasFeature(key) { return Boolean(chips.querySelector('[data-ubox-chip="feature"][data-key="' + key + '"]')); }
    function addFeature(key, label) {
      if (!key || hasFeature(key)) return;
      var c = chip("feature", label);
      c.setAttribute("data-key", key);
      var h = document.createElement("input");
      h.type = "hidden"; h.name = "feature"; h.value = key;
      c.appendChild(h);
      chips.appendChild(c);
      changed(h);
    }
    function others() {
      return Array.prototype.map.call(chips.querySelectorAll('[data-ubox-chip="other"] [data-chip-text]'), function (t) { return t.textContent.trim(); });
    }
    function addOther(text) {
      text = text.trim().slice(0, 60);
      if (!text || others().indexOf(text) >= 0) return;
      chips.appendChild(chip("other", text, msg("other-tag")));
      other.value = others().join("، ");
      changed(other);
    }
    function remove(c) {
      var kind = c.getAttribute("data-ubox-chip");
      c.remove();
      if (kind === "place") {
        compound.value = "";
        setSelect(areaSel, ""); setSelect(subSel, "");
        setContext([]);
        warn.hidden = true;
        openNew(false);
      }
      if (kind === "other") other.value = others().join("، ");
      changed();
      input.focus();
    }
    var live = document.createElement("span");
    live.className = "sr-only"; live.setAttribute("role", "status");
    box.appendChild(live);
    function announce(t) { live.textContent = t; }

    // ---- the suggestion list ----
    function close() { list.hidden = true; list.innerHTML = ""; items = []; at = -1; input.removeAttribute("aria-activedescendant"); }
    function mark(n) {
      var opts = list.querySelectorAll("[role=option]");
      at = Math.max(-1, Math.min(opts.length - 1, n));
      for (var i = 0; i < opts.length; i++) opts[i].setAttribute("aria-selected", i === at ? "true" : "false");
      if (opts[at]) { input.setAttribute("aria-activedescendant", opts[at].id); opts[at].scrollIntoView({ block: "nearest" }); }
    }
    function render(q, found) {
      list.innerHTML = "";
      items = [];
      var group = function (title) { var g = document.createElement("div"); g.className = "ubox-group"; g.textContent = title; list.appendChild(g); };
      var add = function (it, label, sub, cls) {
        var b = document.createElement("button");
        b.type = "button"; b.setAttribute("role", "option"); b.id = "ubox-opt-" + items.length; b.className = "ubox-opt " + (cls || "");
        b.setAttribute("data-i", String(items.length));
        var main = document.createElement("strong"); main.textContent = label; b.appendChild(main);
        if (sub) { var s = document.createElement("span"); s.textContent = sub; b.appendChild(s); }
        list.appendChild(b);
        items.push(it);
      };
      var places = found.filter(function (it) { return it.kind !== "feature"; });
      var feats = found.filter(function (it) { return it.kind === "feature" && !hasFeature(it.key); });
      if (places.length) group(msg("places"));
      places.forEach(function (it) { add(it, it.label || it.name_ar || it.name_en, [it.path].concat(it.zones || []).filter(Boolean).join(" · ")); });
      if (feats.length) group(msg("features"));
      feats.forEach(function (it) { add(it, it.label, ""); });
      if (!box.hasAttribute("data-no-new")) add({ kind: "request", text: q }, msg("request", q), "", "ubox-act");
      add({ kind: "other", text: q }, msg("other", q), "", "ubox-act");
      list.hidden = false;
      mark(0);
    }
    function choose(it) {
      if (!it) return;
      if (it.kind === "feature") addFeature(it.key, it.label);
      else if (it.kind === "request") requestNew(it.text);
      else if (it.kind === "other") addOther(it.text);
      else pickPlace(it);
      input.value = "";
      close();
      input.focus();
    }
    function ask(q) {
      asked = q;
      fetch("/app/places/box?q=" + encodeURIComponent(q) + (box.hasAttribute("data-areas-only") ? "&scope=areas" : ""), { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : { items: [] }; })
        .catch(function () { return { items: [] }; })
        .then(function (d) { if (asked === q && input.value.trim() === q) render(q, d.items || []); });
    }

    // ---- a pasted message: its place (when none is set) and its features become chips ----
    function readMessage(text) {
      var token = form.querySelector('input[name="_csrf"]');
      var body = new URLSearchParams();
      body.set("text", text.slice(0, 4000));
      return fetch("/app/places/box/resolve", { method: "POST", body: body, credentials: "same-origin", headers: { Accept: "application/json", "X-CSRF-Token": token ? token.value : "" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (d) {
          if (!d) return;
          if (d.place && !placeChip()) pickPlace(d.place);
          (d.features || []).forEach(function (f) { addFeature(f.key, f.label); });
          // The two drop-downs fill from the message only while they are empty.
          ["furnishing", "finishing"].forEach(function (n) {
            var sel = form.querySelector('select[name="' + n + '"]');
            if (!d[n] || !sel || sel.value) return;
            sel.value = d[n];
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          });
        });
    }

    // A garden or roof area in the size step is the feature too.
    [["garden_area", "private_garden"], ["roof_area", "roof"]].forEach(function (p) {
      var src = form.querySelector('[name="' + p[0] + '"][data-feature-label]');
      if (!src) return;
      src.addEventListener("input", function () {
        if (Number(src.value) > 0) addFeature(p[1], src.getAttribute("data-feature-label"));
      });
    });

    function removeFeature(key) {
      var c = chips.querySelector('[data-ubox-chip="feature"][data-key="' + key + '"]');
      if (!c) return;
      c.remove();
      changed();
    }

    // The fitted kitchen and ACs features and the Furnishing field are one fact: a change in either shows in the other.
    // kitchen + AC = "kitchen and AC", AC only, kitchen only; "furnished" and "semi-furnished" already mean more, so they stay.
    var furn = form.querySelector("select[data-feature-sync]");
    if (furn) {
      var KITCHEN = "kitchen_installed", AC = "ac_installed";
      var HALF = { kitchen_and_ac: [1, 1], ac_only: [0, 1], kitchen_only: [1, 0] };
      var busy = false;
      var prev = furn.value;
      var sync = function (fn) { if (busy) return; busy = true; try { fn(); } finally { busy = false; prev = furn.value; } };
      var setFurn = function (v) { if (furn.value !== v) { furn.value = v; furn.dispatchEvent(new Event("change", { bubbles: true })); } };
      // Features changed: the field follows (only while it is empty, unfurnished or one of the three kitchen/AC statuses).
      new MutationObserver(function () {
        sync(function () {
          var k = hasFeature(KITCHEN), a = hasFeature(AC), cur = furn.value;
          if (cur === "furnished" || cur === "semi_furnished") return;
          var next = k && a ? "kitchen_and_ac" : a ? "ac_only" : k ? "kitchen_only" : HALF[cur] ? "" : cur;
          setFurn(next);
        });
      }).observe(chips, { childList: true });
      // The field changed: the two features follow.
      furn.addEventListener("change", function () {
        sync(function () {
          var v = furn.value, want = HALF[v];
          if (want) {
            if (want[0]) addFeature(KITCHEN, furn.getAttribute("data-kitchen-label")); else removeFeature(KITCHEN);
            if (want[1]) addFeature(AC, furn.getAttribute("data-ac-label")); else removeFeature(AC);
          } else if (v === "unfurnished" || (v === "" && HALF[prev])) {
            removeFeature(KITCHEN);
            removeFeature(AC);
          }
        });
      });
    }

    // Other scripts on the page (the project form's reader) set the box's chips through these.
    box.uboxApi = { pickPlace: pickPlace, addFeature: addFeature, removeFeature: removeFeature, hasPlace: function () { return Boolean(placeChip()); } };

    input.addEventListener("input", function () {
      var q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { close(); return; }
      timer = setTimeout(function () { ask(q); }, 180);
    });
    input.addEventListener("paste", function (e) {
      var text = (e.clipboardData || window.clipboardData).getData("text");
      if (!text || text.length < LONG) return;
      e.preventDefault();
      readMessage(text);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (list.hidden) return;
        e.preventDefault();
        mark(at + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Enter") {
        // Enter never submits the form from the box: it picks the marked suggestion.
        e.preventDefault();
        if (!list.hidden && items[at]) choose(items[at]);
      } else if (e.key === "Escape") {
        close();
      } else if (e.key === "Backspace" && !input.value) {
        var all = chips.querySelectorAll("[data-ubox-chip]");
        if (all.length) remove(all[all.length - 1]);
      }
    });
    list.addEventListener("mousedown", function (e) { e.preventDefault(); }); // keep the focus in the box
    list.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-i]");
      if (b) choose(items[Number(b.getAttribute("data-i"))]);
    });
    input.addEventListener("blur", function () { setTimeout(close, 150); });
    chips.addEventListener("click", function (e) {
      var x = e.target.closest && e.target.closest("[data-ubox-remove]");
      if (x) remove(x.closest("[data-ubox-chip]"));
    });
    field.addEventListener("click", function (e) { if (e.target === field) input.focus(); });
    // The new compound's name is the chip's name.
    newName.addEventListener("input", function () {
      var c = placeChip();
      compound.value = newName.value.trim();
      if (c) c.querySelector("[data-chip-text]").textContent = newName.value.trim();
    });
    box.querySelector("[data-ubox-new-cancel]").addEventListener("click", function () {
      var c = placeChip();
      if (c) remove(c);
    });
    // The message box above: once the broker pastes or leaves it, the place and features it names fill the box (free).
    var source = form.querySelector("[data-ubox-source]");
    if (source) {
      var lastRead = "";
      var readSource = function () {
        var t = source.value.trim();
        if (t.length < LONG || t === lastRead) return;
        lastRead = t;
        readMessage(t);
      };
      source.addEventListener("paste", function () { setTimeout(readSource, 0); });
      source.addEventListener("change", readSource);
    }
  }

  // Other pages (the import review and its Edit windows) wire the box of their own form.
  window.UnitBox = { init: init };
  init(document.getElementById("unit-form") || document.getElementById("project-form"));
  // The form comes back whole after "fill from the message" (htmx swap): wire the new box.
  document.addEventListener("htmx:load", function (e) {
    var t = e.target;
    init(t && t.id === "unit-form" ? t : t && t.querySelector && t.querySelector("#unit-form"));
  });
})();
