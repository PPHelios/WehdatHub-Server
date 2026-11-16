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
const { switchField, choiceField } = require("../views/switches");
const AiLimits = require("../../services/aiUserLimits");
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
  <p class="muted">${L(lang, "كل عملية بالذكاء الاصطناعي بتاخد رصيد من رصيد الشركة الشهري.", "Every AI action uses credits from the agency's monthly pool.")}</p>
  ${log.rows.length
    ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "الوقت", "Time")}</th><th>${L(lang, "المستخدم", "User")}</th><th>${L(lang, "الخاصية", "Feature")}</th><th>${L(lang, "اتحسب من", "Counted as")}</th><th>${L(lang, "الرصيد", "Credits")}</th></tr></thead>
  <tbody>${log.rows.map((r) => html`<tr data-ai-row="${r.feature}"><td dir="ltr">${AiLog.cairoTime(r.at)}</td><td>${r.broker}</td><td>${AiLog.featureLabel(r.feature, lang)}</td><td>${KIND[r.kind][lang === "en" ? 1 : 0]}</td><td>${r.credits}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش استهلاك في الفترة دي.", "No use in this period.")}</p>`}
</section>`;
}

/**
 * AI use per person (spec-web.md sections 4 and 4b). Every person sees their own standing; managers and the owner also see
 * everyone's use. Only the owner changes the settings, or a manager when the owner allowed it; brokers never see the controls.
 */
function aiLimitSections(lang, broker, lim, query = {}) {
  const owner = isAgencyOwner(broker);
  const manager = isManager(broker);
  const m = lim.mine;
  const mineCard = html`<section class="card" data-ai-mine data-ai-mode="${lim.mode}">
  <h2>${L(lang, "استهلاكي للذكاء الاصطناعي", "My AI use")}</h2>
  ${lim.mode === "per_user"
    ? m.allowance == null
      ? html`<p>${L(lang, `مفيش حد شخصي ليك. استهلكت ${m.used} الشهر ده.`, `You have no personal limit. Used ${m.used} this month.`)}</p>`
      : html`<p data-ai-own-limit><strong>${L(lang, `حدك في الذكاء الاصطناعي: ${m.allowance} الشهر ده، استهلكت ${m.used}`, `Your AI limit: ${m.allowance} this month, used ${m.used}`)}</strong></p>
  <meter min="0" max="${m.allowance}" value="${Math.min(m.used, m.allowance)}"></meter>`
    : html`<p>${L(lang, `استهلكت ${m.used} الشهر ده، من رصيد الشركة المشترك.`, `You used ${m.used} this month, from the agency's shared pool.`)}</p>`}
  <p><a href="/app/usage/log">${L(lang, "سجلي سطر بسطر", "My log, line by line")}</a></p>
</section>`;
  if (!manager) return mineCard;
  const can = lim.canEdit;
  const peopleRows = lim.people.map(
    (p) => html`<tr data-ai-person="${p.id}"><td>${p.name}</td><td>${can ? html`<input type="number" name="ov_${p.id}" min="0" max="1000000" inputmode="numeric" value="${p.override ?? ""}" placeholder="${lim.defaultCredits ?? ""}" aria-label="${L(lang, "حد " + p.name, "Limit for " + p.name)}">` : p.allowance ?? "—"}</td><td>${p.used}</td></tr>`
  );
  const body = html`${choiceField({
    name: "ai_mode",
    value: lim.mode,
    disabled: !can,
    legend: L(lang, "رصيد الذكاء الاصطناعي بيتوزع إزاي؟", "How is AI credit shared?"),
    options: [
      { value: "pool", label: L(lang, "رصيد مشترك", "Shared pool"), hint: L(lang, "كل الفريق بياخد من رصيد الشركة الشهري.", "Everyone draws from the agency's monthly credits.") },
      { value: "per_user", label: L(lang, "كل شخص له حد", "Each person has a limit"), hint: L(lang, "كل شخص له حد شهري، وده فوق رصيد الشركة. الرصيد المشترك لسه هو السقف.", "Each person has a monthly limit on top of the pool. The pool still caps the agency.") }
    ]
  })}
  <label>${L(lang, "الحد الافتراضي لكل شخص (فاضي = بدون حد)", "Default limit per person (blank = none)")} <input type="number" name="ai_default" min="0" max="1000000" inputmode="numeric" value="${lim.defaultCredits ?? ""}"${can ? "" : html` disabled`}></label>
  <div class="scroll"><table><thead><tr><th>${L(lang, "الشخص", "Person")}</th><th>${L(lang, "الحد (فاضي = الافتراضي)", "Limit (blank = default)")}</th><th>${L(lang, "استهلك الشهر ده", "Used this month")}</th></tr></thead><tbody>${peopleRows}</tbody></table></div>`;
  return html`${mineCard}<section class="card stack" id="ai-limits" data-ai-limits>
  <h2>${L(lang, "الذكاء الاصطناعي لكل شخص", "AI use per person")}</h2>
  ${query.ai === "saved" ? html`<p class="notice ok" role="status">✅ ${L(lang, "اتحفظ.", "Saved.")}</p>` : ""}
  ${query.ai === "bad" ? html`<p class="notice bad" role="alert">❌ ${L(lang, "الرقم لازم يكون عدد صحيح من 0 لـ 1,000,000، أو فاضي.", "A limit must be a whole number from 0 to 1,000,000, or blank.")}</p>` : ""}
  ${can
    ? html`<form method="post" action="/app/usage/ai-limits" class="stack" data-ai-limits-form>${body}<button type="submit">${L(lang, "حفظ", "Save")}</button></form>`
    : html`<div class="stack" data-ai-limits-readonly>${body}<p class="muted" data-ai-limits-locked>${L(lang, "مالك الشركة لم يسمح للمديرين بتغيير ده.", "The agency owner has not allowed managers to change this")}</p></div>`}
  ${owner
    ? html`<form method="post" action="/app/usage/ai-limits/managers" class="stack" data-ai-managers-form>${switchField({ name: "allowed", on: lim.managerCanEdit, lang, label: L(lang, "المديرين يقدروا يغيّروا إعدادات الذكاء الاصطناعي", "Managers can change AI usage settings"), sentence: L(lang, "لما يكون شغّال، المدير يشوف الإعدادات دي ويقدر يغيّرها. لما يتقفل، يشوفها للقراءة بس.", "When on, managers see these settings and can change them. When off, they see them read only.") })}<button type="submit" class="secondary">${L(lang, "حفظ", "Save")}</button></form>`
    : ""}
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
    const lim = await AiLimits.overview(pool, broker);
    const agency = manager ? await Credits.usage(pool, broker.agency_id) : null;
    const own = manager ? (await pool.query("SELECT name, code_prefix, crm_settings FROM agencies WHERE id = $1", [broker.agency_id])).rows[0] : null;
    const codePrefix = own ? own.code_prefix || UnitCode.prefixFrom(own.name) : "";
    const rates = FxDomain.ratesFrom(own?.crm_settings?.fx);
    // The dollar and euro rates, the credits caps and the unit code letters are on Settings now (web/views/agencySettings.js).
    const cls = state.level === "ok" ? "" : state.level === "warn" ? "warn" : "bad";
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
  <h2>${L(lang, "رصيد رسايل واتساب للشركة (الشهر الحالي)", "Agency WhatsApp credits (this month)")}</h2>
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
  <p><a href="/app/usage/log">${L(lang, "سجل الاستخدام سطر بسطر", "Use log, line by line")}</a>${isAgencyOwner(broker) ? html` · <a href="/app/plan">${L(lang, "اطلب رصيد زيادة", "Ask for more credits")}</a>` : manager ? html` · <span class="muted">${L(lang, "لزيادة الرصيد كلّم مالك الشركة", "To add credits, ask your agency owner")}</span>` : ""}</p>
  ${creditTable(aiActions, lang)}
</section>
${aiLimitSections(lang, broker, lim, req.query)}
${manager
  ? tabs("usage_tab", [
      [L(lang, "أنا", "Me"), mineCard],
      [L(lang, "الفريق", "Team"), html`<section class="card">
  <h2>${L(lang, "كل البروكرز", "Every broker")}</h2>
  <table><thead><tr><th>${L(lang, "البروكر", "Broker")}</th><th>${L(lang, "النهارده", "Today")}</th><th>${L(lang, "الشهر", "Month")}</th></tr></thead>
  <tbody>${agency.brokers.map((b) => html`<tr data-broker="${b.id}"><td>${b.name}</td><td>${b.today}</td><td>${b.n}</td></tr>`)}</tbody></table>
  <p class="muted">${L(lang, `روابط الدخول (مش محسوبة من الرصيد): ${agency.login}`, `Sign-in links (not counted in the credits): ${agency.login}`)}</p>
</section>`],
      [L(lang, "الإعدادات", "Settings"), html`<p class="card"><a href="/app/settings#agency" data-agency-settings-link>⚙️ ${L(lang, "إعدادات الشركة (الأسعار وحدود البروكرز وحروف الأكواد) في صفحة الإعدادات", "Agency settings (rates, broker caps, unit code letters) are on the Settings page")}</a></p>
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
${sw.tabs.map((t) => html`<fieldset class="card stack" data-tab="${t.id}"><legend>${L(lang, t.ar, t.en)}</legend>${switchField({ name: `tab_${t.id}`, on: t.on, lang, label: L(lang, "الكل في التبويب ده", "This whole tab") })}
${t.features.map((f) => switchField({ name: `f_${f.key}`, on: f.on, lang, label: L(lang, f.ar, f.en) }))}</fieldset>`)}
<button type="submit">${L(lang, "حفظ", "Save")}</button></form>
<p><a href="/app/usage">${L(lang, "رجوع", "Back")}</a></p>` });
  });

  web.post("/usage/ai", async (req, res) => {
    const { broker } = req.session;
    if (!isAgencyOwner(broker)) return res.status(403).send("Agency owner only");
    await Switches.save(pool, broker, req.body);
    return res.redirect(303, "/app/usage/ai?saved=1");
  });

  // AI use per person: mode, default limit and per-person limits. The owner, or a manager the owner allowed.
  web.post("/usage/ai-limits", async (req, res) => {
    const { broker } = req.session;
    const overrides = {};
    for (const [k, v] of Object.entries(req.body || {})) if (k.startsWith("ov_") && /^[0-9a-f-]{36}$/i.test(k.slice(3))) overrides[k.slice(3)] = v;
    const r = await AiLimits.save(pool, broker, { mode: req.body.ai_mode, defaultCredits: req.body.ai_default, overrides });
    if (r.error === "forbidden") return res.status(403).type("text/plain").send(L(langOf(req), "مش مسموح", "Not allowed"));
    return res.redirect(303, `/app/usage?ai=${r.ok ? "saved" : "bad"}#ai-limits`);
  });

  // The agency owner lets managers change those settings (or not).
  web.post("/usage/ai-limits/managers", async (req, res) => {
    const r = await AiLimits.setManagerCanEdit(pool, req.session.broker, req.body.allowed === "on");
    if (!r.ok) return res.status(403).type("text/plain").send(L(langOf(req), "لمالك الشركة بس", "Agency owner only"));
    return res.redirect(303, "/app/usage?ai=saved#ai-limits");
  });

  web.post("/usage/fx", async (req, res) => {
    const { broker } = req.session;
    if (!isManager(broker)) return res.status(403).send("Managers only");
    const out = await Fx.saveRates(pool, broker, { USD: req.body.USD, EUR: req.body.EUR });
    if (req.body.return === "settings") return res.redirect(303, out.error ? "/app/settings?fx=bad#fx" : "/app/settings?saved=1#fx");
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
    if (req.body.return === "settings") return res.redirect(303, "/app/settings?saved=1#agency-caps");
    return res.redirect(303, "/app/usage?saved=1");
  });
}

module.exports = { register };
