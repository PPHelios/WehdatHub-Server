// web/static/projectForm.js — The add/edit project form: "Read the message" (POST /app/catalogue/projects/read, free, nothing saved) fills the
// name, developer, place, features and numbers for the broker to check; the developer box searches the agency's list (GET
// /app/catalogue/developers/suggest) or keeps a new name. The place and features are the unit box's (unitBox.js).
(function () {
  "use strict";

  function init(form) {
    if (!form || form.hasAttribute("data-pf-on")) return;
    form.setAttribute("data-pf-on", "");
    var msg = function (k, s) { return (form.getAttribute("data-msg-" + k) || "").replace("%s", s || ""); };
    var labels = {};
    try { labels = JSON.parse(form.getAttribute("data-labels") || "{}"); } catch (e) { labels = {}; }
    var source = form.querySelector("[data-project-source]");
    var readBtn = form.querySelector("[data-project-read]");
    var found = form.querySelector("[data-project-found]");
    var known = form.querySelector("[data-project-known]");
    var token = function () { var t = form.querySelector('input[name="_csrf"]'); return t ? t.value : ""; };
    var field = function (name) { return form.querySelector('[name="' + name + '"]'); };
    var changed = function (el) { if (el) el.dispatchEvent(new Event("change", { bubbles: true })); };

    function setValue(name, value) {
      var el = field(name);
      if (!el || value === null || value === undefined || value === "") return false;
      el.value = value;
      el.classList.add("pf-filled");
      changed(el);
      return true;
    }
    function setChecks(name, values) {
      var on = (values || []).map(String);
      Array.prototype.forEach.call(form.querySelectorAll('input[type="checkbox"][name="' + name + '"]'), function (c) {
        if (on.indexOf(c.value) >= 0) c.checked = true;
      });
    }

    // ---- the developer box ----
    var dev = form.querySelector("[data-devbox]");
    var devInput = dev && dev.querySelector("[data-dev-input]");
    var devList = dev && dev.querySelector("[data-dev-list]");
    var devId = dev && dev.querySelector("[data-dev-id]");
    var devNew = dev && dev.querySelector("[data-dev-new]");
    var devGlobal = dev && dev.querySelector("[data-dev-global]");
    var devState = dev && dev.querySelector("[data-dev-state]");
    var timer = null;
    function showState(text) {
      if (!devState) return;
      devState.hidden = !text;
      devState.querySelector("[data-dev-state-text]").textContent = text || "";
    }
    function chooseDeveloper(d) {
      devId.value = d.id || "";
      devGlobal.value = d.global_id || "";
      devNew.value = d.id || d.global_id ? "" : d.name;
      devInput.value = d.name;
      showState(d.id || d.global_id ? d.name : d.name + " (" + msg("new") + ")");
      devList.hidden = true;
      devList.innerHTML = "";
    }
    function renderDevs(q, items) {
      devList.innerHTML = "";
      items.forEach(function (d) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "ubox-opt"; b.setAttribute("role", "option");
        var s = document.createElement("strong"); s.textContent = d.name; b.appendChild(s);
        if (d.name_en) { var e = document.createElement("span"); e.textContent = d.name_en; b.appendChild(e); }
        b.addEventListener("click", function () { chooseDeveloper(d); });
        devList.appendChild(b);
      });
      var exact = items.some(function (d) { return d.name.toLowerCase() === q.toLowerCase(); });
      if (!exact) {
        var add = document.createElement("button");
        add.type = "button"; add.className = "ubox-opt ubox-act"; add.setAttribute("role", "option");
        var t = document.createElement("strong"); t.textContent = msg("add", q); add.appendChild(t);
        add.addEventListener("click", function () { chooseDeveloper({ name: q }); });
        devList.appendChild(add);
      }
      devList.hidden = false;
    }
    if (devInput) {
      devInput.addEventListener("input", function () {
        var q = devInput.value.trim();
        devId.value = ""; devGlobal.value = ""; devNew.value = q; showState(q ? q + " (" + msg("new") + ")" : "");
        clearTimeout(timer);
        if (q.length < 1) { devList.hidden = true; return; }
        timer = setTimeout(function () {
          fetch(dev.getAttribute("data-url") + "?q=" + encodeURIComponent(q), { credentials: "same-origin", headers: { Accept: "application/json" } })
            .then(function (r) { return r.ok ? r.json() : { items: [] }; })
            .catch(function () { return { items: [] }; })
            .then(function (d) { if (devInput.value.trim() === q) renderDevs(q, d.items || []); });
        }, 150);
      });
      devInput.addEventListener("focus", function () {
        if (devInput.value.trim()) return;
        fetch(dev.getAttribute("data-url") + "?q=", { credentials: "same-origin", headers: { Accept: "application/json" } })
          .then(function (r) { return r.ok ? r.json() : { items: [] }; })
          .then(function (d) { if (!devInput.value.trim() && (d.items || []).length) renderDevs("", d.items); })
          .catch(function () {});
      });
      devInput.addEventListener("blur", function () { setTimeout(function () { devList.hidden = true; }, 150); });
      devInput.addEventListener("keydown", function (e) { if (e.key === "Enter") e.preventDefault(); });
    }

    // ---- reading the message ----
    function apply(d) {
      var box = form.querySelector("[data-ubox]");
      var api = box && box.uboxApi;
      if (d.existing) {
        known.hidden = false;
        known.textContent = "";
        var a = document.createElement("a");
        a.href = "/app/catalogue/projects/" + d.existing.id; a.textContent = msg("open");
        known.appendChild(document.createTextNode(msg("known") + ": " + d.existing.name + " · "));
        known.appendChild(a);
      } else known.hidden = true;
      if (d.name && !(field("name").value || "").trim()) setValue("name", d.name);
      if (d.name_en && !(field("name_en").value || "").trim()) setValue("name_en", d.name_en);
      if (d.developer && !(devInput.value || "").trim()) chooseDeveloper(d.developer);
      if (api) {
        if (d.place && !api.hasPlace()) api.pickPlace(d.place);
        (d.features || []).forEach(function (f) { api.addFeature(f.key, f.label); });
      }
      var f = d.fields || {};
      ["price_from", "area_acres", "down_pct_min", "years_max", "discount_pct", "delivery_raw", "delivery_year"].forEach(function (k) {
        var el = field(k);
        if (el && !String(el.value || "").trim()) setValue(k, f[k]);
      });
      if (f.status === "launching" && field("status")) setValue("status", "launching");
      setChecks("bedrooms", f.bedrooms);
      setChecks("property_types", f.property_types);
    }
    function summary(d) {
      var names = (d.found || []).map(function (k) { return labels[k] || k; });
      found.textContent = names.length ? msg("read") + ": " + names.join("، ") + ". " + msg("check") : msg("none");
    }
    function read() {
      var text = (source.value || "").trim();
      if (!text) return;
      var body = new URLSearchParams();
      body.set("text", text.slice(0, 8000));
      readBtn.disabled = true;
      fetch("/app/catalogue/projects/read", { method: "POST", body: body, credentials: "same-origin", headers: { Accept: "application/json", "X-CSRF-Token": token() } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (d) {
          readBtn.disabled = false;
          if (!d) { found.textContent = msg("none"); return; }
          apply(d);
          summary(d);
        });
    }
    if (readBtn && source) {
      readBtn.addEventListener("click", read);
      // A long paste is a message to read: do it at once (the broker still checks everything).
      source.addEventListener("paste", function () { setTimeout(function () { if ((source.value || "").trim().length > 40) read(); }, 0); });
    }
  }

  init(document.getElementById("project-form"));
})();
