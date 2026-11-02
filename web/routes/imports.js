// web/routes/imports.js — Excel diff import, group import (forwarded posts / chat export) and bulk edit
"use strict";

const express = require("express");
const AI = require("../../lib/ai");
const RateLimit = require("../../lib/rateLimit");
const Sheets = require("../../lib/sheets");
const SheetGrid = require("../../lib/sheetGrid");
const FailedRows = require("../../lib/importFailed");
const { logOperation } = require("../../lib/db");
const { isManager } = require("../../lib/authz");
const AiBlock = require("../../lib/aiBlock");
const Imports = require("../../services/imports");
const Edits = require("../../lib/edits");
const Plans = require("../../domain/plans");
const SheetImport = require("../../domain/sheetImport");
const Chat = require("../../domain/chatExport");
const Describe = require("../../domain/describe");
const Session = require("../session");
const { uploads } = require("../uploads");
const { html, raw } = require("../html");
const { tabs } = require("../views/tabs");
const { stripMarkdown } = require("../views/units");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const SHEET = { name: "sheet", maxCount: 1, accept: /^application\/(vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|octet-stream|zip)$/ };
const CHAT = { name: "chat", maxCount: 1, accept: /^(text\/plain|application\/(zip|x-zip-compressed|octet-stream))$/ };
const uploadSheet = uploads([SHEET], { maxMb: 5 });
const BIG_SERVER_SHEET = 1.5 * 1024 * 1024; // larger workbooks are read in the browser, never loaded whole on the server
const uploadChat = uploads([CHAT], { maxMb: 10, fieldSizeKb: 512 });
for (const re of [/^\/import\/excel$/, /^\/import\/group$/]) Session.allowMultipart(re);

const ImportTemplate = require("../../lib/importTemplate");
const TEMPLATE_HEADERS = ["Code / الكود", "Compound / الكمبوند", "Property Type / النوع", "Purpose / بيع او ايجار", "Price / السعر", "Area (sqm) / المساحة", "Bedrooms / الغرف", "Bathrooms / الحمامات", "Floor / الدور", "Finishing / التشطيب", "Delivery / التسليم", "Paid / المدفوع", "Remaining / المتبقي", "Installment / القسط", "Frequency / دورية القسط", "Features / المميزات", "District / المنطقة", "Status / الحالة", "Owner / المالك", "Owner phone / تليفون المالك", "Notes / ملاحظات"];

/** True when a buffer starts like a zip file (a chat export with photos goes to the Match photos tab). */
const isZip = (b) => Buffer.isBuffer(b) && b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b;

/** A chat export uploaded as .txt → its text. */
async function chatText(file) {
  if (!file || isZip(file.buffer)) return "";
  return file.buffer.toString("utf8").slice(0, 5_000_000);
}

const KIND_LABEL = {
  new: ["🆕 جديدة", "🆕 New"],
  changed: ["✏️ متغيرة", "✏️ Changed"],
  unchanged: ["✔️ زي ما هي", "✔️ Unchanged"],
  invalid: ["⛔ ناقصة أو غلط", "⛔ Invalid"],
  forbidden: ["🔒 مش من حقك تعدلها", "🔒 Not yours to change"]
};

const PAGE_SIZE = 50;
const PAGED_FROM = 200; // plans with more rows than this are shown one kind and one page at a time
const KIND_ORDER = ["invalid", "new", "changed", "unchanged", "forbidden"];
const CELL_LABEL = {
  listing_type: ["بيع / إيجار", "Sale or rent"],
  compound: ["الكمبوند", "Compound"],
  bedrooms: ["الغرف", "Bedrooms"],
  price_value: ["السعر", "Price"],
  area_value: ["المساحة", "Area"],
  property_type: ["النوع", "Type"],
  code: ["الكود", "Code"],
  details_text: ["تفاصيل", "Details"],
  address: ["العنوان", "Address"],
  owner_name: ["المالك", "Owner"],
  owner_phone: ["تليفون المالك", "Owner phone"],
  notes: ["ملاحظات", "Notes"],
  description: ["الوصف", "Description"],
  land_area: ["مساحة الأرض", "Land area"],
  down_payment_value: ["المقدم", "Down payment"]
};

