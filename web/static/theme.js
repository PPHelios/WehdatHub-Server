// web/static/theme.js — CSP-safe Light/Dark theme controller shared by the landing page and /app/.
(function () {
  "use strict";
  var root = document.documentElement;
  var mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  function stored() {
    try { return localStorage.getItem("theme") || "system"; } catch (e) { return "system"; }
  }
  function isDark() {
    var attr = root.getAttribute("data-theme");
    if (attr === "dark") return true;
    if (attr === "light") return false;
    return Boolean(mq && mq.matches);
  }
  function syncButtons() {
    var dark = isDark();
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(dark));
    });
  }
  function apply(v) {
    if (v === "light" || v === "dark") root.setAttribute("data-theme", v);
    else root.removeAttribute("data-theme");
    syncButtons();
  }
  apply(stored());
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest && e.target.closest("[data-theme-toggle]");
    if (!btn) return;
    var next = isDark() ? "light" : "dark";
    try { localStorage.setItem("theme", next); } catch (err) {}
    apply(next);
    document.querySelectorAll("[data-theme-set]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-theme-set") === next));
    });
  });
})();
