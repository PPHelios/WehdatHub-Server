// web/static/chatreview.js — The chat import review: a unit never ends up with more than 15 photos. Ticking a photo to
// keep when the unit is full is undone with a short note; ticking an existing photo to remove makes room.
(function () {
  "use strict";
  var lang = document.documentElement.lang === "en" ? "en" : "ar";
  var MSG = { ar: "الوحدة وصلت 15 صورة. شيل صورة قديمة أو الغي علامة صورة تانية.", en: "The unit is at 15 photos. Remove an old photo or untick another one." };
  // The edit window of a unit: a dialog opened by its Edit button (also used by the plain Excel plan page).
  document.addEventListener("click", function (ev) {
    var open = ev.target.closest && ev.target.closest("[data-edit-open]");
    var close = ev.target.closest && ev.target.closest("[data-edit-close]");
    if (open) {
      var dlg = document.querySelector('[data-edit-dialog="' + open.getAttribute("data-edit-open") + '"]');
      var uform = dlg && dlg.querySelector("[data-unit-edit-form]");
      if (uform && window.UnitBox) window.UnitBox.init(uform);
      if (dlg && dlg.showModal) dlg.showModal();
      else if (dlg) dlg.setAttribute("open", "");
    } else if (close) {
      var d = close.closest("dialog");
      if (d && d.close) d.close();
    }
  });
  // Saving an edit re-plans the import and reloads the page: send the photo ticks and their order along so they are kept.
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    var m = form && form.id && /^edit-(\d+)$/.exec(form.id);
    if (!m) return;
    var row = m[1];
    var add = function (name, value) {
      var input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    };
    var inputs = document.querySelectorAll('input[name="keep_' + row + '"]');
    if (!inputs.length) return;
    Array.prototype.forEach.call(inputs, function (c) {
      add("order_" + row, c.value);
      if (c.checked) add("keep_" + row, c.value);
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="drop_' + row + '"]:checked'), function (c) { add("drop_" + row, c.value); });
  });
  // Moving a photo to another unit submits the page: send every unit's photo ticks and order along so they are kept.
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest && ev.target.closest("[data-photo-move]");
    if (!b || !b.form) return;
    var form = b.form;
    Array.prototype.forEach.call(document.querySelectorAll("[data-photo-pick]"), function (box) {
      var row = box.getAttribute("data-photo-pick");
      Array.prototype.forEach.call(box.querySelectorAll('input[name="keep_' + row + '"]'), function (c) {
        var o = document.createElement("input");
        o.type = "hidden";
        o.name = "order_" + row;
        o.value = c.value;
        form.appendChild(o);
      });
    });
  });
  // Select all / none of the units that can be added.
  document.addEventListener("click", function (ev) {
    var all = ev.target.closest && ev.target.closest("[data-rows-all]");
    var none = ev.target.closest && ev.target.closest("[data-rows-none]");
    if (!all && !none) return;
    Array.prototype.forEach.call(document.querySelectorAll('input[type="checkbox"][name="rows"]'), function (c) { c.checked = Boolean(all); });
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-photo-pick]"), function (box) {
    var max = Number(box.getAttribute("data-max")) || 15;
    var have = Number(box.getAttribute("data-have")) || 0;
    var note = document.createElement("p");
    note.className = "warn";
    note.setAttribute("role", "status");
    note.hidden = true;
    note.textContent = MSG[lang];
    box.appendChild(note);
    box.addEventListener("change", function (ev) {
      var t = ev.target;
      if (!t || t.type !== "checkbox") return;
      var kept = box.querySelectorAll('input[name^="keep_"]:checked').length;
      var dropped = box.querySelectorAll('input[name^="drop_"]:checked').length;
      if (/^keep_/.test(t.name) && t.checked && have - dropped + kept > max) {
        t.checked = false;
        note.hidden = false;
      } else {
        note.hidden = true;
      }
    });
  });
})();