function excelPlanPage(imp, lang, query = {}) {
  const { items, counts, rows: sheetRows, columns, tabs: tabInfos, defaults } = imp.payload;
  const applied = imp.status !== "ready";
  const paged = items.length > PAGED_FROM;
  const kinds = KIND_ORDER.filter((k) => counts[k]);
  const kind = paged ? (kinds.includes(query.kind) ? query.kind : counts.invalid ? "invalid" : kinds[0]) : null;
  const tab = paged && query.tab ? String(query.tab) : null;
  const shown = paged ? items.filter((i) => i.kind === kind && (!tab || i.tab === tab)) : items;
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number(query.page) || 1));
  const slice = paged ? shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : items;
  const href = (o) => `/app/import/${imp.id}?${new URLSearchParams(Object.entries({ kind, tab, page: 1, ...o }).filter(([, v]) => v !== null && v !== undefined)).toString()}`;
  const where = (i) => (i.tab ? `${i.tab} · ${L(lang, "صف", "row")} ${i.sheet_row}` : `${L(lang, "صف", "Row")} ${i.row}`);
  const section = (k, body) => {
    const rows = slice.filter((i) => i.kind === k);
    if (!rows.length) return "";
    return html`<section class="card" data-kind="${k}"><h2>${L(lang, KIND_LABEL[k][0], KIND_LABEL[k][1])} (${paged ? shown.length : rows.length})</h2>${body(rows)}</section>`;
  };
  const notesOf = (i) => (i.notes?.length ? html`<div class="warn muted" data-notes="${i.row}">${i.notes.join(" · ")}</div>` : "");
  // Editing is per row: a small form outside the apply form (forms cannot nest), its inputs joined by the form attribute.
  const canEdit = !applied && Array.isArray(sheetRows) && Array.isArray(columns) && columns.length > 0;
  const cellsOf = new Map((sheetRows || []).filter((r) => slice.some((i) => i.row === r.rowNumber)).map((r) => [r.rowNumber, r.cells]));
  const labelOf = (k) => (CELL_LABEL[k] || Edits.FIELD_LABELS[k] || [k, k])[lang === "en" ? 1 : 0];
  const field = (i, k) => {
    const v = cellsOf.get(i.row)?.[k] ?? "";
    if (k === "listing_type") {
      return html`<label>${labelOf(k)}<select form="edit-${i.row}" name="c_${k}"><option value=""></option><option value="rent"${v === "rent" ? raw(" selected") : ""}>${L(lang, "إيجار", "Rent")}</option><option value="sale"${v === "sale" ? raw(" selected") : ""}>${L(lang, "بيع", "Sale")}</option></select></label>`;
    }
    return html`<label>${labelOf(k)}<input form="edit-${i.row}" name="c_${k}" value="${v}" maxlength="600"></label>`;
  };
  const editor = (i) => {
    if (!canEdit) return "";
    const fields = [...new Set([...(i.needs || []), ...columns])];
    // What the row is missing comes first and the form opens on it; the other columns follow.
    return html`<details class="edit-row"${i.kind === "invalid" ? raw(" open") : ""}><summary>✏️ ${L(lang, "تعديل", "Edit")}</summary>
  <div class="stack">${fields.map((k) => field(i, k))}
  <button type="submit" form="edit-${i.row}" class="secondary">${L(lang, "احفظ التعديل وراجع تاني", "Save the edit and review again")}</button></div></details>`;
  };
  const editForms = canEdit
    ? slice.filter((i) => ["new", "changed", "invalid"].includes(i.kind)).map((i) => html`<form method="post" action="/app/import/${imp.id}/edit/${i.row}" id="edit-${i.row}"></form>`)
    : "";
  const box = (i, on = true) => (applied ? "" : html`<input type="checkbox" name="rows" value="${i.row}"${on ? raw(" checked") : ""}>`);

  const stats = !applied && sheetRows ? Imports.batchStats(imp.payload) : null;
  const batch =
    stats && (stats.no_type || stats.several_prices || stats.dollars || stats.unknown_types.length || stats.status_hints.length || Object.keys(stats.remembered).length)
      ? html`<section class="card stack" data-batch>
  <h2>🧰 ${L(lang, "تعديل جماعي", "Fix many rows at once")}</h2>
  ${stats.no_type
    ? html`<form method="post" action="/app/import/${imp.id}/batch" class="stack" data-batch-form="listing_type"><input type="hidden" name="action" value="listing_type">
    <p>${L(lang, `${stats.no_type} صف من غير بيع أو إيجار.`, `${stats.no_type} rows have no sale or rent.`)}${defaults?.file_type ? html` <span class="muted">${L(lang, "الملف اسمه بيقول", "The file name says")} ${defaults.file_type === "rent" ? L(lang, "إيجار", "rent") : L(lang, "بيع", "sale")}.</span>` : ""}</p>
    <div class="row"><button name="value" value="rent" class="secondary">${L(lang, "كلهم إيجار", "All rent")}</button><button name="value" value="sale" class="secondary">${L(lang, "كلهم بيع", "All sale")}</button></div></form>`
    : ""}
  ${stats.several_prices
    ? html`<form method="post" action="/app/import/${imp.id}/batch" class="stack" data-batch-form="price_pick"><input type="hidden" name="action" value="price_pick">
    <p>${L(lang, `${stats.several_prices} صف فيهم أكتر من سعر في الخانة (طويل ومدة قصيرة ويومي).`, `${stats.several_prices} rows list several prices in one cell (long term, short term, daily).`)}</p>
    <div class="row"><button name="value" value="long" class="${stats.remembered.price_pick === "long" ? "" : "secondary"}"${stats.remembered.price_pick === "long" ? raw(' data-remembered="price_pick"') : ""}>${L(lang, "خد السعر الطويل أو الشهري", "Use the long-term or monthly price")}</button><button name="value" value="first" class="${stats.remembered.price_pick === "first" ? "" : "secondary"}"${stats.remembered.price_pick === "first" ? raw(' data-remembered="price_pick"') : ""}>${L(lang, "خد أول سعر", "Use the first price")}</button></div>
    <p class="muted">${L(lang, "السعر اليومي مبيتاخدش أبداً، والنص الأصلي بيتحفظ في الملاحظات.", "A daily price is never used; the original text is kept in the notes.")}</p></form>`
    : ""}
  ${stats.unknown_types.length
    ? html`<div class="stack" data-batch-form="type_map"><p>${L(lang, "أنواع مش معروفة. اختار نوع لكل كلمة مرة واحدة وتتطبق على كل الصفوف:", "Types the app does not know. Pick a type for each word once and it applies to every row:")}</p>
    ${stats.unknown_types.map((u) => html`<form method="post" action="/app/import/${imp.id}/batch" class="row" data-type-word="${u.value}"><input type="hidden" name="action" value="type_map"><input type="hidden" name="from" value="${u.value}">
      <strong>${u.value}</strong> <span class="muted">×${u.count}</span>
      <select name="value" aria-label="${u.value}">${Imports.TYPE_KEYS.map((k) => html`<option value="${k}"${(stats.remembered.types || {})[u.value] === k ? raw(" selected data-remembered") : ""}>${(Describe.TYPE_LABELS[k] || [k, k])[lang === "en" ? 1 : 0]}</option>`)}</select>
      <button class="secondary">${L(lang, "طبّق", "Apply")}</button></form>`)}</div>`
    : ""}
  ${stats.status_hints.length
    ? html`<form method="post" action="/app/import/${imp.id}/batch" class="stack" data-batch-form="status_words"><input type="hidden" name="action" value="status_words">
    <p>${L(lang, `ملاحظات ${stats.status_hints.reduce((n, h) => n + h.count, 0)} صف بتقول إن الوحدة اتأجرت أو اتباعت أو مش متاحة (${stats.status_hints.map((h) => `${h.count} ${h.status === "sold" ? "اتأجرت/اتباعت" : "مش متاحة"}`).join("، ")}). نسجلهم بالحالة دي؟`, `${stats.status_hints.reduce((n, h) => n + h.count, 0)} rows say in their notes the unit is rented, sold or not available (${stats.status_hints.map((h) => `${h.count} ${h.status === "sold" ? "rented or sold" : "not available"}`).join(", ")}). Save them with that status?`)}</p>
    <div class="row"><button name="value" value="yes" class="secondary">${L(lang, "أيوه، سجلهم بالحالة", "Yes, save them with that status")}</button><button name="value" value="no" class="secondary">${L(lang, "لا، سيبهم متاحين", "No, leave them available")}</button></div>
    <p class="muted"${stats.remembered.status_words !== undefined ? raw(' data-remembered="status"') : ""}>${stats.remembered.status_words !== undefined ? L(lang, `المرة اللي فاتت اخترت: ${stats.remembered.status_words ? "أيوه" : "لا"}. بنسألك كل مرة.`, `Last time you chose: ${stats.remembered.status_words ? "yes" : "no"}. We still ask each time.`) : L(lang, "إجابتك بتتحفظ كاقتراح للمرة الجاية.", "Your answer is kept as a suggestion for the next upload.")}</p></form>`
    : ""}
  ${Object.keys(stats.remembered).length
    ? html`<form method="post" action="/app/import/${imp.id}/batch" class="stack" data-prefs-used><input type="hidden" name="action" value="forget_prefs">
    <p class="muted">${L(lang, "اختياراتك القديمة ظاهرة كاقتراحات متحددة مسبقاً. مفيش حاجة بتتطبق من غير ما تدوس.", "Your earlier choices appear as pre-selected suggestions. Nothing is applied until you press a button.")}</p>
    <button class="secondary">${L(lang, "انسَ اختياراتي المحفوظة", "Forget my saved choices")}</button></form>`
    : ""}
  ${stats.dollars
    ? html`<p data-usd-info>${L(lang, `${stats.dollars} صف بالدولار. بيتسجلوا بالدولار من غير تحويل، والبحث بيحولهم بسعر الوكالة.`, `${stats.dollars} rows are priced in dollars. They are saved in dollars, not converted; search converts them at the agency rate.`)}</p>`
    : ""}
</section>`
      : "";

  const kindNav = paged
    ? html`<nav class="row" data-kind-nav aria-label="${L(lang, "الأنواع", "Kinds")}">${kinds.map((k) => html`<a class="chip${k === kind ? " on" : ""}" href="${href({ kind: k, tab })}" data-kind-link="${k}"${k === kind ? raw(' aria-current="page"') : ""}>${L(lang, KIND_LABEL[k][0], KIND_LABEL[k][1])} ${paged && k === kind && tab ? shown.length : counts[k]}</a>`)}</nav>`
    : "";
  const tabsNav =
    paged && Array.isArray(tabInfos) && tabInfos.length > 1
      ? (() => {
          const per = new Map();
          for (const i of items) if (i.tab) per.set(i.tab, { n: (per.get(i.tab)?.n || 0) + 1, bad: (per.get(i.tab)?.bad || 0) + (i.kind === "invalid" ? 1 : 0) });
          return html`<details class="card" data-tabs${tab ? raw(" open") : ""}><summary>📑 ${L(lang, `${tabInfos.filter((t) => t.rows).length} تاب في الملف`, `${tabInfos.filter((t) => t.rows).length} tabs in the file`)}${tab ? html` · <strong>${tab}</strong>` : ""}</summary>
  <p class="row"><a class="chip${tab ? "" : " on"}" href="${href({ tab: null })}">${L(lang, "الكل", "All")}</a>${[...per.entries()].map(([name, c]) => html`<a class="chip${tab === name ? " on" : ""}" href="${href({ tab: name })}" data-tab-link>${name} ${c.n}${c.bad ? html` <span class="warn">⛔${c.bad}</span>` : ""}</a>`)}</p></details>`;
        })()
      : "";
  const pager =
    paged && pages > 1
      ? html`<nav class="row" data-pager>${page > 1 ? html`<a class="chip" href="${href({ page: page - 1 })}" rel="prev">${L(lang, "السابق", "Previous")}</a>` : ""}<span class="muted">${page} / ${pages}</span>${page < pages ? html`<a class="chip" href="${href({ page: page + 1 })}" rel="next">${L(lang, "التالي", "Next")}</a>` : ""}</nav>`
      : "";
  const ready = (counts.new || 0) + (counts.changed || 0);

  return html`<h1>📥 ${L(lang, "مراجعة الاستيراد", "Review the import")} <span class="muted">${imp.filename || ""}</span></h1>
${paged ? "" : html`<p class="muted">${Object.entries(counts).map(([k, n]) => `${L(lang, KIND_LABEL[k][0], KIND_LABEL[k][1])}: ${n}`).join(" · ")}</p>`}
${imp.result ? resultCard(imp.result, lang, imp.canUndo ? imp.id : null) : ""}
${query.batch ? html`<p class="card notice" role="status" data-batch-done>${L(lang, `اتغير ${Number(query.batch) || 0} صف.`, `${Number(query.batch) || 0} rows changed.`)}</p>` : ""}
${batch}
${kindNav}${tabsNav}
<form method="post" action="/app/import/${imp.id}/apply" class="stack">
${section("new", (rows) => html`<table><thead><tr><th></th><th>${L(lang, "صف", "Row")}</th><th>${L(lang, "الكود", "Code")}</th><th>${L(lang, "الوحدة", "Unit")}</th></tr></thead><tbody>${rows.map(
  (i) => html`<tr data-row="${i.row}"><td>${box(i)}</td><td>${i.tab ? where(i) : i.row}</td><td>${i.code || L(lang, "(تلقائي)", "(auto)")}</td><td>${stripMarkdown(Describe.compactLine({ ...i.fields, code: "" }, lang).replace(/^``\s*·\s*/, ""))}${i.warnings.length ? html`<div class="warn muted">${i.warnings.join(" · ")}</div>` : ""}${notesOf(i)}${editor(i)}</td></tr>`
)}</tbody></table>`)}
${section("changed", (rows) => html`<table><thead><tr><th></th><th>${L(lang, "صف", "Row")}</th><th>${L(lang, "الكود", "Code")}</th><th>${L(lang, "التغيير", "Change")}</th></tr></thead><tbody>${rows.map(
  (i) => html`<tr data-row="${i.row}"><td>${box(i)}</td><td>${i.tab ? where(i) : i.row}</td><td>${i.code}</td><td><ul>${i.changes.map((c) => html`<li data-change="${c.field}">${c.label}: <del>${c.from}</del> ← <ins>${c.to}</ins></li>`)}</ul>${notesOf(i)}${editor(i)}</td></tr>`
)}</tbody></table>`)}
${section("invalid", (rows) => html`<ul>${rows.map((i) => html`<li data-row="${i.row}">${where(i)}${i.code ? ` (${i.code})` : ""}: ${i.reasons.join("، ")}${notesOf(i)}${editor(i)}</li>`)}</ul>`)}
${section("forbidden", (rows) => html`<ul>${rows.map((i) => html`<li data-row="${i.row}">${i.code}</li>`)}</ul>`)}
${section("unchanged", (rows) => html`<ul class="muted">${rows.map((i) => html`<li data-row="${i.row}">${where(i)} (${i.code}): ${L(lang, "نفس اللي في التطبيق، مفيش حاجة هتتغير", "Same as in the app, nothing to change")}${notesOf(i)}</li>`)}</ul>`)}
${pager}
${(counts.invalid || 0) + (counts.forbidden || 0) ? html`<p class="row" data-failed-download><a class="secondary button" href="/app/import/${imp.id}/failed.xlsx" download>⬇️ ${L(lang, `نزّل الصفوف اللي مش هتتسجل (${(counts.invalid || 0) + (counts.forbidden || 0)}) إكسيل بعمود السبب`, `Download the rows that will not import (${(counts.invalid || 0) + (counts.forbidden || 0)}) as Excel, with a Reason column`)}</a></p>` : ""}
  ${applied ? "" : html`<div class="row"><button type="submit">✅ ${L(lang, paged ? "طبّق المختار في الصفحة دي" : "طبّق المختار", paged ? "Apply the selected rows on this page" : "Apply the selected rows")}</button>${paged && ready ? html`<button type="submit" name="all" value="1" class="secondary" data-apply-all>${L(lang, `طبّق كل الجديد والمتغير (${ready})`, `Apply all new and changed (${ready})`)}</button>` : ""}</div>`}
</form>
${editForms}`;
}

