// web/views/charts.js — Small SVG charts for numbers that change over time (the owner board). No script, no library: the
// bars take their colour from the page tokens (CSS class .chart), so they read in light and dark. Numbers only.
"use strict";

const { html } = require("../html");

/**
 * A bar chart of one number per day.
 * @param {Array<{day: string}>} series  one row per day
 * @param {string} key                  the field to draw
 * @param {Object} o                    { title, lang } — the title is the accessible name and the caption
 */
function bars(series, key, { title = "", lang = "en" } = {}) {
  const values = (series || []).map((r) => Number(r[key]) || 0);
  if (!values.length) return html`<p class="muted">${lang === "en" ? "No data in this period." : "مفيش بيانات في الفترة دي."}</p>`;
  const max = Math.max(1, ...values);
  const W = 300, H = 80, gap = 2, bw = Math.max(2, W / values.length - gap);
  const total = values.reduce((a, b) => a + b, 0);
  const rects = values.map((v, i) => {
    const h = Math.max(v ? 2 : 0, Math.round((v / max) * (H - 4)));
    return html`<rect class="bar" x="${Math.round(i * (bw + gap))}" y="${H - h}" width="${Math.round(bw)}" height="${h}" rx="1"><title>${series[i].day}: ${v}</title></rect>`;
  });
  return html`<figure class="chart" data-chart="${key}"><figcaption><b>${title}</b> <span class="muted">${total.toLocaleString("en-US")}</span></figcaption>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}" preserveAspectRatio="none" dir="ltr">${rects}</svg>
<div class="chart-axis muted small" dir="ltr"><span>${series[0].day.slice(5)}</span><span>${series[series.length - 1].day.slice(5)}</span></div></figure>`;
}

module.exports = { bars };
