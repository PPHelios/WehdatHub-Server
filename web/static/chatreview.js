// web/static/chatreview.js — The chat import review: a unit never ends up with more than 15 photos. Ticking a photo to
// keep when the unit is full is undone with a short note; ticking an existing photo to remove makes room.
(function () {
  "use strict";
  var lang = document.documentElement.lang === "en" ? "en" : "ar";
  var MSG = { ar: "الوحدة وصلت 15 صورة. شيل صورة قديمة أو الغي علامة صورة تانية.", en: "The unit is at 15 photos. Remove an old photo or untick another one." };
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