function resultCard(r, lang, undoId = null) {
  const line = (label, list) => (list && list.length ? html`<li>${label}: ${list.length} <span class="muted">${list.join("، ")}</span></li>` : "");
  return html`<div class="card notice" data-result>
  <h2>✅ ${L(lang, "اتطبق", "Applied")}</h2>
  ${r.undone ? html`<p data-undone>↩️ ${L(lang, "اتراجع عنه. الوحدات المتضافة اتأرشفت، والمتعدلة رجعت لقيمها.", "Undone. Units it added are archived; changed units are back to their earlier values.")}</p>` : ""}
  ${undoId && !r.undone ? html`<p><a class="secondary button" href="/app/import/${undoId}/undo" data-undo-link>↩️ ${L(lang, "تراجع عن الاستيراد ده", "Undo this import")}</a></p>` : ""}
  <ul>
    ${line(L(lang, "اتضافت", "Created"), r.created)}
    ${line(L(lang, "اتعدلت", "Updated"), r.updated)}
    ${line(L(lang, "اتغيرت من شخص تاني بعد المراجعة (متعدلتش)", "Changed by someone else since the review (not applied)"), r.conflicts)}
    ${line(L(lang, "متطبقتش", "Not applied"), r.failed)}
  </ul>
  ${r.limit ? html`<p class="notice bad" data-unit-limit>${Plans.unitLimitText(r.limit, lang)}</p>` : ""}
</div>`;
}

