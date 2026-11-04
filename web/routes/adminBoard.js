// web/routes/adminBoard.js — The CRM owner's board (/app/owner/board): seven tabs read from stored results. Opening the
// board never runs the heavy queries; each tab shows when it was last computed and has its own refresh button (cooldown
// in services/adminBoard.js). Owner only: anyone else gets the ordinary 404. Numbers only, no client names or phones.
"use strict";

const AdminBoard = require("../../services/adminBoard");
const Dash = require("../../services/dashboards");
const { html } = require("../html");

const TAB_LABELS = {
  overview: ["نظرة عامة", "Overview"],
  money: ["الفلوس", "Money"],
  ai: ["الذكاء الاصطناعي", "AI"],
  performance: ["الأداء والتأخير", "Performance and delays"],
  search: ["جودة البحث", "Search quality"],
  agencies: ["الوكالات", "Agencies"],
  operations: ["التشغيل", "Operations"]
};
const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const num = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
const when = (iso) => (iso ? `${new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Cairo", hour12: false })} (Cairo)` : "—");
const notFound = (req, res, page) =>
  page(req, res, { title: L(langOf(req), "غير موجود", "Not found"), body: html`<div class="card"><h1>🔍 ${L(langOf(req), "الصفحة غير موجودة", "Page not found")}</h1><p><a href="/app/">${L(langOf(req), "الرئيسية", "Home")}</a></p></div>` }, 404);

const kv = (pairs, lang) => html`<table class="kv"><tbody>${pairs.map(([k, v]) => html`<tr><th>${k}</th><td>${num(v)}</td></tr>`)}</tbody></table>`;
const table = (heads, rows, lang) => (rows.length
  ? html`<div class="table-wrap"><table><thead><tr>${heads.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`
  : html`<p class="muted">${L(lang, "مفيش بيانات في الفترة دي.", "No data in this period.")}</p>`);

function tabBody(tab, data, lang, { agency = "" } = {}) {
  if (tab === "overview") {
    return kv([[L(lang, "المدفوع (ج.م)", "Paid in (EGP)"), data.paidInEgp], [L(lang, "تكلفة الذكاء (ج.م تقريبًا)", "AI cost (EGP, est.)"), data.aiEgp], [L(lang, "مكالمات الذكاء", "AI calls"), data.aiCalls], [L(lang, "وكالات نشطة", "Active agencies"), data.agencies], [L(lang, "بروكرز نشطين", "Active brokers"), data.brokers], [L(lang, "وحدات جديدة", "New units"), data.units], [L(lang, "عملاء جدد", "New leads"), data.leads], [L(lang, "أخطاء", "Errors"), data.errors]], lang);
  }
  if (tab === "money") {
    return html`${kv([[L(lang, "المدفوع (ج.م)", "Paid in (EGP)"), data.paidInEgp], [L(lang, "تكلفة الذكاء (ج.م)", "AI cost (EGP)"), data.aiEgp], [L(lang, "تكاليف ثابتة (ج.م)", "Fixed costs (EGP)"), data.fixedEgp], [L(lang, "الصافي (ج.م)", "Net (EGP)"), data.netEgp], [L(lang, "مدفوعات مستنية", "Payments waiting"), data.pendingPayments]], lang)}
<p class="muted small">${data.note}</p>`;
  }
  if (tab === "ai") {
    const list = data.agencies.filter((a) => !agency || a.id === agency);
    return html`${kv([[L(lang, "إجمالي تقريبي (دولار)", "Total (USD, est.)"), data.totalUsd], [L(lang, "إجمالي (ج.م)", "Total (EGP)"), data.totalEgp], [L(lang, "مكالمات", "Calls"), data.totalCalls]], lang)}
<h3>${L(lang, "الحصة من الباقة لكل وكالة", "Quota used per agency")}</h3>
${table([L(lang, "الوكالة", "Agency"), L(lang, "الباقة", "Plan"), L(lang, "مكالمات", "Calls"), L(lang, "فشل", "Failed"), L(lang, "ج.م", "EGP"), L(lang, "نسبة من الإجمالي", "Share %"), L(lang, "الباقة المستخدمة", "Quota used"), L(lang, "نسبة الباقة", "Quota %")],
    list.map((a) => [a.name, a.plan, num(a.calls), num(a.failed), num(a.egp), `${a.sharePct}%`, `${num(a.quotaUsed)} / ${num(a.quotaTotal)}`, `${a.quotaPct}%`]), lang)}
<h3>${L(lang, "أكتر إجراءات بتكلف", "Most expensive actions")}</h3>
${table([L(lang, "الإجراء", "Action"), L(lang, "مكالمات", "Calls"), L(lang, "ج.م", "EGP"), L(lang, "نسبة %", "Share %")], data.actions.map((x) => [x.action, num(x.calls), num(x.egp), `${x.sharePct}%`]), lang)}`;
  }
  if (tab === "performance") {
    return html`<h3>${L(lang, "متوسط الوقت لكل مرحلة (ms)", "Average time per stage (ms)")}</h3>
${kv(Object.entries(data.avgMs || {}).map(([k, v]) => [k, v]), lang)}
<h3>${L(lang, "الإجراءات", "Actions")}</h3>
${table([L(lang, "الإجراء", "Action"), L(lang, "مكالمات", "Calls"), L(lang, "فشل %", "Error %"), "p50 ms", "p95 ms"], data.byAction.map((x) => [x.action, num(x.calls), `${x.errorPct}%`, num(x.p50Ms), num(x.p95Ms)]), lang)}`;
  }
  if (tab === "search") {
    return html`${kv([[L(lang, "بحثات", "Searches"), data.total], [L(lang, "من غير نتيجة", "No result"), data.noResult], [L(lang, "القارئ والذكاء اختلفوا", "Quick reader and AI disagreed"), data.disagreed], [L(lang, "سألها البوت عن كلمة", "Bot asked about a word"), data.asked], [L(lang, "تهجئة قريبة اتقبلت", "Close spellings accepted"), data.guessed], [L(lang, "فشل قراءة الذكاء", "AI read failed"), data.aiErrors], [L(lang, "بلاغات", "Reports"), data.reports]], lang)}
<h3>${L(lang, "كلمات البوت سألها", "Words the bot asked about")}</h3>
${table([L(lang, "الكلمة", "Word"), L(lang, "مرات", "Times")], data.askedWords.map((x) => [x.w, num(x.n)]), lang)}
<h3>${L(lang, "فلاتر اختلف عليها", "Filters they disagreed on")}</h3>
${table([L(lang, "الفلتر", "Filter"), L(lang, "مرات", "Times")], data.disagreedFilters.map((x) => [x.f, num(x.n)]), lang)}
<h3>${L(lang, "تهجئات قريبة اتقبلت", "Close spellings accepted")}</h3>
${table([L(lang, "المكتوب", "Typed"), L(lang, "اتقرى على إنه", "Read as"), L(lang, "مرات", "Times")], data.guessedSpellings.map((x) => [x.typed, x.as, num(x.n)]), lang)}`;
  }
  if (tab === "agencies") {
    return table([L(lang, "الوكالة", "Agency"), L(lang, "الباقة", "Plan"), L(lang, "بروكرز", "Brokers"), L(lang, "نشطين", "Active"), L(lang, "وحدات", "Units"), L(lang, "عملاء", "Leads"), L(lang, "ذكاء (ج.م)", "AI (EGP)"), L(lang, "آخر نشاط", "Last active")],
      data.filter((a) => !agency || a.id === agency).map((a) => [a.name, a.plan, num(a.brokers), num(a.activeBrokers), num(a.units), num(a.leads), num(a.aiEgp), when(a.lastActive)]), lang);
  }
  return kv([[L(lang, "أخطاء مفتوحة", "Open errors"), data.openErrors], [L(lang, "بلاغات مفتوحة", "Open reports"), data.openReports], [L(lang, "مدفوعات مستنية", "Payments waiting"), data.pendingPayments], [L(lang, "طلبات رصيد مستنية", "Credit requests waiting"), data.pendingCreditRequests], [L(lang, "تسجيلات مستنية", "Sign-ups waiting"), data.pendingSignups]], lang);
}

