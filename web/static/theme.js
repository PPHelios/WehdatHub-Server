// web/static/theme.js — CSP-safe Light/Dark theme controller shared by the landing page and /app/.
// Loaded in <head> without defer so data-theme is set before first paint: nothing here may touch the body at parse time.
(function () {
  "use strict";
  var root = document.documentElement;
  var mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  function stored() {
    try { return localStorage.getItem("theme") || "system"; } catch (e) { return "system"; }
  }
  // Inside Telegram's Mini App the Telegram theme wins over the phone's (app.js sets data-theme from it).
  function inTelegram() {
    if (/tgWebAppThemeParams=/.test(location.hash)) return true;
    try { return Boolean(sessionStorage.getItem("tgTheme")); } catch (e) { return false; }
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
    else if (!inTelegram()) root.setAttribute("data-theme", mq && mq.matches ? "dark" : "light");
    if (document.readyState !== "loading") syncButtons();
  }
  window.whTheme = { apply: apply };
  apply(stored());
  // "System" follows the phone live.
  if (mq && mq.addEventListener) mq.addEventListener("change", function () { if (stored() === "system") apply("system"); });
  document.addEventListener("DOMContentLoaded", syncButtons);
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