/** A post's photos from a chat export zip: thumbnails, and a warning when a photo is already on a unit. */
function photosLine(post, lang) {
  const photos = post.photos || [];
  if (!photos.length && !post.missing) return "";
  const same = [...new Set(photos.map((x) => x.same_as).filter(Boolean))];
  const twins = [...new Set(photos.map((x) => x.twin).filter((x) => x !== undefined && x !== null))];
  return html`<div class="stack" data-photos="${photos.length}">
  <p>📷 ${L(lang, `${photos.length} صورة`, `${photos.length} photos`)}${post.missing ? html` <span class="muted">· ${L(lang, `${post.missing} مش موجودة في الملف`, `${post.missing} not in the file`)}</span>` : ""}</p>
  ${photos.length ? html`<div class="row thumbs">${photos.slice(0, 6).map((x) => html`<img src="${x.url}" alt="" width="64" height="64" loading="lazy">`)}</div>` : ""}
  ${same.map((code) => html`<p class="warn" data-same-photo="${code}">⚠️ ${L(lang, "نفس صورة الوحدة", "Same photo as unit")} <a href="/app/units/${encodeURIComponent(code)}">${code}</a></p>`)}
  ${twins.map((n) => html`<p class="warn">⚠️ ${L(lang, `نفس صورة في بوست ${n + 1}`, `Same photo as in post ${n + 1}`)}</p>`)}
</div>`;
}

