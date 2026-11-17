// web/routes/settings.js — A broker's settings: language, channel per notification kind, quiet hours, web push
"use strict";

const Notifications = require("../../lib/notifications");
const WebPush = require("../../lib/channels/webpush");
const { getConfig } = require("../../config");
const { html } = require("../html");
const { switchField } = require("../views/switches");
const { fxForm, capsForm } = require("../views/agencySettings");
const Passkeys = require("../../services/passkeys");
const { passkeySection } = require("./passkeys");
const { isManager, isDataEntry, isCrmOwner, isAgencyOwner } = require("../../lib/authz");
const AgencyLogo = require("../../services/agencyLogo");
const Storage = require("../../lib/supabase");
const Session = require("../session");
const { uploads } = require("../uploads");

// C7: the agency logo on client pages and PDFs (managers upload it here).
const uploadLogo = uploads([{ name: "logo", maxCount: 1, accept: /^image\/(png|jpeg|webp)$/ }], { maxMb: 2 });
Session.allowMultipart(/^\/settings\/logo$/);

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hh = (h) => `${String(h).padStart(2, "0")}:00`;

async function loadBroker(pool, broker) {
  const { rows } = await pool.query("SELECT notify_prefs, telegram_chat_id, draft_style, quiet_line FROM brokers WHERE id = $1 AND agency_id = $2", [broker.id, broker.agency_id]);
  return { ...broker, notify_prefs: rows[0]?.notify_prefs || {}, telegram_chat_id: rows[0]?.telegram_chat_id || null, draft_style: rows[0]?.draft_style || null, quiet_line: rows[0]?.quiet_line !== false };
}

/** Managers: the agency's logo (shown on client pages and payment-schedule PDFs). */
function brandSection(lang, agency, notice) {
  return html`<section class="card stack" id="brand">
  <h2>🏢 ${L(lang, "شعار الشركة", "Agency logo")}</h2>
  ${notice || ""}
  <p class="muted">${L(lang, "بيظهر للعملاء على صفحات الوحدات وجداول الدفع PDF مع اسم الشركة ورقم البروكر.", "Clients see it on unit pages and payment-schedule PDFs, with the agency's name and the broker's number.")}</p>
  ${agency.logo_url ? html`<img class="logo" src="${Storage.photoUrl(agency.logo_url)}" alt="" data-agency-logo>` : html`<p class="muted" data-agency-logo="none">${L(lang, "لسه مفيش شعار.", "No logo yet.")}</p>`}
  <form method="post" action="/app/settings/logo" enctype="multipart/form-data" class="row">
    <input type="file" name="logo" accept="image/png,image/jpeg,image/webp" required>
    <button type="submit" class="secondary">${L(lang, "تحميل الشعار", "Upload logo")}</button>
  </form>
  ${agency.logo_url ? html`<form method="post" action="/app/settings/logo/remove" data-confirm="${L(lang, `تشيل شعار الشركة؟ مش هينفع ترجع.`, `Remove the agency logo? This can't be undone.`)}"><button type="submit" class="link">${L(lang, "شيل الشعار", "Remove the logo")}</button></form>` : ""}
</section>`;
}