const PATH = "/app/owner/board";
const link = (tab, days, agency) => `${PATH}?tab=${tab}&days=${days}${agency ? `&agency=${agency}` : ""}`;

function register(web, { pool, page }) {
  const ownerOnly = (handler) => async (req, res) => {
    if (!Dash.isOwner(req.session.broker)) return notFound(req, res, page);
    return handler(req, res, langOf(req));
  };
  const tabOf = (v) => (AdminBoard.TABS.includes(v) ? v : "overview");
  const daysOf = (v) => (AdminBoard.PERIODS.includes(Number(v)) ? Number(v) : 30);

  const boardView = async (req, res, lang, { notice = null, status = 200, tab: tabIn = req.query.tab, days: daysIn = req.query.days } = {}) => {
    const tab = tabOf(tabIn);
    const days = daysOf(daysIn);
    const agency = /^[0-9a-f-]{36}$/i.test(String(req.query.agency || "")) ? String(req.query.agency) : "";
    const stored = await AdminBoard.readTab(pool, tab, days);
    const agencies = stored && tab === "ai" ? stored.data.agencies : [];
    const csrf = req.session.csrf;
    const money = tab === "money" ? await AdminBoard.listFixedCosts(pool) : [];
    const nav = AdminBoard.TABS.map((t) => html`<a href="${link(t, days, agency)}"${t === tab ? html` aria-current="page"` : ""}>${L(lang, TAB_LABELS[t][0], TAB_LABELS[t][1])}</a>`);
    const periods = AdminBoard.PERIODS.map((d) => html`<a href="${link(tab, d, agency)}"${d === days ? html` aria-current="page"` : ""}>${d} ${L(lang, "يوم", "days")}</a>`);
    const body = stored ? tabBody(tab, stored.data, lang, { agency }) : html`<p class="muted">${L(lang, "الرقم لسه متحسبش. دوس تحديث.", "Not computed yet. Press refresh.")}</p>`;
    const fixed = tab === "money" ? html`<section class="card" id="fixed-costs">
  <h3>${L(lang, "تكاليف ثابتة", "Fixed costs")}</h3>
  <form method="post" action="/app/owner/board/fixed-costs" class="row" data-fixed-cost>
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="month" name="month" required aria-label="${L(lang, "الشهر", "Month")}">
    <input name="label" required maxlength="120" placeholder="${L(lang, "مثال: Render", "e.g. Render")}" aria-label="${L(lang, "البند", "Label")}">
    <input name="amount" type="number" min="0" step="any" required placeholder="${L(lang, "ج.م", "EGP")}" aria-label="${L(lang, "المبلغ", "Amount")}">
    <button type="submit">${L(lang, "ضيف", "Add")}</button>
  </form>
  ${table([L(lang, "الشهر", "Month"), L(lang, "البند", "Label"), L(lang, "ج.م", "EGP"), ""], money.map((c) => [c.month, c.label, num(c.amount), html`<form method="post" action="/app/owner/board/fixed-costs/${c.id}/delete" data-confirm="${L(lang, "تمسح البند ده؟", "Delete this cost?")}"><input type="hidden" name="_csrf" value="${csrf}"><button type="submit" class="secondary">${L(lang, "امسح", "Delete")}</button></form>`]), lang)}
</section>` : "";
    const agencyPick = ["ai", "agencies"].includes(tab) ? html`<form method="get" action="${PATH}" class="row"><input type="hidden" name="tab" value="${tab}"><input type="hidden" name="days" value="${days}">
  <select name="agency" data-autosubmit aria-label="${L(lang, "الوكالة", "Agency")}"><option value="">${L(lang, "كل الوكالات", "All agencies")}</option>${agencies.map((a) => html`<option value="${a.id}"${a.id === agency ? html` selected` : ""}>${a.name}</option>`)}</select></form>` : "";
    const refresh = html`<form method="post" action="/app/owner/board/refresh" class="row"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="tab" value="${tab}"><input type="hidden" name="days" value="${days}">
  <button type="submit" class="secondary">🔄 ${L(lang, "حدّث التبويب دي", "Refresh this tab")}</button>
  <span class="muted small">${L(lang, "آخر تحديث", "Last updated")}: <time>${stored ? when(stored.computedAt) : L(lang, "أبدًا", "never")}</time></span></form>`;
    return page(req, res, {
      title: L(lang, "لوحة المالك", "Owner board"), nav: "owner",
      body: html`<p><a href="/app/owner">← ${L(lang, "متابعة التطبيق", "App tracking")}</a></p>
${notice || ""}
<nav class="seg" aria-label="${L(lang, "التبويبات", "Tabs")}">${nav}</nav>
<nav class="seg" aria-label="${L(lang, "الفترة", "Period")}">${periods}</nav>
<section class="card" data-board="${tab}">
  <div class="row">${agencyPick}${refresh}</div>
  ${body}
  ${fixed}
</section>`
    }, status);
  };

  web.get("/owner/board", ownerOnly((req, res, lang) => boardView(req, res, lang)));

  web.post("/owner/board/refresh", ownerOnly(async (req, res, lang) => {
    const tab = tabOf(req.body.tab);
    const r = await AdminBoard.refreshTab(pool, tab);
    const notice = r.error === "cooldown"
      ? html`<p class="card notice bad" role="alert">❌ ${L(lang, "اتحدّثت من شوية. استنى شوية وجرّب تاني.", "Refreshed a moment ago. Wait a bit and try again.")}</p>`
      : html`<p class="card notice ok" role="status">✅ ${L(lang, "اتحدّث.", "Refreshed.")}</p>`;
    return boardView(req, res, lang, { notice, status: r.error ? 429 : 200, tab, days: req.body.days });
  }));

  web.post("/owner/board/fixed-costs", ownerOnly(async (req, res, lang) => {
    const r = await AdminBoard.addFixedCost(pool, { month: req.body.month, label: req.body.label, amount: req.body.amount });
    const notice = r.error
      ? html`<p class="card notice bad" role="alert">❌ ${L(lang, "راجع الشهر والبند والمبلغ.", "Check the month, label and amount.")}</p>`
      : html`<p class="card notice ok" role="status">✅ ${L(lang, "اتضاف.", "Added.")}</p>`;
    return boardView(req, res, lang, { notice, status: r.error ? 422 : 200, tab: "money", days: req.body.days });
  }));

  web.post("/owner/board/fixed-costs/:id/delete", ownerOnly(async (req, res, lang) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return notFound(req, res, page);
    const gone = await AdminBoard.deleteFixedCost(pool, req.params.id);
    const notice = gone
      ? html`<p class="card notice ok" role="status">✅ ${L(lang, "اتمسح.", "Deleted.")}</p>`
      : html`<p class="card notice bad" role="alert">❌ ${L(lang, "مش لاقيه.", "Not found.")}</p>`;
    return boardView(req, res, lang, { notice, status: gone ? 200 : 404, tab: "money" });
  }));
}

module.exports = { register };