function groupPage(imp, lang) {
  const posts = imp.payload.posts || [];
  const results = imp.payload.results || [];
  const done = results.filter(Boolean).length;
  if (imp.status === "processing") {
    return html`<div id="group-status" hx-get="/app/import/${imp.id}" hx-trigger="every 2s" hx-select="#group-status" hx-swap="outerHTML" class="card">
  <h1>⏳ ${L(lang, "جاري قراءة البوستات", "Reading the posts")}</h1><p>${done} / ${posts.length}</p></div>`;
  }
  if (imp.status === "failed") {
    const why = {
      no_posts: L(lang, "ملقيناش بوستات فيها وحدات (سعر ومساحة أو غرف).", "No posts describing a unit (price and area or rooms) were found.")
    }[imp.payload.error] || L(lang, "حصلت مشكلة في قراءة الملف.", "Something went wrong reading the file.");
    return html`<div id="group-status" class="card notice bad" data-import-error="${imp.payload.error || "failed"}"><h1>⚠️ ${why}</h1><a href="/app/import">${L(lang, "رجوع", "Back")}</a></div>`;
  }
  const applied = imp.status !== "ready";
  return html`<div id="group-status"><h1>📥 ${L(lang, "استيراد من الجروب", "Group import")}</h1>
${imp.result ? resultCard(imp.result, lang, imp.canUndo ? imp.id : null) : ""}
<form method="post" action="/app/import/${imp.id}/apply" class="stack">
<ol class="results">${posts.map((p, i) => {
    const r = results[i];
    const twin = r?.same_as !== undefined && r?.same_as !== null;
    const state = !r ? "pending" : r.error ? "error" : r.ok ? (r.duplicate || twin ? "duplicate" : "ok") : "incomplete";
    return html`<li class="card" data-post="${i}" data-state="${state}">
  <div class="row">${!applied && r?.ok ? html`<input type="checkbox" name="rows" value="${i}"${r.duplicate || twin ? "" : raw(" checked")}>` : ""}<strong>${p.sender || L(lang, "بوست", "Post")}</strong> <span class="muted">${p.at || ""}</span></div>
  <p class="muted">${p.text.slice(0, 280)}</p>
  ${photosLine(p, lang)}
  ${r?.ok ? html`<p>${stripMarkdown(Describe.compactLine({ ...r.fields, code: "" }, lang).replace(/^``\s*·\s*/, ""))}</p>` : ""}
  ${r?.duplicate ? html`<p class="warn">⚠️ ${L(lang, "شكلها نفس الوحدة", "Looks like the same unit as")} <a href="/app/units/${encodeURIComponent(r.duplicate)}">${r.duplicate}</a></p>` : ""}
  ${twin ? html`<p class="warn">⚠️ ${L(lang, `شكلها نفس الوحدة في بوست ${r.same_as + 1}`, `Looks like the same unit as post ${r.same_as + 1}`)}</p>` : ""}
  ${r && !r.ok && !r.error ? html`<p class="bad">⛔ ${r.blockers.join("، ")}</p>` : ""}
  ${r?.error ? html`<p class="bad">❌ ${["quota", "daily", "off"].includes(r.error) ? AiBlock.text(r.error, lang) : L(lang, "تعذرت قراءته", "Could not be read")}</p>` : ""}
</li>`;
  })}</ol>
${applied ? "" : html`<button type="submit">✅ ${L(lang, "ضيف المختار", "Add the selected units")}</button>`}
</form></div>`;
}

