// web/static/carousel.js — Photo carousel: a swipe past the first or last photo loops round to the other end (the track
// itself only scrolls and snaps, so it cannot loop alone). Also: a link that points into a closed section of the unit page
// (#share, #private, #lease) opens it first.
(function () {
  "use strict";
  function openTarget() {
    var el = location.hash.length > 1 && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    for (var d = el && el.closest && el.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) d.open = true;
  }
  openTarget();
  window.addEventListener("hashchange", openTarget);

  function loop(track) {
    var x0, y0, at = -1;
    track.addEventListener("touchstart", function (e) {
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      at = Math.round(Math.abs(track.scrollLeft) / (track.clientWidth || 1)); // the photo showing before the finger moves
    }, { passive: true });
    track.addEventListener("touchend", function (e) {
      var t = e.changedTouches[0], dx = t.clientX - x0, slides = track.querySelectorAll(".car-slide");
      if (at < 0 || slides.length < 2 || Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(t.clientY - y0)) return;
      // Next is to the left of the finger in LTR, to the right in RTL (Arabic).
      var next = getComputedStyle(track).direction === "rtl" ? dx > 0 : dx < 0;
      var to = next && at === slides.length - 1 ? slides[0] : !next && at === 0 ? slides[slides.length - 1] : null;
      if (to) to.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
    }, { passive: true });
  }
  Array.prototype.forEach.call(document.querySelectorAll(".car-track"), loop);
})();
