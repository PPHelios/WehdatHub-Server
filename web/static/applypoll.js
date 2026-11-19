// web/static/applypoll.js — The review page of an Excel import while it is being saved in the background: asks the server
// how far it is every 2 seconds, moves the bar, and reloads the page when the saving is over (or taken up again).
(function () {
  "use strict";
  var box = document.querySelector("[data-apply-poll]");
  if (!box) return;
  var url = box.getAttribute("data-apply-poll");
  var bar = box.querySelector("progress");
  var count = box.querySelector("[data-apply-count]");
  var ar = document.documentElement.lang === "ar";
  var nf = new Intl.NumberFormat(ar ? "ar-EG" : "en");
  var misses = 0;
  function tick() {
    fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("status")); })
      .then(function (s) {
        misses = 0;
        if (s.status !== "applying") { window.location.reload(); return; }
        if (bar && s.total) { bar.max = s.total; bar.value = s.done; }
        if (count && s.total) count.textContent = nf.format(s.done) + " / " + nf.format(s.total);
        setTimeout(tick, 2000);
      })
      .catch(function () { misses++; setTimeout(tick, Math.min(10000, 2000 * (misses + 1))); });
  }
  setTimeout(tick, 1500);
})();