function register(web, { pool, page, assets }) {
  const importPage = (req, res, body, status = 200) => page(req, res, { title: L(langOf(req), "استيراد", "Import"), nav: "import", body }, status);

  /**
   * The import hub: one tile per way in (Excel, pasted group posts, a chat export with photos, leads). An error shows
   * above its own form, with that tile open (tab: 0 Excel, 1 group posts, 2 chat with photos).
   */
  const importHub = (req, { notice = null, tab = 0 } = {}) => {
    const lang = langOf(req);
    const err = (n) => (notice && tab === n ? notice : "");
    return html`<h1>${L(lang, "استيراد", "Import")}</h1>
${tabs("import_tab", [
  [html`<span class="ti">📊</span>${L(lang, "شيت إكسيل", "Excel sheet")}`, html`${err(0)}<form method="post" action="/app/import/excel" enctype="multipart/form-data" class="card stack" data-xi data-grid-url="/app/import/excel/grid">
  <input type="hidden" name="_csrf" value="${req.session.csrf}">
  <h2>📊 ${L(lang, "شيت إكسيل (مقارنة بالمخزون)", "Excel sheet (compared with your inventory)")}</h2>
  <p class="muted">${L(lang, "هنوريك الجديد والمتغير قبل أي حفظ. ينفع شيت التصدير من البوت أو", "You see what is new and what changed before anything is saved. The bot's export works, or")} <a href="/app/import/template.xlsx">${L(lang, "النموذج ده", "this template")}</a>.</p>
  <input type="file" name="sheet" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required>
  <p class="muted">${L(lang, "كل التابات بتتقري في المتصفح، والتاب اسمه بيبقى الكمبوند لو مفيش عمود كمبوند.", "Every tab is read in your browser; a tab's name is the compound when the sheet has no compound column.")}</p>
  <p data-xi-status class="card notice" role="status" hidden></p>
  <button type="submit">${L(lang, "قارن", "Compare")}</button>
  <script src="${assets.url("zipread.js")}"></script><script src="${assets.url("xlsxread.js")}"></script><script src="${assets.url("ximport.js")}"></script>
</form>`],
  [html`<span class="ti">💬</span>${L(lang, "بوستات جروبات", "Group posts")}`, html`${err(1)}<form method="post" action="/app/import/group" enctype="multipart/form-data" class="card stack">
  <input type="hidden" name="_csrf" value="${req.session.csrf}">
  <h2>💬 ${L(lang, "بوستات الجروبات", "Group posts")}</h2>
  <label>${L(lang, "الصق البوستات (سيب سطرين فاضيين بين كل بوست)", "Paste the posts (two empty lines between posts)")}<textarea name="text" rows="6"></textarea></label>
  <label>${L(lang, "أو ارفع تصدير الشات من واتساب (.txt)", "Or upload a WhatsApp chat export (.txt)")}<input type="file" name="chat" accept=".txt,text/plain"></label>
  <label>${L(lang, "استورد البوستات من تاريخ", "Import posts from")}<input type="date" name="since" value="${Chat.defaultSince()}"></label>
  <p class="muted">${L(lang, `بنقرا لحد ${Chat.MAX_POSTS} بوست في المرة، وبنعلّم المكرر.`, `Up to ${Chat.MAX_POSTS} posts at a time; duplicates are flagged.`)}</p>
  <button type="submit">${L(lang, "اقرأ البوستات", "Read the posts")}</button>
</form>`],
  [html`<span class="ti">📷</span>${L(lang, "شات بالصور", "Chat with photos")}`, html`${err(2)}<div class="card stack" data-cp data-lang="${lang}" data-csrf="${req.session.csrf}" data-units-url="/app/import/match/units" data-start-url="/app/import/match/start" data-unit-url="/app/import/match/unit/{code}/photo" data-post-url="/app/import/match/{id}/photo/{n}">
  <h2>📷 ${L(lang, "تطابق الصور من شات واتساب", "Match photos from a WhatsApp chat")}</h2>
  <p class="muted">${L(lang, "من واتساب: الجروب ← المزيد ← تصدير الشات ← «إرفاق الوسائط». الملف بيتفتح في المتصفح عندك بس: مش بيترفع، فمفيش حد أقصى لحجمه. بنوزع كل صورة على وحدتها حسب الكود في الوصف أو حسب الترتيب والراسل، وإنت بتراجع قبل أي رفع. مفيش حاجة بتتحفظ إلا الصور اللي تختارها.", "In WhatsApp: the group → More → Export chat → “Attach media”. The file is opened in your browser only: it is not uploaded, so its size has no limit. Each photo is placed on its unit by the code in the description, or by order and sender, and you review it before anything is sent. Only the photos you choose are saved.")}</p>
  <input type="file" accept=".zip,.txt,application/zip,text/plain" data-cp-file>
  <label>${L(lang, "الوحدات", "Units")}<select data-cp-mode>
    <option value="codes">${L(lang, "الوحدات اللي في التطبيق (بالكود)", "Units already in the app (by code)")}</option>
    <option value="posts">${L(lang, "اقرأ الوحدات من البوستات (ذكاء اصطناعي)", "Read the units from the posts (AI)")}</option>
  </select></label>
  <label>${L(lang, "من تاريخ", "From date")}<input type="date" data-cp-since value="${Chat.defaultSince()}"></label>
  <label>${L(lang, "الفاصل بين الصور والوصف", "Gap between photos and description")}<select data-cp-window>
    <option value="5">5 ${L(lang, "دقايق", "minutes")}</option><option value="10" selected>10 ${L(lang, "دقايق", "minutes")}</option><option value="30">30 ${L(lang, "دقيقة", "minutes")}</option>
  </select></label>
  <label>${L(lang, "ترتيب الصور والوصف", "Order of photos and description")}<select data-cp-pattern>
    <option value="auto">${L(lang, "اكتشف تلقائياً", "Detect automatically")}</option>
    <option value="photos_first">${L(lang, "الصور الأول وبعدها الوصف", "Photos first, then the description")}</option>
    <option value="text_first">${L(lang, "الوصف الأول وبعدها الصور", "Description first, then photos")}</option>
  </select></label>
  <label class="row"><input type="checkbox" data-cp-same checked> ${L(lang, "نفس الشخص اللي بعت الوصف بس", "Only photos from the same person as the description")}</label>
  <button type="button" data-cp-read>${L(lang, "اقرأ الملف", "Read the file")}</button>
  <div data-cp-out></div>
  <script src="${assets.url("zipread.js")}"></script><script src="${assets.url("chatparse.js")}"></script><script src="${assets.url("chatmatch.js")}"></script><script src="${assets.url("chatphotos.js")}"></script>
</div>`]
], { open: tab, cls: "tiles" })}`;
  };

  web.get("/import", (req, res) => importPage(req, res, importHub(req)));

  web.get("/import/template.xlsx", async (_req, res) => {
    const buf = await ImportTemplate.build({
      sheetName: "Inventory",
      headers: TEMPLATE_HEADERS,
      required: [1, 2, 3, 4, 5],
      samples: [
        ["SAMPLE-1", "Hyde Park", "شقة", "بيع", "8.5 مليون", 150, 3, 2, 4, "تشطيب كامل", "2027 Q3", "3 مليون", "5.5 مليون", 250000, "ربع سنوي", "بحري، ناصية", "التجمع الخامس", "متاحة", "مثال: أحمد", "01000000000", "صف تجريبي، امسحه"],
        ["SAMPLE-2", "Mountain View", "فيلا", "بيع", "21 مليون", 320, 4, 4, "", "سوبر لوكس", "جاهز", "", "", "", "", "حديقة، مسبح", "الشيخ زايد", "متاحة", "مثال: منى", "01100000000", "صف تجريبي، امسحه"]
      ],
      text: [20],
      readme: [
        ["الكود اختياري: لو فاضي النظام يعمله.", "Code is optional: left empty, the system makes one."],
        ["لازم الكمبوند، النوع، بيع/إيجار، السعر والمساحة.", "Compound, property type, sale/rent, price and area are needed."],
        ["السعر يقبل «8.5 مليون» أو 8500000.", "Price accepts '8.5 million' or 8500000."],
        ["الاستيراد للمديرين بس، وبتشوف كل صف هيعمل إيه قبل الحفظ.", "Import is for managers; you see what every row will do before anything is saved."]
      ]
    });
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.set("Content-Disposition", 'attachment; filename="wehdathub-inventory-template.xlsx"');
    return res.send(buf);
  });

  // Imports (Excel, group posts, chat with photos) are for managers. Brokers add single units by form, voice and text.
  const managersOnly = (req, res, next) =>
    isManager(req.session.broker) ? next() : res.status(403).type("text/plain").send(L(langOf(req), "للمديرين بس", "Managers only"));

  web.post("/import/excel", managersOnly, uploadSheet, async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return importPage(req, res, importHub(req, { tab: 0, notice: html`<p class="card notice bad" role="alert">⏳ ${L(lang, "رفعت ملفات كتير. استنى شوية.", "Too many uploads. Wait a moment.")}</p>` }), 429);
    const file = (req.files?.sheet || [])[0];
    let sheet;
    if (file?.buffer && file.buffer.length > BIG_SERVER_SHEET) {
      return importPage(req, res, importHub(req, { tab: 0, notice: html`<p class="card notice bad" role="alert" data-import-error="big">⚠️ ${L(lang, "الملف كبير. افتحه من متصفح حديث (كروم أو سفاري) عشان يتقري في المتصفح بدل السيرفر.", "The file is large. Open this page in a current browser (Chrome or Safari) so the file is read in the browser, not on the server.")}</p>` }), 422);
    }
    try {
      sheet = await Sheets.readInventorySheet(file?.buffer);
    } catch (err) {
      const msg = {
        NOT_XLSX: L(lang, "الملف لازم يكون إكسيل .xlsx.", "The file must be an .xlsx workbook."),
        TOO_LARGE: L(lang, "الملف أكبر من 5 ميجا.", "The file is larger than 5 MB."),
        NO_HEADER: L(lang, "مش لاقيين صف العناوين (الكود، الكمبوند، السعر، المساحة…).", "No header row found (code, compound, price, area, …)."),
        TOO_MANY_ROWS: L(lang, `أكتر من ${Sheets.MAX_ROWS} صف.`, `More than ${Sheets.MAX_ROWS} rows.`)
      }[err.code];
      if (!msg) throw err;
      return importPage(req, res, importHub(req, { tab: 0, notice: html`<p class="card notice bad" role="alert">⚠️ ${msg}</p>` }), 422);
    }
    const missing = SheetImport.emptyRequired(sheet.rows);
    if (missing.length) {
      const name = { code: L(lang, "الكود", "Code"), price_value: L(lang, "السعر", "Price"), area_value: L(lang, "المساحة", "Area") };
      const list = missing.map((k) => name[k] || k).join("، ");
      return importPage(req, res, importHub(req, { tab: 0, notice: html`<p class="card notice bad" role="alert" data-import-error="empty-column">⚠️ ${L(lang, `العمود ده فاضي في كل الصفوف: ${list}. ملفش اتحفظ حاجة. ضيف القيم وارفع تاني.`, `These columns are empty on every row: ${list}. Nothing was saved. Fill them in and upload again.`)}</p>` }), 422);
    }
    const plan = await Imports.planExcel(pool, broker, sheet, { lang });
    const id = await Imports.savePlan(pool, broker, "excel", { ...plan, rows: sheet.rows, columns: sheet.mapped, skipped: sheet.skipped || [] }, { filename: String(file.originalname || "").slice(0, 120) });
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_plan", metadata: { kind: "excel", rows: sheet.rows.length, counts: plan.counts } });
    return res.redirect(303, `/app/import/${id}`);
  });

  /**
   * The browser read the workbook (every tab) and sends only the cells: validated here, mapped tab by tab, planned like an upload.
   * Body: { filename, tabs: [{ name, rows: [{ n, v: [value | null] }] }] }.
   */
  web.post("/import/excel/grid", managersOnly, express.json({ limit: "6mb" }), async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const say = (status, message, extra = {}) => res.status(status).json({ message, ...extra });
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return say(429, L(lang, "رفعت ملفات كتير. استنى شوية.", "Too many uploads. Wait a moment."));
    const tabsIn = Array.isArray(req.body?.tabs) ? req.body.tabs : null;
    if (!tabsIn || !tabsIn.length || tabsIn.length > SheetGrid.MAX_TABS) return say(422, L(lang, "الملف مفيهوش تابات صالحة.", "The file has no usable tabs."));
    let rawRows = 0;
    const tabs = [];
    for (const t of tabsIn) {
      const rows = [];
      for (const r of Array.isArray(t?.rows) ? t.rows : []) {
        if (!Array.isArray(r?.v) || !Number.isInteger(r.n) || r.n < 1) continue;
        if (++rawRows > 30000) return say(422, L(lang, "الملف كبير أوي.", "The file is too large."));
        rows.push({ n: r.n, v: r.v.slice(0, 80).map((c) => (typeof c === "number" && Number.isFinite(c) ? c : typeof c === "string" ? c.slice(0, 2000) : null)) });
      }
      tabs.push({ name: String(t?.name ?? "").slice(0, 80), rows });
    }
    let sheet;
    try {
      sheet = SheetGrid.buildSheet(tabs, { filename: String(req.body?.filename || "").slice(0, 120) });
    } catch (err) {
      const msg = {
        NO_HEADER: L(lang, "مش لاقيين صف العناوين ولا أعمدة نعرفها (الكود، الكمبوند، السعر، المساحة…).", "No header row or recognisable columns found (code, compound, price, area, …)."),
        NO_TABS: L(lang, "الملف مفيهوش تابات صالحة.", "The file has no usable tabs."),
        TOO_MANY_TABS: L(lang, `أكتر من ${SheetGrid.MAX_TABS} تاب.`, `More than ${SheetGrid.MAX_TABS} tabs.`),
        TOO_MANY_ROWS: L(lang, `أكتر من ${SheetGrid.MAX_TOTAL_ROWS} صف.`, `More than ${SheetGrid.MAX_TOTAL_ROWS} rows.`)
      }[err.code];
      if (!msg) throw err;
      return say(422, msg);
    }
    const missing = SheetImport.emptyRequired(sheet.rows);
    if (missing.length) {
      const name = { code: L(lang, "الكود", "Code"), price_value: L(lang, "السعر", "Price"), area_value: L(lang, "المساحة", "Area") };
      return say(422, L(lang, `العمود ده فاضي في كل الصفوف: ${missing.map((k) => name[k] || k).join("، ")}. ملفش اتحفظ حاجة.`, `These columns are empty on every row: ${missing.map((k) => name[k] || k).join(", ")}. Nothing was saved.`), { empty: missing });
    }
    const plan = await Imports.planExcel(pool, broker, sheet, { lang });
    const id = await Imports.savePlan(pool, broker, "excel", { ...plan, rows: sheet.rows, columns: sheet.mapped, skipped: sheet.skipped, tabs: sheet.tabs, defaults: sheet.defaults }, { filename: String(req.body?.filename || "").slice(0, 120) });
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_plan", metadata: { kind: "excel", rows: sheet.rows.length, tabs: sheet.tabs.length, counts: plan.counts } });
    return res.json({ url: `/app/import/${id}` });
  });

  web.post("/import/group", managersOnly, uploadChat, async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return importPage(req, res, importHub(req, { tab: 1, notice: html`<p class="card notice bad" role="alert">⏳ ${L(lang, "رفعت ملفات كتير. استنى شوية.", "Too many uploads. Wait a moment.")}</p>` }), 429);
    const file = (req.files?.chat || [])[0];
    const text = [String(req.body.text || ""), await chatText(file)].filter((t) => t.trim()).join("\n\n\n");
    const found = Chat.candidatePosts(text, { since: req.body.since });
    if (file && isZip(file.buffer)) {
      return importPage(req, res, importHub(req, { tab: 1, notice: html`<p class="card notice bad" role="alert" data-import-error="zip">⚠️ ${L(lang, "الـ zip بالصور بيتفتح من تبويب «شات بالصور».", "A zip with photos goes in the “Chat with photos” tab.")}</p>` }), 422);
    }
    if (!found.posts.length) {
      return importPage(req, res, importHub(req, { tab: 1, notice: html`<p class="card notice bad" role="alert">🔍 ${L(lang, "ملقيناش بوستات فيها وحدات (سعر ومساحة أو غرف).", "No posts describing a unit (price and area or rooms) were found.")}</p>` }), 422);
    }
    const id = await Imports.startGroupImport(pool, broker, found.posts, {
      AI,
      ctx: { pool, broker, agency: req.session.agency, lang },
      lang,
      filename: file ? String(file.originalname || "").slice(0, 120) : null
    });
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_plan", metadata: { kind: "group", posts: found.posts.length, skipped: found.skipped, duplicates: found.duplicates } });
    return res.redirect(303, `/app/import/${id}`);
  });

  // The rows this import did not take, as an Excel file: the sheet's values as they are plus a "Reason" column.
  web.get("/import/:id/failed.xlsx", managersOnly, async (req, res, next) => {
    const imp = await Imports.loadImport(pool, req.session.broker, req.params.id);
    if (!imp || imp.kind !== "excel") return next();
    const { buffer } = await FailedRows.failedRowsWorkbook(imp.payload, { lang: langOf(req) });
    return res
      .set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": 'attachment; filename="not-imported-rows.xlsx"', "Cache-Control": "no-store" })
      .send(buffer);
  });

  // Undo the last applied import: a confirm page with what will happen, then one press to do it.
  web.get("/import/:id/undo", managersOnly, async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const imp = await Imports.loadImport(pool, broker, req.params.id);
    if (!imp || !(await Imports.canUndo(pool, broker, imp))) return next();
    const plan = await Imports.undoPreview(pool, broker.agency_id, imp);
    const names = (list) => list.map((x) => x.code).join("، ");
    return importPage(req, res, html`<section class="card stack" data-undo-confirm>
  <h1>${L(lang, "تراجع عن الاستيراد ده؟", "Undo this import?")}</h1>
  <p>${L(lang, "ده آخر استيراد اتطبق. التراجع ليه بس.", "This is the last import applied. Only this one can be undone.")}</p>
  <ul>
    ${plan.archive.length ? html`<li data-undo-archive>${L(lang, `هنأرشف ${plan.archive.length} وحدة اتضافت: `, `Archive ${plan.archive.length} units it added: `)}<span class="muted">${names(plan.archive)}</span></li>` : ""}
    ${plan.restore.length ? html`<li data-undo-restore>${L(lang, `هرجّع ${plan.restore.length} وحدة اتعدلت لقيمها القديمة: `, `Put back the earlier values of ${plan.restore.length} units it changed: `)}<span class="muted">${names(plan.restore)}</span></li>` : ""}
    ${plan.skipped.length ? html`<li data-undo-skipped>${L(lang, `${plan.skipped.length} وحدة متتلمسش: اتعدلت بعد الاستيراد أو اتشالت. مش هتتغير: `, `${plan.skipped.length} units are left alone: changed or removed since the import. They will not change: `)}<span class="muted">${plan.skipped.join("، ")}</span></li>` : ""}
  </ul>
  <p class="muted">${L(lang, "الوحدات المؤرشفة مش بتتمسح وتقدر ترجعها من الوحدات.", "Archived units are not deleted; you can restore them from Units.")}</p>
  <form method="post" action="/app/import/${imp.id}/undo" class="row">
    <button type="submit" data-undo-confirm-button>${L(lang, "أيوه، تراجع", "Yes, undo")}</button>
    <a class="secondary button" href="/app/import/${imp.id}">${L(lang, "لا، ارجع", "No, go back")}</a>
  </form>
</section>`);
  });

  web.post("/import/:id/undo", managersOnly, async (req, res, next) => {
    const out = await Imports.undoExcel(pool, req.session.broker, req.params.id);
    if (!out) return next();
    return res.redirect(303, `/app/import/${req.params.id}?undone=1`);
  });

  web.get("/import/:id", async (req, res, next) => {
    const lang = langOf(req);
    const imp = await Imports.loadImport(pool, req.session.broker, req.params.id);
    if (!imp) return next();
    if (imp.kind === "leads") return res.redirect(303, `/app/leads/import/${imp.id}`);
    imp.canUndo = isManager(req.session.broker) ? await Imports.canUndo(pool, req.session.broker, imp) : false;
    return importPage(req, res, imp.kind === "excel" ? excelPlanPage(imp, lang, req.query || {}) : groupPage(imp, lang));
  });

  // Edit one row of a ready plan: the whole sheet is planned again with the changed cells (same rules as an upload).
  web.post("/import/:id/edit/:row", managersOnly, async (req, res, next) => {
    const lang = langOf(req);
    const cells = {};
    for (const [k, v] of Object.entries(req.body || {})) if (k.startsWith("c_") && typeof v === "string") cells[k.slice(2)] = v;
    const ok = await Imports.editExcelRow(pool, req.session.broker, req.params.id, Number(req.params.row), cells, { lang });
    if (!ok) return next();
    return res.redirect(303, `/app/import/${req.params.id}`);
  });

  // One decision for many rows (rent for the sheet, which price to read, a dollar rate): the sheet is planned again.
  web.post("/import/:id/batch", managersOnly, async (req, res, next) => {
    const lang = langOf(req);
    const out = await Imports.batchExcel(pool, req.session.broker, req.params.id, { action: String(req.body.action || ""), value: String(req.body.value || ""), scope: req.body.scope === "all" ? "all" : "missing", from: String(req.body.from || "").slice(0, 80) }, { lang });
    if (!out) return next();
    return res.redirect(303, `/app/import/${req.params.id}?batch=${out.touched}`);
  });

  web.post("/import/:id/apply", managersOnly, async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const imp = await Imports.loadImport(pool, broker, req.params.id);
    if (!imp || imp.kind === "leads") return next();
    const rows = req.body.all === "1" && imp.kind === "excel" ? (imp.payload.items || []).filter((i) => ["new", "changed"].includes(i.kind)).map((i) => i.row) : [].concat(req.body.rows || []);
    const result =
      imp.kind === "excel"
        ? await Imports.applyExcel(pool, broker, imp.id, { rows, lang })
        : await Imports.applyGroup(pool, broker, imp.id, { rows, lang });
    if (!result) {
      return importPage(req, res, html`<p class="card notice bad">⚠️ ${L(lang, "الاستيراد ده اتطبق قبل كده أو انتهت صلاحيته.", "This import was already applied or has expired.")} <a href="/app/import/${imp.id}">${L(lang, "عرض", "View")}</a></p>`, 409);
    }
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_apply", metadata: { kind: imp.kind, ...Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.length])) } });
    return res.redirect(303, `/app/import/${imp.id}`);
  });

}

module.exports = { register, chatText, TEMPLATE_HEADERS };
