// domain/projectAnswerLine.js — The answer line above Ask's project results, written from the results themselves (pure, no AI, free), the way add unit
// writes the client description from the unit's fields. It is the second opinion next to the AI's answer and the answer itself when the AI is off or out of
// credit. Every number comes from the results; nothing is added.
"use strict";

const money = (n) => Number(n).toLocaleString("en-US");

/** The lowest price a project card shows: its cheapest fitting offer, else its price from. */
function lowest(card) {
  const prices = [...card.offers.map((o) => o.price), card.price_from].filter((x) => x != null && x > 0);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * @param {{ total_projects: number, total_options: number, projects: Array, chips?: Array }} r the grouped results (services/projectSearch.js)
 * @returns {string} one short paragraph, Arabic or English
 */
function line(r, lang = "ar") {
  const en = lang === "en";
  if (!r || !r.total_projects) {
    return en ? "No project in our data matches this search. Remove a filter or widen the place to see more." : "مفيش مشروع في بياناتنا بالمواصفات دي. شيل فلتر أو وسّع المكان عشان تشوف أكتر.";
  }
  const withUnits = r.projects.filter((p) => p.offers_total > 0).length;
  const priced = r.projects.map((p) => ({ p, from: lowest(p) })).filter((x) => x.from != null).sort((a, b) => a.from - b.from);
  const updated = r.projects.map((p) => new Date(p.updated_at).getTime()).filter((t) => !Number.isNaN(t));
  const day = updated.length ? new Date(Math.max(...updated)).toISOString().slice(0, 10) : null;
  const name = (p) => (en ? p.name_en || p.name : p.name);
  const parts = [en ? `${r.total_projects} project${r.total_projects === 1 ? "" : "s"} match${r.total_projects === 1 ? "es" : ""} this search.` : `${r.total_projects} مشروع مناسب للبحث ده.`];
  if (r.total_options) parts.push(en ? `${r.total_options} unit option${r.total_options === 1 ? "" : "s"} in all.` : `${r.total_options} اختيار وحدات إجمالًا.`);
  if (priced.length) {
    const lo = priced[0];
    const hi = priced[priced.length - 1];
    parts.push(en ? `Prices on this page start from ${money(lo.from)} EGP (${name(lo.p)})${hi !== lo ? ` up to ${money(hi.from)} EGP (${name(hi.p)})` : ""}.` : `الأسعار في الصفحة دي من ${money(lo.from)} جنيه (${name(lo.p)})${hi !== lo ? ` لحد ${money(hi.from)} جنيه (${name(hi.p)})` : ""}.`);
  }
  if (r.projects.length - withUnits > 0) {
    const n = r.projects.length - withUnits;
    parts.push(en ? `${n} on this page ${n === 1 ? "has" : "have"} no unit details yet.` : `${n} في الصفحة دي لسه مفيهاش تفاصيل وحدات.`);
  }
  if (day) parts.push(en ? `Data last updated ${day}. Check before quoting.` : `آخر تحديث للبيانات ${day}. اتأكد قبل ما تقتبس.`);
  return parts.join(" ");
}

module.exports = { line };
