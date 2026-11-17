// web/static/wordfields.js — The Excel review's "unknown words" panel: each word picks the field it belongs to (unit type,
// compound, floor, finishing, furnishing, features, notes, ignore) and shows only that field's value control. The compound
// value is searched in the approved list (the same /app/places/suggest the add form uses), with the suggestions in a list, so a
// compound is picked, not typed (no misspelling).
(function () {
  "use strict";
  function sync(form) {
    var pick = form.querySelector("[data-word-field]");
    if (!pick) return;
    var field = pick.value;
    var boxes = form.querySelectorAll("[data-word-val]");
    for (var i = 0; i < boxes.length; i++) {
      var show = boxes[i].getAttribute("data-word-val") === field;
      boxes[i].hidden = !show;
      var inputs = boxes[i].querySelectorAll("input, select");
      for (var k = 0; k < inputs.length; k++) inputs[k].disabled = !show;
    }
  }
  function suggest(input) {
    var list = document.getElementById(input.getAttribute("list"));
    var timer = null;
    var last = "";
    input.addEventListener("input", function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2 || q === last) return;
      timer = setTimeout(function () {
        last = q;
        fetch("/app/places/suggest?q=" + encodeURIComponent(q), { credentials: "same-origin", headers: { Accept: "application/json" } })
          .then(function (r) { return r.ok ? r.json() : { items: [] }; })
          .then(function (d) {
            if (!list) return;
            list.innerHTML = "";
            (d.items || []).filter(function (x) { return x.kind === "compound"; }).forEach(function (x) {
              var o = document.createElement("option");
              o.value = x.name_en || x.name_ar || x.label;
              o.label = x.label + (x.path ? " · " + x.path : "");
              list.appendChild(o);
            });
          })
          .catch(function () {});
      }, 200);
    });
  }
  function init() {
    var forms = document.querySelectorAll("[data-word-form]");
    for (var i = 0; i < forms.length; i++) {
      (function (form) {
        var pick = form.querySelector("[data-word-field]");
        if (pick) pick.addEventListener("change", function () { sync(form); });
        sync(form);
        var s = form.querySelector("[data-place-search]");
        if (s) suggest(s);
      })(forms[i]);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
