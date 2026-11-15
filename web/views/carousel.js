// web/views/carousel.js — The photo carousel of a unit: swipe, or use the arrows. Used by the unit page and the client link, so
// both show the photos the same way. It needs no script (the client link has none): each photo carries its own arrows, which
// are links to the neighbouring photo, and the track snaps to one photo at a time.
"use strict";

const { html } = require("../html");

function carousel(srcs = [], lang = "ar") {
  if (!srcs.length) return "";
  const en = lang === "en";
  const n = srcs.length;
  const arrow = (to, cls, label, d) => html`<a class="car-btn ${cls}" href="#car-${to}" aria-label="${label}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg></a>`;
  return html`<div class="car" role="region" aria-roledescription="carousel" aria-label="${en ? "Photos" : "الصور"}">
  <div class="car-track" tabindex="0">${srcs.map(
    (src, i) => html`<figure class="car-slide" id="car-${i + 1}"><img src="${src}" alt="" ${i === 0 ? html`fetchpriority="high"` : html`loading="lazy"`}>${n > 1
      ? html`${i > 0 ? arrow(i, "car-prev", en ? "Previous photo" : "الصورة اللي قبلها", "M15 6l-6 6 6 6") : ""}${i < n - 1 ? arrow(i + 2, "car-next", en ? "Next photo" : "الصورة اللي بعدها", "M9 6l6 6-6 6") : ""}<span class="car-count">${i + 1} / ${n}</span>`
      : ""}</figure>`
  )}</div>
</div>`;
}

module.exports = { carousel };
