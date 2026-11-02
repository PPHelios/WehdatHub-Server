// web/routes/usage.js — "My usage": WhatsApp message credits this month (mine, the agency's; managers: per broker, caps)
"use strict";

const Credits = require("../../lib/credits");
const UnitCode = require("../../domain/unitCode");
const { MANAGER_ROLES, isAgencyOwner } = require("../../lib/authz");
const Switches = require("../../services/aiSwitches");
const Billing = require("../../services/billing");
const AiCredits = require("../../services/credits");
const { creditTable } = require("../views/credits");
const AiLog = require("../../services/aiUsageLog");
const Fx = require("../../services/fx");
const FxDomain = require("../../domain/fx");
const Dash = require("../../services/dashboards");
const { html } = require("../html");
const { tabs } = require("../views/tabs");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const isManager = (b) => MANAGER_ROLES.includes(String(b.role || "").toLowerCase());

const ACTIONS = {
  search: ["بحث", "Search"],
  add_unit: ["إضافة وحدة", "Add a unit"],
  edit: ["تعديل", "Edit"],
  quick_update: ["تحديث سريع", "Quick update"],
  flyer: ["بروشور", "Flyer"],
  client_copy: ["نص العميل", "Client copy"],
  crm: ["العملاء", "Clients (CRM)"],
  notification: ["تنبيهات", "Notifications"],
  other: ["أخرى", "Other"]
};
const actionLabel = (a, lang) => (ACTIONS[a] || ACTIONS.other)[lang === "en" ? 1 : 0];
const optInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** F24: the AI use log with its filters and the Excel link. base = the page's path. */
function aiLogPage(lang, log, filters, base, title, balance = null) {
  const q = (extra = {}) => {
    const p = new URLSearchParams(Object.entries({ month: log.month, broker: filters.brokerId || "", feature: filters.feature || "", ...extra }).filter(([, v]) => v));
    return p.toString();
  };
  const KIND = { text: ["نص", "Text"], voice: ["فويس", "Voice"], page: ["صفحة", "Page"] };
  return html`<h1>🤖 ${title}</h1>
<form method="get" action="${base}" class="card row" data-ai-log-filter>
  <label>${L(lang, "الشهر", "Month")} <input type="month" name="month" value="${log.month}" dir="ltr"></label>
  <label>${L(lang, "المستخدم", "User")} <select name="broker"><option value="">${L(lang, "الكل", "Everyone")}</option>${log.brokers.map((b) => html`<option value="${b.id}"${filters.brokerId === b.id ? html` selected` : ""}>${b.name}</option>`)}</select></label>
  <label>${L(lang, "الخاصية", "Feature")} <select name="feature"><option value="">${L(lang, "الكل", "All")}</option>${log.features.map((f) => html`<option value="${f}"${filters.feature === f ? html` selected` : ""}>${AiLog.featureLabel(f, lang)}</option>`)}</select></label>
  <button type="submit" class="secondary">${L(lang, "عرض", "Show")}</button>
  <a class="btn secondary" href="${base}.xlsx?${q()}" data-ai-log-export>⬇️ ${L(lang, "إكسيل", "Excel")}</a>
</form>
<section class="card">
  <p data-ai-log-totals>${L(lang, `نص: ${log.totals.text} · فويس: ${log.totals.voice} · صفحات: ${log.totals.page}`, `Text: ${log.totals.text} · Voice: ${log.totals.voice} · Pages: ${log.totals.page}`)}</p>
  <p data-ai-log-credits><strong>${L(lang, `الرصيد المستخدم: ${log.totals.credits}`, `Credits used: ${log.totals.credits}`)}</strong>${balance ? L(lang, ` من ${balance.limit} · المتبقي ${Math.max(0, balance.limit - balance.used)}`, ` of ${balance.limit} · ${Math.max(0, balance.limit - balance.used)} left`) : ""}</p>
  <p class="muted">${L(lang, "كل عملية بالذكاء الاصطناعي بتاخد رصيد من رصيد الوكالة الشهري.", "Every AI action uses credits from the agency's monthly pool.")}</p>
  ${log.rows.length
    ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "الوقت", "Time")}</th><th>${L(lang, "المستخدم", "User")}</th><th>${L(lang, "الخاصية", "Feature")}</th><th>${L(lang, "اتحسب من", "Counted as")}</th><th>${L(lang, "الرصيد", "Credits")}</th></tr></thead>
  <tbody>${log.rows.map((r) => html`<tr data-ai-row="${r.feature}"><td dir="ltr">${AiLog.cairoTime(r.at)}</td><td>${r.broker}</td><td>${AiLog.featureLabel(r.feature, lang)}</td><td>${KIND[r.kind][lang === "en" ? 1 : 0]}</td><td>${r.credits}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش استهلاك في الفترة دي.", "No use in this period.")}</p>`}
</section>`;
}

function register(web, { pool, page }) {
  // F24: managers see their agency's AI log; the app owner any agency's (/app/owner links here).
  const logFor = async (req, res, agencyId, base, title, xlsx, { onlyBroker = null } = {}) => {
    const lang = langOf(req);
    const filters = AiLog.filtersOf(req.query);
    if (onlyBroker) filters.brokerId = onlyBroker;
    const log = await AiLog.list(pool, agencyId, filters);
    if (onlyBroker) {
      log.brokers = log.brokers.filter((b) => b.id === onlyBroker);
      log.features = [...new Set(log.rows.map((r) => r.feature))].sort();
    }
    if (xlsx) {
      return res
        .set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="ai-usage-${log.month}.xlsx"` })
        .send(await AiLog.workbook(log, lang));
    }
    return page(req, res, { title, nav: "settings", body: aiLogPage(lang, log, filters, base, title, (await Billing.allowance(pool, agencyId)).credits) });
  };
  for (const xlsx of [false, true]) {
    web.get(`/usage/log${xlsx ? ".xlsx" : ""}`, (req, res) => {
      const { broker } = req.session;
      return logFor(req, res, broker.agency_id, "/app/usage/log", L(langOf(req), "سجل استهلاك الذكاء الاصطناعي", "AI usage log"), xlsx, { onlyBroker: isManager(broker) ? null : broker.id });
    });
    web.get(`/owner/agencies/:id/ai-log${xlsx ? ".xlsx" : ""}`, async (req, res) => {
      if (!Dash.isOwner(req.session.broker) || !/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).type("text/plain").send("Not found");
      const { rows } = await pool.query("SELECT name FROM agencies WHERE id = $1", [req.params.id]);
      if (!rows[0]) return res.status(404).type("text/plain").send("Not found");
      return logFor(req, res, req.params.id, `/app/owner/agencies/${req.params.id}/ai-log`, `${L(langOf(req), "استهلاك الذكاء الاصطناعي", "AI usage")}: ${rows[0].name}`, xlsx);
    });
  }

  web.get("/usage", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const manager = isManager(broker);
    const state = await Credits.check(pool, broker);
    const [ai, aiActions] = await Promise.all([Billing.allowance(pool, broker.agency_id), AiCredits.actions(pool)]);
    const mine = await Credits.usage(pool, broker.agency_id, { brokerId: broker.id });
    const agency = manager ? await Credits.usage(pool, broker.agency_id) : null;
    const own = manager ? (await pool.query("SELECT name, code_prefix, crm_settings FROM agencies WHERE id = $1", [broker.agency_id])).rows[0] : null;
    const codePrefix = own ? own.code_prefix || UnitCode.prefixFrom(own.name) : "";
    const rates = FxDomain.ratesFrom(own?.crm_settings?.fx);
    const fxCard = manager ? html`<form method="post" action="/app/usage/fx" class="card stack" data-fx-rates>
  <h2>${L(lang, "سعر الدولار واليورو", "Dollar and euro rates")}</h2>
  ${req.query.fx === "bad" ? html`<p class="bad">${L(lang, "السعر لازم يكون رقم بين 1 و 1000، أو فاضي.", "The rate must be a number from 1 to 1000, or blank.")}</p>` : ""}
  <p class="muted">${L(lang, "بالجنيه لكل وحدة. الوحدات والميزانيات بالدولار أو اليورو بتتحول بيه في البحث. لو فاضي، الوحدات دي مش هتتطابق مع الأسعار.", "In EGP per unit. Dollar and euro units and budgets convert at this rate in search. Blank means those units do not match prices.")}</p>
  <label>${L(lang, "الدولار (ج.م لكل دولار)", "USD (EGP per dollar)")} <input name="USD" inputmode="decimal" dir="ltr" value="${rates.USD ?? ""}" size="8"></label>
  <label>${L(lang, "اليورو (ج.م لكل يورو)", "EUR (EGP per euro)")} <input name="EUR" inputmode="decimal" dir="ltr" value="${rates.EUR ?? ""}" size="8"></label>
  <button type="submit">${L(lang, "حفظ السعر", "Save rates")}</button>
</form>` : "";    const cls = state.level === "ok" ? "" : state.level === "warn" ? "warn" : "bad";
    const mineCard = html`<section class="card">
  <h2>${L(lang, "رسايلي", "My messages")}</h2>
  <p>${L(lang, `النهارده: ${mine.today} · الشهر الحالي: ${mine.total}`, `Today: ${mine.today} · This month: ${mine.total}`)}</p>
  ${mine.actions.length
    ? html`<table><thead><tr><th>${L(lang, "العملية", "Action")}</th><th>${L(lang, "النهارده", "Today")}</th><th>${L(lang, "الشهر", "Month")}</th></tr></thead>
  <tbody>${mine.actions.map((a) => html`<tr data-action="${a.action}"><td>${actionLabel(a.action, lang)}</td><td>${a.today}</td><td>${a.n}</td></tr>`)}</tbody></table>`
    : html`<p class="muted">${L(lang, "مفيش رسايل الشهر الحالي.", "No messages this month.")}</p>`}
  <p class="muted">${L(lang, "نصيحة: البحث الطويل والإضافة والاستيراد ببلاش على الموقع.", "Tip: long searches, adding units and imports are free on the website.")}</p>
</section>`;
    return page(req, res, {
      title: L(lang, "الاستهلاك", "Usage"),
      nav: "settings",
      body: html`<h1>${L(lang, "الاستهلاك", "Usage")}</h1>
${req.query.saved === "1" ? html`<p class="card notice ok" role="status">✅ ${L(lang, "اتحفظت.", "Saved.")}</p>` : ""}
<section class="card usage-hero" data-credits-used="${state.used}" data-credits-limit="${state.limit}" data-level="${state.level}">
  <h2>${L(lang, "رصيد رسايل واتساب للوكالة (الشهر الحالي)", "Agency WhatsApp credits (this month)")}</h2>
  <meter class="${cls}" min="0" max="${state.limit}" low="${Math.round(state.limit * 0.8)}" high="${state.limit}" value="${Math.min(state.used, state.limit)}">${state.pct}%</meter>
  <p class="big"><strong>${state.used}</strong> / ${state.limit} · ${L(lang, `باقي ${state.remaining}`, `${state.remaining} left`)} (${state.pct}%)</p>
  <details class="how"><summary>${L(lang, "الرصيد بيتحسب إزاي؟", "How credits work")}</summary><p class="muted">${L(
    lang,
    "١ رصيد = ١ رسالة البوت يبعتها (ردود وتنبيهات). ببلاش: كل حاجة على الموقع، إشعارات الموقع، وعلامة «اتقرت». عند 100% التنبيهات بتوصل على الموقع والردود مستمرة؛ عند الحد الأقصى البوت بيبعت تنبيه واحد في اليوم وبعدها بيعلّم الرسايل مقروءة بس.",
    "1 credit = 1 message the bot sends (replies and alerts). Free: everything on the website, website notifications and read ticks. At 100% alerts move to the website and replies continue; at the ceiling the bot sends one notice a day, then only marks messages as read."
  )}</p></details>
</section>
<section class="card" data-ai-credits="${ai.credits.used}" data-ai-credits-limit="${ai.credits.limit}">
  <h2>🤖 ${L(lang, "رصيد الذكاء الاصطناعي (الشهر الحالي)", "AI credits (this month)")}</h2>
  <meter min="0" max="${ai.credits.limit}" value="${Math.min(ai.credits.used, ai.credits.limit)}"></meter>
  <p class="big"><strong>${ai.credits.used}</strong> / ${ai.credits.limit} · ${L(lang, `باقي ${Math.max(0, ai.credits.limit - ai.credits.used)}`, `${Math.max(0, ai.credits.limit - ai.credits.used)} left`)}</p>
  <p><a href="/app/usage/log">${L(lang, "سجل الاستخدام سطر بسطر", "Use log, line by line")}</a>${isAgencyOwner(broker) ? html` · <a href="/app/plan">${L(lang, "اطلب رصيد زيادة", "Ask for more credits")}</a>` : manager ? html` · <span class="muted">${L(lang, "لزيادة الرصيد كلّم مالك الوكالة", "To add credits, ask your agency owner")}</span>` : ""}</p>
  ${creditTable(aiActions, lang)}
</section>
${manager
  ? tabs("usage_tab", [
      [L(lang, "أنا", "Me"), mineCard],
      [L(lang, "الفريق", "Team"), html`<section class="card">
  <h2>${L(lang, "كل الوسطاء", "Every broker")}</h2>
  <table><thead><tr><th>${L(lang, "الوسيط", "Broker")}</th><th>${L(lang, "النهارده", "Today")}</th><th>${L(lang, "الشهر", "Month")}</th></tr></thead>
  <tbody>${agency.brokers.map((b) => html`<tr data-broker="${b.id}"><td>${b.name}</td><td>${b.today}</td><td>${b.n}</td></tr>`)}</tbody></table>
  <p class="muted">${L(lang, `روابط الدخول (مش محسوبة من الرصيد): ${agency.login}`, `Sign-in links (not counted in the credits): ${agency.login}`)}</p>
</section>`],
      [L(lang, "الإعدادات", "Settings"), html`${fxCard}<form method="post" action="/app/usage/agency" class="card stack">
  <h2>${L(lang, "رصيد الوكالة وحدود الوسطاء", "Agency credits and broker caps")}</h2>
  <label>${L(lang, "الرصيد الشهري (رسايل)", "Monthly credits (messages)")} <input type="number" name="monthly" min="0" max="100000" value="${state.limit}"></label>
  <label>${L(lang, "حد يومي لكل وسيط (فاضي = بدون حد)", "Daily cap per broker (empty = off)")} <input type="number" name="daily_cap" min="1" max="10000" value="${state.broker.dailyCap ?? ""}"></label>
  <label>${L(lang, "حد أسبوعي لكل وسيط (فاضي = بدون حد)", "Weekly cap per broker (empty = off)")} <input type="number" name="weekly_cap" min="1" max="50000" value="${state.broker.weeklyCap ?? ""}"></label>
  <label>${L(lang, "حروف أكواد الوحدات (مثال NH ← NH-V12)", "Unit code letters (e.g. NH → NH-V12)")} <input name="code_prefix" maxlength="4" pattern="[A-Za-z]{1,4}" dir="ltr" value="${codePrefix}"></label>
  <p class="muted">${L(lang, "للوحدات اللي بتتضاف من غير كود. الأكواد القديمة مش بتتغير.", "For units added without a code. Existing codes don't change.")}</p>
  <button type="submit">${L(lang, "حفظ", "Save")}</button>
</form>
${isAgencyOwner(broker) ? html`<p class="card"><a href="/app/usage/ai" data-ai-switches-link>🎚️ ${L(lang, "مفاتيح ميزات الذكاء الاصطناعي (تشغيل وإيقاف)", "AI feature switches (on and off)")}</a></p>` : ""}
<p class="card"><a href="/app/usage/log" data-ai-log-link>🤖 ${L(lang, "سجل استهلاك الذكاء الاصطناعي (سطر بسطر، مع تصدير إكسيل)", "AI usage log (line by line, with Excel export)")}</a></p>`]
    ], { open: req.query.saved === "1" ? 2 : 0 })
  : mineCard}`
    });
  });

  // 🎚️ The agency owner's AI feature switches: one per feature, a master switch per tab.
  web.get("/usage/ai", async (req, res) => {
    const { broker } = req.session;
    if (!isAgencyOwner(broker)) return res.status(403).send("Agency owner only");
    const lang = langOf(req);
    const sw = await Switches.forAgency(pool, broker.agency_id);
    return page(req, res, { title: L(lang, "ميزات الذكاء الاصطناعي", "AI features"), nav: "settings", body: html`<h1>${L(lang, "ميزات الذكاء الاصطناعي", "AI features")}</h1>
<p class="muted">${L(lang, "أي ميزة مقفولة بيختفي زرها ومبتصرفش رصيد. مفتاح التبويب بيقفل كل اللي تحته.", "A feature that is off hides its button and spends no credits. A tab's master switch turns off everything under it.")}</p>
${req.query.saved === "1" ? html`<p class="ok">${L(lang, "اتحفظ.", "Saved.")}</p>` : ""}
<form method="post" action="/app/usage/ai" class="stack" data-ai-switches><input type="hidden" name="_csrf" value="${req.session.csrf}">
${sw.tabs.map((t) => html`<fieldset class="card stack" data-tab="${t.id}"><legend><label class="row"><input type="checkbox" name="tab_${t.id}" value="on"${t.on ? html` checked` : ""}> <b>${L(lang, t.ar, t.en)}</b></label></legend>
${t.features.map((f) => html`<label class="row"><input type="checkbox" name="f_${f.key}" value="on"${f.on ? html` checked` : ""}> ${L(lang, f.ar, f.en)}</label>`)}</fieldset>`)}
<button type="submit">${L(lang, "حفظ", "Save")}</button></form>
<p><a href="/app/usage">${L(lang, "رجوع", "Back")}</a></p>` });
  });

  web.post("/usage/ai", async (req, res) => {
    const { broker } = req.session;
    if (!isAgencyOwner(broker)) return res.status(403).send("Agency owner only");
    await Switches.save(pool, broker, req.body);
    return res.redirect(303, "/app/usage/ai?saved=1");
  });

  web.post("/usage/fx", async (req, res) => {
    const { broker } = req.session;
    if (!isManager(broker)) return res.status(403).send("Managers only");
    const out = await Fx.saveRates(pool, broker, { USD: req.body.USD, EUR: req.body.EUR });
    return res.redirect(303, out.error ? "/app/usage?fx=bad" : "/app/usage?saved=1");
  });

  web.post("/usage/agency", async (req, res) => {
    const { broker } = req.session;
    if (!isManager(broker)) return res.status(403).send("Managers only");
    const monthly = parseInt(req.body.monthly, 10);
    // A prefix that isn't 1–4 Latin letters keeps the current one.
    await pool.query(
      `UPDATE agencies SET wa_credits_monthly = $2, wa_broker_daily_cap = $3, wa_broker_weekly_cap = $4, code_prefix = COALESCE($5, code_prefix) WHERE id = $1`,
      [broker.agency_id, Number.isInteger(monthly) && monthly >= 0 && monthly <= 100000 ? monthly : null, optInt(req.body.daily_cap), optInt(req.body.weekly_cap), UnitCode.cleanPrefix(req.body.code_prefix)]
    );
    return res.redirect(303, "/app/usage?saved=1");
  });
}

module.exports = { register };
