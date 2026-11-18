// web/static/saveBar.js — "Unsaved changes" bar for forms marked data-savebar (progressive enhancement: the form's own Save button keeps working).
// A form is dirty when its serialized fields differ from the snapshot taken at load (so putting a value back clears it).
// Texts come from the form: data-savebar-text, -save, -discard, -name (optional section name), -leave (confirm message).
(function () {
  var forms = Array.prototype.slice.call(document.querySelectorAll("form[data-savebar]"));
  var bar = null, last = null, textEl = null, saving = false;
  var initial = new WeakMap();

  function snap(form) {
    var parts = [];
    new FormData(form).forEach(function (v, k) { parts.push(k + "=" + (typeof v === "string" ? v : "[file]")); });
    return parts.join("&");
  }
  function isDirty(form) { return snap(form) !== initial.get(form); }
  function anyDirty() { return !saving && forms.some(isDirty); }
  function attr(form, name, fallback) { return (form && form.getAttribute("data-savebar-" + name)) || fallback; }

  function build() {
    bar = document.createElement("div");
    bar.className = "savebar";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");
    bar.hidden = true;
    textEl = document.createElement("span");
    textEl.className = "savebar-text";
    var actions = document.createElement("span");
    actions.className = "savebar-actions";
    var discard = document.createElement("button");
    discard.type = "button"; discard.className = "secondary"; discard.setAttribute("data-savebar-act", "discard");
    var save = document.createElement("button");
    save.type = "button"; save.setAttribute("data-savebar-act", "save");
    actions.appendChild(discard); actions.appendChild(save);
    bar.appendChild(textEl); bar.appendChild(actions);
    document.body.appendChild(bar);
    discard.addEventListener("click", function () {
      var form = last;
      if (!form) return;
      form.reset();
      Array.prototype.forEach.call(form.elements, function (el) { if (el.name) el.dispatchEvent(new Event("change", { bubbles: true })); });
      refresh();
      setTimeout(refresh, 0); // dependent controls (app.js handlers) settle first
    });
    save.addEventListener("click", function () {
      if (!last) return;
      saving = true;
      if (typeof last.requestSubmit === "function") last.requestSubmit(); else last.submit();
      // A refused submit (validation) leaves the page: dirty again.
      setTimeout(function () { saving = false; }, 0);
    });
  }

  function refresh() {
    if (!bar) build();
    var dirty = forms.filter(isDirty);
    if (!dirty.length) { bar.hidden = true; return; }
    if (!last || dirty.indexOf(last) < 0) last = dirty[dirty.length - 1];
    var name = attr(last, "name", "");
    textEl.textContent = attr(last, "text", "Unsaved changes") + (name ? " · " + name : "");
    bar.querySelector('[data-savebar-act="save"]').textContent = attr(last, "save", "Save");
    bar.querySelector('[data-savebar-act="discard"]').textContent = attr(last, "discard", "Discard");
    bar.hidden = false;
  }

  if (forms.length) {
    forms.forEach(function (form) {
      initial.set(form, snap(form));
      // Defer the check: document-level handlers (app.js) enable/disable dependent controls after this form listener runs.
      var onEdit = function () { last = form; setTimeout(function () { last = form; refresh(); }, 0); };
      form.addEventListener("input", onEdit);
      form.addEventListener("change", onEdit);
      form.addEventListener("submit", function () { saving = true; });
    });
    // Same conventions as the unit form (app.js): warn on leaving while dirty; window.__whSaved turns it off.
    window.addEventListener("beforeunload", function (e) { if (anyDirty() && !window.__whSaved) { e.preventDefault(); e.returnValue = ""; } });
    // In-page links (the settings section tabs and other # links) do not unload the page: ask here.
    document.addEventListener("click", function (e) {
      if (!anyDirty() || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest("a[href]");
      if (!a || (bar && bar.contains(a)) || a.getAttribute("target") === "_blank") return;
      var href = a.getAttribute("href") || "";
      if (href.charAt(0) !== "#" && !a.closest("[data-settings-nav]")) return; // other pages: beforeunload asks
      var dirty = forms.filter(isDirty);
      var msg = attr(dirty[dirty.length - 1], "leave", "You have unsaved changes. Leave anyway?");
      if (!window.confirm(msg)) e.preventDefault();
    }, true);
    // After a save: bring the "Saved" notice into view.
    var ok = document.querySelector(".notice.ok[role=status]");
    if (ok && /[?&]saved=1/.test(location.search)) {
      ok.setAttribute("tabindex", "-1");
      try { ok.scrollIntoView({ block: "start" }); ok.focus({ preventScroll: true }); } catch (e) {}
    }
  }
})();
