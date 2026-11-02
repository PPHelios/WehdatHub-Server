// web/routes/searchReview.js — The CRM owner's search review (/app/owner/searches): new words the AI proposed (approve or
// reject), open "Wrong search" reports with both readings, and the latest nightly findings.
"use strict";

const Dash = require("../../services/dashboards");
const Learn = require("../../services/searchLearn");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const short = (v) => (v ? JSON.stringify(v).replace(/"[a-z_]+":(null|\[\]|""),?/g, "").slice(0, 400) : "—");

function register(web, { pool, page }) {
  const guard = (req, res, next) => (Dash.isOwner(req.session.broker) ? next() : res.status(404).send("Not found"));

  web.get("/owner/searches", guard, async (req, res) => {
    const lang = langOf(req);
    const [words, reports, audits] = await Promise.all([
      Learn.pending(pool),
      pool.query(
        `SELECT r.id, r.note, r.created_at, s.query_text, s.source, s.local_filters, s.ai_filters, s.used_filters, s.total
           FROM search_reports r JOIN search_log s ON s.id = r.search_log_id WHERE r.status = 'open' ORDER BY r.created_at DESC LIMIT 50`
      ).then((x) => x.rows),
      pool.query(
        `SELECT query_text, total, audit, created_at FROM search_log
          WHERE audit IS NOT NULL AND (audit->>'zero' = 'true' OR jsonb_array_length(audit->'bad_ids') > 0 OR jsonb_array_length(audit->'disagree') > 0 OR jsonb_array_length(audit->'missed_ids') > 0)
          ORDER BY created_at DESC LIMIT 40`
      ).then((x) => x.rows)
    ]);
    const csrf = req.session.csrf;
    return page(req, res, {
      title: L(lang, "مراجعة البحث", "Search review"),
      nav: "owner",
      body: html`<h1>🔎 ${L(lang, "مراجعة البحث", "Search review")}</h1>
<section class="card stack" data-new-words><h2>${L(lang, "كلمات جديدة مقترحة", "New words proposed")}</h2>
${words.length ? html`<table><thead><tr><th>${L(lang, "الكلمة", "Word")}</th><th>${L(lang, "تعني", "Means")}</th><th>${L(lang, "اتفاق الذكاء", "AI agreed")}</th><th>${L(lang, "مثال", "Example")}</th><th></th></tr></thead><tbody>
${words.map((w) => html`<tr data-alias="${w.id}"><td>${w.term}</td><td>${w.target} <span class="muted">(${w.kind})</span></td><td>${w.agreed}</td><td class="muted">${w.example || ""}</td>
<td><form method="post" action="/app/owner/searches/words/${w.id}" class="row"><input type="hidden" name="_csrf" value="${csrf}"><button name="decision" value="approve">${L(lang, "اعتمد", "Approve")}</button> <button name="decision" value="reject" class="secondary">${L(lang, "ارفض", "Reject")}</button></form></td></tr>`)}</tbody></table>` : html`<p class="muted">${L(lang, "مفيش كلمات مقترحة.", "Nothing proposed.")}</p>`}</section>
<section class="card stack" data-reports><h2>${L(lang, "بلاغات «بحث غلط»", "\"Wrong search\" reports")}</h2>
${reports.length ? reports.map((r) => html`<div class="card" data-report="${r.id}"><strong>${r.query_text || "—"}</strong> <span class="muted">(${r.source}, ${r.total})</span>${r.note ? html`<p>${r.note}</p>` : ""}
<p class="muted">${L(lang, "القارئ السريع", "Quick reader")}: <code dir="ltr">${short(r.local_filters)}</code></p>
<p class="muted">${L(lang, "الذكاء", "AI")}: <code dir="ltr">${short(r.ai_filters)}</code></p>
<p class="muted">${L(lang, "اللي اتبحث بيه", "Used")}: <code dir="ltr">${short(r.used_filters)}</code></p></div>`) : html`<p class="muted">${L(lang, "مفيش بلاغات مفتوحة.", "No open reports.")}</p>`}</section>
<section class="card stack" data-audit><h2>${L(lang, "فحص الليل", "Nightly check")}</h2>
${audits.length ? html`<table><thead><tr><th>${L(lang, "البحث", "Search")}</th><th>${L(lang, "النتايج", "Results")}</th><th>${L(lang, "الملاحظة", "Finding")}</th></tr></thead><tbody>
${audits.map((a) => html`<tr><td>${a.query_text || "—"}</td><td>${a.total}</td><td>${[a.audit.zero ? L(lang, "صفر نتايج", "zero results") : "", a.audit.bad_ids?.length ? L(lang, `${a.audit.bad_ids.length} نتيجة غلط`, `${a.audit.bad_ids.length} wrong results`) : "", a.audit.disagree?.length ? L(lang, `اختلاف: ${a.audit.disagree.join("، ")}`, `differ: ${a.audit.disagree.join(", ")}`) : "", a.audit.missed_ids?.length ? L(lang, `${a.audit.missed_ids.length} وحدة فاتت`, `${a.audit.missed_ids.length} missed units`) : ""].filter(Boolean).join(" · ")}</td></tr>`)}</tbody></table>` : html`<p class="muted">${L(lang, "مفيش ملاحظات.", "Nothing found.")}</p>`}</section>`
    });
  });

  web.post("/owner/searches/words/:id", guard, async (req, res) => {
    await Learn.decide(pool, req.params.id, req.body.decision === "approve");
    return res.redirect(303, "/app/owner/searches");
  });
}

module.exports = { register };