/** One notification's row: on/off, channel and frequency. A setting the owner or a manager locked is shown and not editable. */
function notifyRow(k, policy, broker, lang, tgOn) {
  const Policy = require("../../lib/notificationPolicy");
  const eff = Policy.resolve(policy, Notifications.ownChoiceOf(broker, k), k);
  const urgent = Policy.isUrgent(k);
  const by = eff.locked === "owner" ? L(lang, "المالك", "the owner") : L(lang, "المدير", "your manager");
  // A person who has not chosen a channel sees the default their notifications use (Telegram and website when linked).
  const shownChannel = eff.channel || Notifications.prefsOf(broker, { telegramLinked: Boolean(broker.telegram_chat_id) }).channels[k];
  const lockNote = eff.locked ? html` <span class="muted small" data-locked-by="${eff.locked}">🔒 ${L(lang, `اتقفلت من ${by}`, `set by ${by}`)}</span>` : "";
  const fixed = (f) => eff.lockedFields.includes(f);
  // The channels are check boxes: Telegram, website, phone app. "both" is stored when Telegram is on with the website or the app.
  const chosen = new Set(shownChannel === "both" ? ["telegram", "web"] : [shownChannel]);
  const chOpts = [
    ["telegram", L(lang, "تليجرام", "Telegram"), tgOn],
    ["web", L(lang, "الموقع", "Website"), true],
    ["app", L(lang, "التطبيق", "Phone app"), true]
  ].filter(([, , show]) => show);
  // A kind that is off shows every control off; the person's own channels come back when they turn it on again.
  const chFixed = fixed("channel");
  return html`<div class="notify-row" data-notify="${k}"><label>${Notifications.KIND_LABELS[k][lang === "en" ? 1 : 0]}${lockNote}</label>
  ${urgent ? html`<p class="muted small">${L(lang, "دايماً شغّال وفوري", "Always on and immediate")}</p>` : html`${switchField({ name: `on_${k}`, value: "1", send0: true, on: eff.enabled, lang, disabled: fixed("on"), label: L(lang, "تشغيل", "On"), sentence: L(lang, "شغّله عشان توصلك التنبيهات دي.", "Turn on to get these alerts.") })}`}
  <fieldset class="choice" data-channels="${k}"><legend>${L(lang, "القناة", "Channel")}</legend><div class="row">${chOpts.map(([v, text]) => html`<label class="check"><input type="checkbox" name="ch_${k}" value="${v}" data-kind="${k}"${chFixed ? html` data-fixed` : ""}${eff.enabled && chosen.has(v) ? html` checked` : ""}${chFixed || !eff.enabled ? html` disabled` : ""}${eff.enabled ? "" : chosen.has(v) ? html` data-was` : ""}> ${text}</label>`)}</div></fieldset>
  ${urgent ? "" : html`<label>${L(lang, "التكرار", "How often")} <select name="fq_${k}" data-kind="${k}"${fixed("frequency") ? html` data-fixed` : ""}${fixed("frequency") || !eff.enabled ? html` disabled` : ""}>${[["immediate", L(lang, "فوري", "Immediately")], ["hourly", L(lang, "كل ساعة (ملخص)", "Hourly (summary)")], ["daily", L(lang, "يومياً ٩ الصبح (ملخص)", "Daily at 9 (summary)")]].map(([v, text]) => html`<option value="${v}"${eff.frequency === v ? html` selected` : ""}>${text}</option>`)}</select></label>`}
</div>`;
}

/** Theme: light, dark or the phone's choice (the same buttons as the More page; web/static/app.js remembers it). */
function appearanceCard(lang) {
  return html`<section class="card stack" id="appearance">
  <h2>🎨 ${L(lang, "المظهر", "Appearance")}</h2>
  <div class="row" data-theme-row>
    <button type="button" class="chip" data-theme-set="system">${L(lang, "النظام", "System")}</button>
    <button type="button" class="chip" data-theme-set="light">${L(lang, "فاتح", "Light")}</button>
    <button type="button" class="chip" data-theme-set="dark">${L(lang, "داكن", "Dark")}</button>
  </div>
</section>`;
}

/**
 * The Agency section (the owner, and managers where the owner allows): logo, unit code letters, currency rates, who sees
 * private details, brokers editing units, the credits caps, and the places for team notifications and AI use per person.
 * A manager sees only what they may change: what is the owner's (logo, quota, data security, broker rights) is not shown.
 */
