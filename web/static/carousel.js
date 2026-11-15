// web/static/carousel.js — A link that points into a closed section of the unit page (#share, #private, #lease) opens it first.
// (The photo carousel itself needs no script: web/views/carousel.js.)
(function () {
  "use strict";
  function openTarget() {
    var el = location.hash.length > 1 && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    for (var d = el && el.closest && el.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) d.open = true;
  }
  openTarget();
  window.addEventListener("hashchange", openTarget);
})();
