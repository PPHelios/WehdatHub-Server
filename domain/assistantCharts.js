// domain/assistantCharts.js — Pure builders for the assistant's chart cards (trend, share, price_range, compare).
// Data in, plain JSON out. Every card carries a bilingual-aware text `summary` (accessibility + share). No AI, no DB.
"use strict";

const n0 = (x) => Math.round(Number(x) || 0);
const fmt = (x) => n0(x).toLocaleString("en-US");
const pick = (en, ar, e) => (en ? e : ar);

/** "rising" / "falling" / "flat": the last point against the average of the points before it (±10% counts as flat). */
function trendDirection(values) {
  const v = values.map(Number).filter(Number.isFinite);
  if (v.length < 3) return { direction: "flat", changePct: null };
  const prev = v.slice(0, -1);
  const avg = prev.reduce((s, x) => s + x, 0) / prev.length;
  if (!(avg > 0)) return { direction: v[v.length - 1] > 0 ? "rising" : "flat", changePct: null };
  const changePct = Math.round(((v[v.length - 1] - avg) * 100) / avg);
  return { direction: changePct > 10 ? "rising" : changePct < -10 ? "falling" : "flat", changePct };
}

const DIR_LABEL = { rising: ["في صعود", "Rising"], falling: ["في نزول", "Falling"], flat: ["ثابت", "Flat"] };

function trendCard({ title, points, en, link = null }) {
  const pts = (points || []).map((p) => ({ label: String(p.label ?? ""), value: Number(p.value) || 0 }));
  if (pts.length < 2) return null;
  const { direction, changePct } = trendDirection(pts.map((p) => p.value));
  const directionLabel = DIR_LABEL[direction][en ? 1 : 0];
  const last = pts[pts.length - 1];
  return {
    kind: "trend",
    title,
    points: pts,
    direction,
    directionLabel,
    changePct,
    summary: `${title}: ${directionLabel}${changePct == null ? "" : ` (${changePct > 0 ? "+" : ""}${changePct}%)`} · ${pick(en, "آخر قيمة", "latest")} ${fmt(last.value)}`,
    ...(link ? { link } : {})
  };
}

function shareCard({ title, parts, en, link = null }) {
  const clean = (parts || []).map((p) => ({ key: String(p.key ?? p.label), label: String(p.label), value: Number(p.value) || 0 })).filter((p) => p.value > 0);
  const total = clean.reduce((s, p) => s + p.value, 0);
  if (!total || clean.length < 2) return null;
  const withPct = clean.map((p) => ({ ...p, pct: Math.round((p.value * 100) / total) }));
  return {
    kind: "share",
    title,
    total,
    parts: withPct,
    summary: `${title}: ${withPct.map((p) => `${p.label} ${p.pct}%`).join(en ? ", " : "، ")}`,
    ...(link ? { link } : {})
  };
}

/** Histogram of EGP prices (up to `bins` equal-width buckets) with the median and an optional client budget marker. */
function priceRangeCard({ title, place, prices, budget = null, en, bins = 6, link = null }) {
  const v = (prices || []).map(Number).filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length < 3) return null;
  const min = v[0];
  const max = v[v.length - 1];
  const step = (max - min) / bins || 1;
  const buckets = Array.from({ length: bins }, (_, i) => ({ from: Math.round(min + i * step), to: Math.round(min + (i + 1) * step), count: 0 }));
  for (const x of v) buckets[Math.min(bins - 1, Math.floor((x - min) / step))].count += 1;
  const median = v[Math.floor((v.length - 1) / 2)];
  const b = Number(budget) > 0 ? { value: Number(budget), label: `${pick(en, "ميزانية العميل", "Client budget")} ${(Number(budget) / 1e6).toFixed(1).replace(/\.0$/, "")}${pick(en, "م", "M")}` } : null;
  return {
    kind: "price_range",
    title,
    place: place || null,
    unit: "EGP",
    units: v.length,
    min,
    max,
    median,
    bins: buckets,
    ...(b ? { budget: b } : {}),
    summary: `${title}: ${fmt(min)} – ${fmt(max)} EGP, ${pick(en, "الوسيط", "median")} ${fmt(median)} (${v.length} ${pick(en, "وحدة", "units")})${b ? ` · ${b.label}` : ""}`,
    ...(link ? { link } : {})
  };
}

/** 2–3 units side by side. Best value per row (lowest price, largest area, lowest price/m²) flagged by column index. */
function compareCard({ units, en, link = null }) {
  const list = (units || []).slice(0, 3);
  if (list.length < 2) return null;
  const cur = (u) => String(u.currency || u.details?.currency || "EGP").toUpperCase();
  const sameCur = list.every((u) => cur(u) === cur(list[0]));
  const saleEgp = list.every((u) => u.listing_type === "sale" && cur(u) === "EGP" && Number(u.area_value) > 0 && Number(u.price_value) > 0);
  const num = (x) => (Number(x) > 0 ? Number(x) : null);
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const mk = (key, label, raw, show, best) => {
    const nums = raw.map((x) => (best && x != null ? Number(x) : null));
    let bestIdx = null;
    if (best && nums.every((x) => x != null) && new Set(nums).size > 1) {
      const target = best === "min" ? Math.min(...nums) : Math.max(...nums);
      bestIdx = nums.indexOf(target);
    }
    return { key, label, values: raw.map((x) => (x == null || x === "" ? null : show(x))), best: bestIdx };
  };
  const rows = [
    mk("price", pick(en, "السعر", "Price"), list.map((u) => num(u.price_value)), (x) => `${fmt(x)}${sameCur ? ` ${cur(list[0])}` : ""}`, sameCur ? "min" : null),
    mk("area", pick(en, "المساحة م²", "Area m²"), list.map((u) => num(u.area_value)), fmt, "max"),
    ...(saleEgp ? [mk("ppm2", pick(en, "سعر المتر", "Price/m²"), list.map((u) => Math.round(u.price_value / u.area_value)), fmt, "min")] : []),
    mk("finishing", pick(en, "التشطيب", "Finishing"), list.map((u) => u.finishing || null), String, null),
    mk("delivery", pick(en, "الاستلام", "Delivery"), list.map((u) => u.delivery_date || u.delivery || null), String, null),
    mk("updated", pick(en, "آخر تحديث", "Updated"), list.map((u) => day(u.updated_at)), String, null)
  ].filter((r) => r.values.some((x) => x != null));
  const title = pick(en, "مقارنة الوحدات", "Unit comparison");
  const wins = rows.filter((r) => r.best != null).map((r) => `${r.label}: ${list[r.best].code}`);
  return {
    kind: "compare",
    title,
    columns: list.map((u) => ({ code: String(u.code), title: u.title || null })),
    rows,
    summary: `${title}: ${list.map((u) => u.code).join(" / ")}${wins.length ? ` · ${pick(en, "الأفضل", "best")} ${wins.join(en ? ", " : "، ")}` : ""}`,
    ...(link ? { link } : {})
  };
}

/** Text summary for a bar_breakdown (so every bar chart is readable without sight). */
function barSummary(title, rows, en) {
  return `${title}: ${(rows || []).slice(0, 6).map((r) => `${r.label} ${r.valueLabel ?? r.count}`).join(en ? ", " : "، ")}`;
}

module.exports = { trendDirection, trendCard, shareCard, priceRangeCard, compareCard, barSummary };