async function agencySection({ pool, req, broker, lang, brandHtml }) {
  const Privacy = require("../../services/unitPrivacy");
  const Rights = require("../../services/unitRights");
  const UnitCode = require("../../domain/unitCode");
  const FxDomain = require("../../domain/fx");
  const { privacySection, brokerEditSection, leadScopeSection } = require("./dashboard");
  const owner = isAgencyOwner(broker);
  const [ag, scope, brokersWrite, seeAllLeads] = await Promise.all([
    pool.query("SELECT name, code_prefix, crm_settings FROM agencies WHERE id = $1", [broker.agency_id]).then((r) => r.rows[0] || {}),
    Privacy.scopeOf(pool, broker.agency_id),
    Rights.brokersMayWrite(pool, broker.agency_id),
    require("../../services/leadScope").brokersSeeAll(pool, broker.agency_id)
  ]);
  const rates = FxDomain.ratesFrom(ag.crm_settings?.fx);
  const codePrefix = ag.code_prefix || UnitCode.prefixFrom(ag.name || "");
  const csrf = req.session.csrf;
  return html`<section id="agency" class="sect stack" data-settings-section="agency">
  <h1 class="sect-title">🏢 ${L(lang, "الشركة", "Agency")}</h1>
  ${req.query.saved === "1" ? html`<p class="card notice ok" role="status">✅ ${L(lang, "اتحفظت.", "Saved.")}</p>` : ""}
  ${owner ? brandHtml : ""}
  ${capsForm({ lang, codePrefix, ret: "settings", id: "agency-caps" })}
  ${fxForm({ lang, rates, bad: req.query.fx === "bad", ret: "settings", id: "fx" })}
  ${owner ? html`${privacySection(scope, lang, csrf, req.query.saved === "1" ? "saved" : null, owner, "settings")}
  ${brokerEditSection(brokersWrite, lang, csrf, owner, "settings")}
  ${leadScopeSection(seeAllLeads, lang, csrf, owner, "settings")}` : ""}
  <section class="card stack" id="agency-links">
    <h2>${L(lang, "أماكن تانية", "More agency settings")}</h2>
    <p><a class="btn secondary" href="/app/team#notify-policy">🔔 ${L(lang, "تنبيهات الفريق (قناة وتكرار لكل تنبيه)", "Team notifications (channel and frequency for each alert)")}</a></p>
    <p><a class="btn secondary" href="/app/usage#ai-limits" data-ai-usage-link>🤖 ${L(lang, "استهلاك الذكاء الاصطناعي لكل شخص", "AI use per person")}</a></p>
    ${owner ? html`<p><a class="btn secondary" href="/app/usage/ai">🎚️ ${L(lang, "مفاتيح ميزات الذكاء الاصطناعي", "AI feature switches")}</a></p>` : ""}
  </section>
</section>`;
}

/** The Plan and billing section (the agency owner): this month's plan and credits, with the places to pay and ask for more. */
async function planSection({ pool, broker, lang }) {
  const Billing = require("../../services/billing");
  const Plans = require("../../domain/plans");
  const a = await Billing.allowance(pool, broker.agency_id);
  return html`<section id="plan" class="sect stack" data-settings-section="plan">
  <h1 class="sect-title">💳 ${L(lang, "الباقة والفواتير", "Plan and billing")}</h1>
  <div class="card stack" data-plan-summary>
    <p><strong>${Plans.planName(a.plan, lang)}</strong></p>
    <p>${L(lang, `رصيد الذكاء الاصطناعي هذا الشهر: ${a.credits.used} من ${a.credits.limit}`, `AI credits this month: ${a.credits.used} of ${a.credits.limit}`)}</p>
    <p><a class="btn secondary" href="/app/usage#plan">${L(lang, "الباقة والدفع وطلب رصيد زيادة", "Plan, payments and more credits")}</a></p>
  </div>
</section>`;
}

