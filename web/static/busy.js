// The busy rule (plan 12): while any server call runs, the control that started it shows its spinner and every other
// button, field, dropdown and button-link on the page is disabled. Restored when the last call ends, on an error, on a
// timeout, and when the page comes back from the back/forward cache. Polling (hx-trigger "every …") and data-no-lock
// elements never lock the page. Pages that use fetch themselves call whBusy.start(trigger) and the returned end().
(function () {
  var SEL = "button, input, select, textarea, a.btn, summary";
  var depth = 0, off = [], timer = null, spun = [];
  function skip(el) { return !el || (el.closest && el.closest("[data-no-lock]")) || (el.getAttribute && /(^|\s)every\s/.test(el.getAttribute("hx-trigger") || "")); }
  function lock(trigger) {
    var all = document.querySelectorAll(SEL);
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === trigger || (trigger && trigger.contains && trigger.contains(el)) || el.hasAttribute("data-busy-off") || el.closest("[data-no-lock]")) continue;
      if (el.tagName === "A" || el.tagName === "SUMMARY") { if (el.getAttribute("aria-disabled") === "true") continue; el.setAttribute("aria-disabled", "true"); el.setAttribute("data-busy-off", "a"); }
      else { if (el.disabled) continue; el.disabled = true; el.setAttribute("data-busy-off", "d"); }
      off.push(el);
    }
    if (trigger && trigger.classList) { trigger.classList.add("busy"); trigger.setAttribute("aria-busy", "true"); spun.push(trigger); }
    document.documentElement.setAttribute("data-busy", "");
  }
  function unlockAll() {
    for (var i = 0; i < off.length; i++) {
      var el = off[i], kind = el.getAttribute("data-busy-off");
      if (kind === "d") el.disabled = false; else el.removeAttribute("aria-disabled");
      el.removeAttribute("data-busy-off");
    }
    off = [];
    for (var j = 0; j < spun.length; j++) { spun[j].classList.remove("busy"); spun[j].removeAttribute("aria-busy"); }
    spun = [];
    document.documentElement.removeAttribute("data-busy");
  }
  function start(trigger) {
    if (skip(trigger)) return function () {};
    var done = false;
    depth += 1;
    if (depth === 1) lock(trigger);
    else if (trigger && trigger.classList) { trigger.classList.add("busy"); spun.push(trigger); }
    clearTimeout(timer);
    timer = setTimeout(function () { depth = 0; unlockAll(); }, 60000); // failsafe: never leave the page locked
    return function end() {
      if (done) return;
      done = true;
      depth = Math.max(0, depth - 1);
      if (depth === 0) { clearTimeout(timer); unlockAll(); }
    };
  }
  window.whBusy = { start: start, active: function () { return depth > 0; } };

  // htmx: one end per request element.
  var ends = typeof WeakMap === "function" ? new WeakMap() : null;
  document.addEventListener("htmx:beforeRequest", function (e) {
    var elt = e.detail && e.detail.elt;
    if (!elt || !ends || skip(elt)) return;
    // setTimeout 0: the request has already collected its fields, so disabling them cannot drop values.
    var end = start(elt.tagName === "FORM" ? (e.detail.requestConfig && e.detail.requestConfig.triggeringEvent && e.detail.requestConfig.triggeringEvent.submitter) || elt.querySelector("button[type=submit], button:not([type])") : elt);
    ends.set(elt, end);
  });
  function finish(e) {
    var elt = e.detail && e.detail.elt;
    var end = elt && ends && ends.get(elt);
    if (end) { end(); ends.delete(elt); }
  }
  ["htmx:afterRequest", "htmx:responseError", "htmx:sendError", "htmx:timeout"].forEach(function (n) { document.addEventListener(n, finish); });

  // Plain form posts (a full page load follows): lock the page at the submit, after the browser has read the fields.
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (e.defaultPrevented || !form || form.hasAttribute("data-no-lock") || form.getAttribute("target") || form.hasAttribute("hx-post") || form.hasAttribute("hx-get")) return;
    if ((form.getAttribute("method") || "get").toLowerCase() !== "post") return;
    var trigger = e.submitter || form.querySelector("button[type=submit], button:not([type])");
    setTimeout(function () { var end = start(trigger); setTimeout(end, 15000); }, 0);
  });
  window.addEventListener("pageshow", function () { depth = 0; unlockAll(); });
})();
