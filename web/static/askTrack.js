// web/static/askTrack.js — Tells the server what the broker did after a project search (Ask results): changed a filter or sort, removed a chip, turned the page,
// opened or sent a project. One small request per click (navigator.sendBeacon), so the click itself is never slowed or blocked; nothing here changes the page.
(function () {
  "use strict";
  var me = document.currentScript;
  var log = me && me.getAttribute("data-log");
  if (!log) return;
  var meta = document.querySelector('meta[name="csrf-token"]');
  function send(action, detail) {
    var body = new URLSearchParams();
    body.set("sl", log); body.set("action", action); body.set("detail", detail || "");
    if (meta) body.set("_csrf", meta.content);
    try {
      if (navigator.sendBeacon) navigator.sendBeacon("/app/ask/action", body);
      else fetch("/app/ask/action", { method: "POST", body: body, credentials: "same-origin", keepalive: true });
    } catch (e) { /* tracking never breaks the page */ }
  }
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-track]");
    if (!el || el.tagName === "FORM" || el.tagName === "NAV") {
      var nav = e.target.closest && e.target.closest("nav[data-track='page'] a");
      if (nav) send("page", nav.textContent.trim());
      return;
    }
    send(el.getAttribute("data-track"), el.getAttribute("data-detail"));
  });
  var filters = document.querySelector("form[data-track='filter']");
  if (filters) filters.addEventListener("submit", function () { send("filter", ""); });
})();