function register(web, { pool, page }) {
  web.get("/settings", async (req, res) => {
    const lang = langOf(req);
    const broker = await loadBroker(pool, req.session.broker);
    const tgOn = getConfig().telegram.enabled;
    const prefs = Notifications.prefsOf(broker, { telegramLinked: tgOn && Boolean(broker.telegram_chat_id) });
    const opt = (k, v, label) => html`<option value="${v}"${prefs.channels[k] === v ? html` selected` : ""}>${label}</option>`;
    const pushes = await Notifications.pushCount(pool, broker);
    const key = getConfig().webPush.publicKey;
    const saved = req.query.saved === "1";
    const pushed = req.query.test;
    const crm = isCrmOwner(broker); // the CRM owner is no agency member: no logo, no client-message style
    const manager = isManager(broker) && !crm;
    const kinds = Notifications.kindsFor(broker);
    const policy = require("../../lib/notificationPolicy").policyOf((await pool.query("SELECT notify_policy FROM agencies WHERE id = $1", [broker.agency_id])).rows[0]);
    const dataEntry = isDataEntry(broker) || crm;
    const agency = manager && isAgencyOwner(broker) ? (await pool.query("SELECT logo_url FROM agencies WHERE id = $1", [broker.agency_id])).rows[0] || {} : null;
    const logoNotice = { saved: ["✅ الشعار اتحفظ.", "✅ Logo saved."], bad: ["❌ الصورة مش مفهومة. حمل PNG أو JPG أو WebP أقل من 2 ميجا.", "❌ Unreadable image. Upload a PNG, JPG or WebP under 2 MB."], removed: ["الشعار اتشال.", "Logo removed."], failed: ["❌ التحميل فشل، جرب تاني.", "❌ The upload failed; try again."] }[req.query.logo];
    const passkeyNotice = { on: ["✅ اتفتحت. ضيف Passkey على الجهاز ده.", "✅ On. Add a passkey on this device."], off: ["اتقفلت، والـ Passkeys اتمسحت.", "Off; your passkeys were removed."], removed: ["الـ Passkey اتمسحت.", "Passkey removed."] }[req.query.passkey];
    const owner = isAgencyOwner(broker) && !crm;
    const brandHtml = manager && agency ? brandSection(lang, agency, logoNotice ? html`<p class="notice" data-logo-notice="${req.query.logo}">${L(lang, ...logoNotice)}</p>` : "") : "";
    const agencyHtml = manager ? await agencySection({ pool, req, broker, lang, brandHtml }) : "";
    const planHtml = owner ? await planSection({ pool, broker, lang }) : "";
    // One Settings area, three sections; a role sees the sections it may use.
    const sectionNav = manager || owner
      ? html`<nav class="tabnav" role="tablist" aria-label="${L(lang, "أقسام الإعدادات", "Settings sections")}" data-settings-nav><a href="#me" role="tab" aria-selected="true">${L(lang, "أنا", "Me")}</a>${manager ? html`<a href="#agency" role="tab" aria-selected="false">${L(lang, "الشركة", "Agency")}</a>` : ""}${owner ? html`<a href="#plan" role="tab" aria-selected="false">${L(lang, "الباقة والفواتير", "Plan and billing")}</a>` : ""}</nav>`
      : "";
    return page(req, res, {
      title: L(lang, "الإعدادات", "Settings"),
      nav: "settings",
      body: html`<h1>⚙️ ${L(lang, "الإعدادات", "Settings")}</h1>
${sectionNav}
${saved ? html`<p class="card notice ok" role="status">✅ ${L(lang, "اتحفظت.", "Saved.")}</p>` : ""}
${pushed === "ok" ? html`<p class="card notice ok" role="status">🔔 ${L(lang, "اتبعت إشعار تجربة.", "Test notification sent.")}</p>` : ""}
${pushed === "none" ? html`<p class="card notice bad" role="status">${L(lang, "الإشعارات مش مفعلة على أي جهاز لسه.", "Notifications aren't on in any browser yet.")}</p>` : ""}
<section id="me" class="sect stack" data-settings-section="me">
<h1 class="sect-title">🙋 ${L(lang, "أنا", "Me")}</h1>
<div class="fold" data-fold>
<form method="post" action="/app/settings" class="card stack">
  <h2>🌐 ${L(lang, "اللغة", "Language")}</h2>
  <label>${L(lang, "لغة الموقع ورسايل البوت", "Website and bot language")}
    <select name="lang"><option value="ar"${lang === "ar" ? html` selected` : ""}>العربية</option><option value="en"${lang === "en" ? html` selected` : ""}>English</option></select>
  </label>
  ${kinds.length ? html`  <h2>🔔 ${L(lang, "التنبيهات توصلك فين؟", "Where do alerts reach you?")}</h2>
  <p class="muted">${L(
    lang,
    "التنبيه بيوصل على القناة اللي اخترتها. لو تليجرام مش متوصل أو فشل، بيوصل على الموقع أو التطبيق. وكله بيتسجل في 🔔.",
    "Each alert comes on the channel you choose. When Telegram is not linked or fails, it comes on the website or the app. All of them are kept in 🔔."
  )}</p>
  ${kinds.map((k) => notifyRow(k, policy, broker, lang, tgOn))}
` : ""}
  <h2>⏰ ${L(lang, "تذكير المكالمات والمعاينات", "Reminders for calls and viewings")}</h2>
  <p class="muted">${L(lang, "ابعتلي تذكير قبل الميعاد بكام؟ الاختيار واحد أو أكتر. الافتراضي ساعة. التذكير بيوصل حتى لو في ساعات الهدوء.", "Remind me this long before: one or more. Default one hour. Reminders arrive even during quiet hours.")}</p>
  <div class="row">${[30, 60, 120].map((m) => html`<label class="check"><input type="checkbox" name="rm_${m}" value="1"${(prefs.reminderMinutes || [60]).includes(m) ? html` checked` : ""}> ${m === 30 ? L(lang, "نص ساعة", "30 min") : m === 60 ? L(lang, "ساعة", "1 hour") : L(lang, "ساعتين", "2 hours")}</label>`)}</div>
  <h2>🌙 ${L(lang, "ساعات الهدوء (بتوقيت القاهرة)", "Quiet hours (Cairo time)")}</h2>
  <label class="check"><input type="checkbox" name="quiet_on" value="1"${prefs.quiet.enabled ? html` checked` : ""}> ${L(lang, "متبعتليش تنبيهات في الوقت ده (بتتجمع وتوصل بعده)", "Hold alerts during these hours (they arrive together after)")}</label>
  <div class="row">
    <label>${L(lang, "من", "From")} <select name="quiet_start">${HOURS.map((h) => html`<option value="${h}"${h === prefs.quiet.start ? html` selected` : ""}>${hh(h)}</option>`)}</select></label>
    <label>${L(lang, "لحد", "Until")} <select name="quiet_end">${HOURS.map((h) => html`<option value="${h}"${h === prefs.quiet.end ? html` selected` : ""}>${hh(h)}</option>`)}</select></label>
  </div>
  <button type="submit">${L(lang, "حفظ", "Save")}</button>
</form>
${appearanceCard(lang)}
${dataEntry ? "" : html`<form method="post" action="/app/settings/quiet-line" class="card stack" id="quiet-line">
  <h2>⏳ ${L(lang, "سطر «بقالك 60 يوم مكلمتوش»", "The \"60 days since you spoke\" line")}</h2>
  <label class="check"><input type="checkbox" name="on" value="1"${broker.quiet_line !== false ? html` checked` : ""}> ${L(lang, "في تنبيه الوحدات المناسبة، قولي لو العميل بقاله 60 يوم أو أكتر من غير مكالمة", "In match alerts, tell me when I haven't spoken to the client for 60 days or more")}</label>
  <button type="submit" class="secondary">${L(lang, "حفظ", "Save")}</button>
</form>`}
${dataEntry ? "" : html`<form method="post" action="/app/settings/draft-style" class="card stack" id="draft-style">
  <h2>✍️ ${L(lang, "أسلوبك في رسايل العملاء", "Your style for client messages")}</h2>
  <p class="muted">${L(lang, "اختياري: الصق رسالة أو اتنين من اللي بتبعتها للعملاء، ورسايل المتابعة اللي البوت بيكتبها هتبقى بنفس أسلوبك.", "Optional: paste one or two messages you send to clients, and the follow-up drafts will sound like you.")}</p>
  <textarea name="style" rows="3" maxlength="600">${broker.draft_style || ""}</textarea>
  <button type="submit" class="secondary">${L(lang, "حفظ", "Save")}</button>
</form>`}
${passkeySection({ enabled: await Passkeys.isEnabled(pool, broker), keys: await Passkeys.list(pool, broker), lang, notice: passkeyNotice ? L(lang, ...passkeyNotice) : null })}
<section class="card" id="push" data-vapid="${key}" data-push-count="${pushes}">
  <h2>📲 ${L(lang, "إشعارات الموقع على الجهاز ده", "Website notifications on this device")}</h2>
  <p>${pushes
    ? L(lang, `مفعلة على ${pushes} جهاز.`, `On in ${pushes} browser(s).`)
    : L(lang, "مش مفعلة لسه.", "Not on yet.")}</p>
  ${key
    ? html`<div class="row">
    <button type="button" data-push="enable">${L(lang, "🔔 فعّل الإشعارات هنا", "🔔 Turn on here")}</button>
    <button type="button" class="secondary" data-push="disable">${L(lang, "إيقاف هنا", "Turn off here")}</button>
  </div>
  <p class="muted" data-push-status></p>`
    : html`<p class="muted">${L(lang, "الإشعارات لسه مش متجهزة على السيرفر.", "Push isn't configured on the server yet.")}</p>`}
  <form method="post" action="/app/push/test"><button type="submit" class="secondary">${L(lang, "ابعت إشعار تجربة", "Send a test notification")}</button></form>
  <p class="muted">${L(
    lang,
    "آيفون: افتح الموقع من Safari ← زرار المشاركة ← «إضافة إلى الشاشة الرئيسية»، وبعدين افتحه من الأيقونة وفعّل الإشعارات.",
    "iPhone: open the site in Safari → Share → \"Add to Home Screen\", then open it from the icon and turn notifications on."
  )}</p>
</section>
</div>
</section>
${agencyHtml}
${planHtml}`
    });
  });

  web.post("/settings", async (req, res) => {
    const { broker } = req.session;
    const channels = {};
    // Check boxes (telegram, web, app) become the stored single value; nothing ticked (or locked) keeps the old choice.
    for (const k of Notifications.kindsFor(broker)) {
      const v = new Set([].concat(req.body[`ch_${k}`] ?? []).map(String));
      const tg = v.has("telegram") || v.has("both");
      const web = v.has("web") || v.has("both");
      channels[k] = tg && (web || v.has("app")) ? "both" : tg ? "telegram" : v.has("app") ? "app" : web ? "web" : undefined;
    }
    const on = {};
    const frequency = {};
    for (const k of Notifications.kindsFor(broker)) {
      const onValue = [].concat(req.body[`on_${k}`] ?? []).pop(); // a switch posts "0" then "1" when on
      if (onValue === "0" || onValue === "1") on[k] = onValue === "1";
      if (["immediate", "hourly", "daily"].includes(req.body[`fq_${k}`])) frequency[k] = req.body[`fq_${k}`];
    }
    await Notifications.savePrefs(pool, await loadBroker(pool, broker), {
      channels,
      on,
      frequency,
      quiet: { enabled: req.body.quiet_on === "1", start: req.body.quiet_start, end: req.body.quiet_end },
      reminderMinutes: [30, 60, 120].filter((m) => req.body[`rm_${m}`] === "1")
    });
    const lang = req.body.lang === "en" ? "en" : "ar";
    if (lang !== broker.preferred_lang) {
      await pool.query("UPDATE brokers SET preferred_lang = $3 WHERE id = $1 AND agency_id = $2", [broker.id, broker.agency_id, lang]);
    }
    return res.redirect(303, "/app/settings?saved=1");
  });

  // From the browser's PushManager (web/static/app.js): endpoint and keys as form fields.
  web.post("/settings/quiet-line", async (req, res) => {
    const { broker } = req.session;
    await pool.query("UPDATE brokers SET quiet_line = $3 WHERE id = $1 AND agency_id = $2", [broker.id, broker.agency_id, req.body.on === "1"]);
    return res.redirect(303, "/app/settings?saved=1#quiet-line");
  });

  web.post("/settings/draft-style", async (req, res) => {
    await require("../../services/followUpDrafts").saveStyle(pool, req.session.broker, req.body.style);
    return res.redirect(303, "/app/settings?saved=1#draft-style");
  });

  web.post("/settings/logo", uploadLogo, async (req, res) => {
    const out = await AgencyLogo.setLogo(pool, req.session.broker, (req.files?.logo || [])[0]);
    if (out.error === "forbidden") return res.status(403).send("Agency owner only");
    return res.redirect(303, `/app/settings?logo=${out.ok ? "saved" : out.error === "bad" ? "bad" : "failed"}#brand`);
  });

  web.post("/settings/logo/remove", async (req, res) => {
    const out = await AgencyLogo.removeLogo(pool, req.session.broker);
    if (out.error === "forbidden") return res.status(403).send("Agency owner only");
    return res.redirect(303, "/app/settings?logo=removed#brand");
  });

  web.post("/push/subscribe", async (req, res) => {
    const ok = await Notifications.savePushSubscription(
      pool,
      req.session.broker,
      { endpoint: req.body.endpoint, keys: { p256dh: req.body.p256dh, auth: req.body.auth } },
      req.get("User-Agent") || ""
    );
    return res.status(ok ? 204 : 400).end();
  });

  web.post("/push/unsubscribe", async (req, res) => {
    await Notifications.removePushSubscription(pool, req.session.broker, req.body.endpoint);
    return res.status(204).end();
  });

  web.post("/push/test", async (req, res) => {
    const { broker } = req.session;
    const en = broker.preferred_lang === "en";
    const r = await WebPush.send(broker, { title: en ? "🔔 WehdatHub test" : "🔔 تجربة WehdatHub", url: "/app/notifications", push: { body: en ? "Notifications work on this device." : "الإشعارات شغالة على الجهاز ده." } }, { pool });
    return res.redirect(303, `/app/settings?test=${r.ok ? "ok" : "none"}`);
  });
}

module.exports = { register };
