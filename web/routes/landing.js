// web/routes/landing.js — The public landing page at / (phase 2 step 3), Arabic or English (?lang=en): what WehdatHub
// does, the plans, "Open in Telegram", the self-serve trial (Track A: /app/signup) and a "Book a Live Demo / Contact Sales"
// form for offices of 15+ seats (Track B; honeypot, rate limit, same-origin) kept in demo_requests (kind 'demo') that
// alerts the owner. Colours come from the brand tokens (domain/brand.js).
"use strict";

const express = require("express");
const Credits = require("../../services/credits");
const { creditTable } = require("../views/credits");
const RateLimit = require("../../lib/rateLimit");
const ErrorReports = require("../../lib/errorReports");
const Phone = require("../../domain/phone");
const Plans = require("../../domain/plans");
const Signup = require("../../services/signup");
const { BRAND } = require("../../domain/brand");
const { getConfig } = require("../../config");
const { securityHeaders, sameOrigin } = require("../security");
const { html, layout } = require("../html");
const { icon, MARK } = require("../icons");

const T = (lang, ar, en) => (lang === "en" ? en : ar);
const TRY_IP = { limit: 5, windowSec: 3600 };
const num = (n, lang) => Number(n).toLocaleString(lang === "en" ? "en-US" : "ar-EG");

const FEATURE_ICONS = ["mic", "search", "leads", "bell", "link", "chart"];
const FEATURES = [
  ["🎙️", ["ضيف وحدة بفويس وصور", "Add a unit with a voice note and photos"], ["البوت يفهم الكمبوند والمساحة والسعر ويعمل الكارت والكود لوحده.", "The bot picks out the compound, area and price and makes the card and code for you."]],
  ["🔍", ["دوّر بكلامك", "Search in your own words"], ["«شقة في التجمع ٣ غرف تحت ١٠ مليون» وتجيلك النتايج بالصور.", "\"3-bed apartment in New Cairo under 10M\" and the results come with photos."]],
  ["👤", ["عملاءك ومتابعاتك", "Your clients and follow-ups"], ["كارت لكل عميل، مراحل، متابعات، وعملاء إعلانات فيسبوك من ملف CSV.", "A card per client, stages, follow-ups, and Facebook ad leads from a CSV file."]],
  ["🔔", ["تنبيه لما وحدة تناسب عميل", "Alerts when a unit fits a client"], ["أول ما تنزل وحدة تناسب طلب عميل أو سعرها ينزل، بتتبلغ.", "As soon as a unit fits a client's request or drops its price, you hear about it."]],
  ["🔗", ["لينك للعميل", "A link for your client"], ["صفحة للوحدة بالصور، والعميل يقدر يقول «مهتم» من عليها.", "A unit page with photos where the client can say \"I'm interested\"."]],
  ["📈", ["لوحة للمدير", "A dashboard for managers"], ["العملاء والصفقات والعمولة وترتيب البروكرز.", "Leads, deals, commission and the broker leaderboard."]]
];

const STEPS = [
  ["mic", ["ابعت فويس أو شيت", "Send a voice note or sheet"], ["تليجرام، واتساب أو إكسيل — الكارت والكود بيتعملوا لوحدهم.", "Telegram, WhatsApp or Excel — the unit card and code are built automatically."]],
  ["search", ["دوّر ووصّل للعميل", "Search and match instantly"], ["بحث بكلام السوق المصري وتنبيه فوري لأي وحدة تناسب عميل.", "Search in natural Egyptian phrasing with instant client match alerts."]],
  ["link", ["ابعت لينك واقفل الصفقة", "Share a link and close"], ["صفحة شيك للعميل، متابعة واضحة، وحسبة العمولة جاهزة.", "A clean client page, clear follow-ups, and commission tracking ready."]]
];

const ERRORS = {
  name: ["اكتب اسمك.", "Enter your name."],
  phone: ["اكتب رقم موبايل صحيح.", "Enter a valid mobile number."],
  agency: ["اكتب اسم الشركة.", "Enter the agency name."],
  team: ["اكتب عدد البروكرز (رقم).", "Enter the number of brokers (a number)."],
  rate: ["طلبات كتير؛ جرب بعد شوية.", "Too many requests; try again later."]
};

function tryForm(lang, { error, values = {}, sent }) {
  if (sent) {
    return html`<section class="card notice ok lp-try-sent" id="try" role="status">
  <span class="lp-sent-ico" aria-hidden="true">${icon("check", 26)}</span>
  <div><h2>${T(lang, "وصلنا طلبك", "We got your request")}</h2><p>${T(lang, "فريق المبيعات هيكلمك خلال يوم عمل.", "Our sales team will call you within one working day.")}</p></div>
</section>`;
  }
  return html`<form method="post" action="/try?lang=${lang}#try" class="card lp-try" id="try">
  <div class="lp-try-intro">
    <span class="lp-eyebrow">${icon("spark", 15)} ${T(lang, "للمكاتب الكبيرة", "For larger offices")}</span>
    <h2>${T(lang, "احجز عرض مباشر / كلّم المبيعات", "Book a Live Demo / Contact Sales")}</h2>
    <p class="muted">${T(lang, "للمكاتب (١٥ بروكر أو أكتر): سيب بياناتك وهنعمل لك عرض مباشر لفريقك، وبعده تجربة موجّهة ١٤ يوم لكل الفريق.", "For offices (15+ seats): leave your details and we'll run a live demo for your team, then a guided 14-day pilot for everyone.")}</p>
    <p class="muted">${T(lang, `فرد أو فريق صغير؟ ابدأ تجربتك المجانية بنفسك: ${num(Plans.TRIAL.days, lang)} يوم، من غير كارت.`, `A solo broker or a small team? Start your own free trial: ${Plans.TRIAL.days} days, no card.`)} <a href="/app/signup?lang=${lang}">${T(lang, "ابدأ التجربة", "Start the trial")}</a></p>
    <ul class="lp-try-points">
      <li>${icon("check", 16)} ${T(lang, `${num(Plans.TRIAL.days, lang)} يوم مجاناً، من غير كارت`, `${Plans.TRIAL.days} days free, no card`)}</li>
      <li>${icon("shield", 16)} ${T(lang, "بياناتك محمية ومش بتتمسح أبداً", "Your data stays private and is never deleted")}</li>
      <li>${icon("phone", 16)} ${T(lang, "بنستخدم الرقم بس عشان نكلمك بخصوص العرض.", "We use the number only to call you about the demo.")}</li>
    </ul>
  </div>
  <div class="stack lp-try-fields">
    ${error ? html`<p class="notice bad" role="alert">${ERRORS[error][lang === "en" ? 1 : 0]}</p>` : ""}
    <label>${T(lang, "اسمك", "Your name")} <input name="name" required maxlength="80" autocomplete="name" value="${values.name || ""}"></label>
    <label>${T(lang, "اسم الشركة", "Agency name")} <input name="agency" required maxlength="120" autocomplete="organization" value="${values.agency || ""}"></label>
    <div class="grid two"><label>${T(lang, "الموبايل", "Mobile")} <input name="phone" required inputmode="tel" autocomplete="tel" dir="ltr" maxlength="20" value="${values.phone || ""}"></label>
    <label>${T(lang, "عدد البروكرز", "Team size")} <input name="team" type="number" required min="1" max="1000" inputmode="numeric" value="${values.team || ""}"></label></div>
    <label class="hp" aria-hidden="true">Website <input name="website" tabindex="-1" autocomplete="off"></label>
    <button type="submit" class="large">${T(lang, "احجز العرض", "Book a live demo")}</button>
  </div>
</form>`;
}

function landingShowcase(lang) {
  return html`<div class="lp-showcase" aria-hidden="true">
  <div class="lp-mock-voice">
    <span class="lp-mock-mic">${icon("mic", 16)}</span>
    <span class="lp-mock-quote">${T(lang, "«شقة ٣ غرف في التجمع، ١٦٥م، ٨.٥ مليون، استلام فوري»", "\"3-bed flat in New Cairo, 165m², 8.5M EGP, ready to move\"")}</span>
  </div>
  <div class="lp-mock-card">
    <div class="lp-mock-head">
      <span class="lp-mock-code" dir="ltr">NH-A42</span>
      <span class="badge sale">${T(lang, "بيع", "Sale")}</span>
      <strong class="lp-mock-price">${T(lang, "٨,٥٠٠,٠٠٠ ج.م", "8,500,000 EGP")}</strong>
    </div>
    <div class="lp-mock-sub">${T(lang, "شقة · التجمع الخامس · ١٦٥ م² · ٣ غرف · ٢ حمام", "Apartment · New Cairo · 165 m² · 3 Bed · 2 Bath")}</div>
    <div class="lp-mock-chips">
      <span class="chip good">${T(lang, "استلام فوري", "Ready to move")}</span>
      <span class="chip hot">${T(lang, "جاردن", "Garden")}</span>
      <span class="chip new">${T(lang, "كاش أو تقسيط", "Cash / Installments")}</span>
    </div>
  </div>
  <div class="lp-mock-alert">
    <span class="lp-mock-bell">${icon("bell", 16)}</span>
    <span><strong>${T(lang, "٣ عملاء مناسبين", "3 matching buyers")}</strong> · ${T(lang, "اتبلغوا تلقائي بصفحة الوحدة", "Alerted automatically with the unit link")}</span>
  </div>
</div>`;
}

/** A plan card's price: the monthly price when the plan has one, otherwise its cheapest period (Agency is sold for 6 or 12 months). */
function landingPrice(p, lang) {
  const months = Plans.periodsOf(p);
  if (!months.length) return "";
  const m = months[0];
  const price = Plans.priceFor(p, m);
  const per = m === 1 ? T(lang, "شهر", "mo") : T(lang, `${num(m, lang)} شهور`, `${m} months`);
  return html`<div class="price">${num(price, lang)} ${T(lang, "ج.م", "EGP")} <small>/ ${per}</small></div>`;
}

function landingBody(lang, { telegramUrl, form, signupOpen, actions = [] }) {
  const trial = Plans.TRIAL.plan || "office";
  return html`<section class="hero lp-hero">
  <div class="lp-hero-grid">
    <div class="lp-hero-copy">
      <span class="lp-eyebrow">${icon("spark", 15)} ${T(lang, "مبني للبروكرز والشركات العقارية في مصر", "Built for real estate brokers & agencies in Egypt")}</span>
      <h1>${T(lang, "وحداتك وعملاءك في مكان واحد", "Your units and clients in one place")}</h1>
      <p class="lead">${T(lang, "على تيليجرام والموقع. ابعت فويس، البوت يضيف الوحدة ويلاقي لعميلك المناسب في ثواني — من غير تعقيد شيتات.", "On Telegram and the web. Send a voice note; the bot adds the unit and finds what fits your client in seconds — without messy spreadsheets.")}</p>
      <div class="lp-cta">
        ${telegramUrl ? html`<a class="btn large" href="${telegramUrl}" rel="noopener">${icon("send", 18)} ${T(lang, "افتح في تيليجرام", "Open in Telegram")}</a>` : ""}
        ${signupOpen ? html`<a class="btn large${telegramUrl ? " secondary" : ""}" href="/app/signup?lang=${lang}">${icon("building", 18)} ${T(lang, "ابدأ تجربتك المجانية", "Start your free trial")}</a>` : ""}
        <a class="btn large${telegramUrl || signupOpen ? " secondary" : ""}" href="#try">${T(lang, "احجز عرض مباشر", "Book a live demo")}</a>
      </div>
      <ul class="lp-trust">
        <li>${icon("check", 15)} ${T(lang, `${num(Plans.TRIAL.days, lang)} يوم ببلاش`, `${Plans.TRIAL.days} days free`)}</li>
        <li>${icon("check", 15)} ${T(lang, "من غير كارت", "No card needed")}</li>
        <li>${icon("shield", 15)} ${T(lang, "بياناتك مش بتتمسح", "Data never deleted")}</li>
      </ul>
    </div>
    ${landingShowcase(lang)}
  </div>
</section>
<section class="lp-steps" aria-label="${T(lang, "إزاي بيشتغل", "How it works")}">
  <ol>${STEPS.map(
    ([ic, title, text], idx) => html`<li><span class="lp-step-n">${idx + 1}</span><div class="lp-step-body"><strong>${icon(ic, 18)} ${title[lang === "en" ? 1 : 0]}</strong><p>${text[lang === "en" ? 1 : 0]}</p></div></li>`
  )}</ol>
</section>
<section id="features" class="lp-features" aria-label="${T(lang, "المميزات", "Features")}">
  <div class="lp-sec-head">
    <h2>${T(lang, "كل أدوات شغلك اليومي في مكان واحد", "Everything your brokerage needs every day")}</h2>
    <p class="muted">${T(lang, "من إضافة الوحدة بالفويس لحد قفل الصفقة وحساب العمولة.", "From voice-note unit capture to closing deals and tracking commissions.")}</p>
  </div>
  <ul>${FEATURES.map(
    ([, title, text], idx) => html`<li><span class="lp-ico" aria-hidden="true">${icon(FEATURE_ICONS[idx] || "spark", 22)}</span><div><h3>${title[lang === "en" ? 1 : 0]}</h3><p>${text[lang === "en" ? 1 : 0]}</p></div></li>`
  )}</ul>
</section>
<section id="plans" class="lp-plans">
  <div class="lp-sec-head">
    <h2>${T(lang, "الباقات (شهري)", "Plans (monthly)")}</h2>
    <p class="muted">${T(lang, "ابدأ ببلاش واختار الباقة اللي تناسب حجم فريقك.", "Start free and pick the plan that fits your team size.")}</p>
  </div>
  <div class="lp-plan-row">${Plans.PLANS.map(
    (p) => html`<div class="lp-plan${p.id === trial ? " on" : ""}" data-plan="${p.id}">
    <div class="lp-plan-top"><strong>${Plans.planName(p, lang)}</strong>${p.id === trial ? html`<span class="chip new">${T(lang, "التجربة عليها", "Trial plan")}</span>` : ""}</div>
    ${landingPrice(p, lang)}
    <ul>
      <li>${icon("check", 16)} ${p.seats === 1 ? T(lang, "مستخدم واحد", "1 user") : T(lang, `${num(p.seats, lang)} مستخدمين`, `${p.seats} users`)}</li>
      <li>${icon("check", 16)} ${T(lang, `${num(p.credits, lang)} رصيد ذكاء اصطناعي في الشهر`, `${num(p.credits, "en")} AI credits a month`)}</li>
    </ul>
    ${p.seats >= 15
      ? html`<a class="btn secondary small lp-plan-btn" href="#try" data-plan-cta="demo">${T(lang, "احجز عرض مباشر", "Book a live demo")}</a>`
      : html`<a class="btn ${p.id === trial ? "" : "secondary "}small lp-plan-btn" href="${signupOpen ? `/app/signup?lang=${lang}` : "#try"}" data-plan-cta="trial">${T(lang, "ابدأ التجربة", "Start trial")}</a>`}
  </div>`
  )}<div class="lp-plan" data-plan="enterprise">
    <div class="lp-plan-top"><strong>${T(lang, "إنتربرايز", "Enterprise")}</strong></div>
    <div class="price">${T(lang, "٥٠+ مستخدم", "50+ seats")}</div>
    <ul><li>${icon("check", 16)} ${T(lang, "سعر خاص ودعم مخصص", "Custom pricing and dedicated support")}</li></ul>
    <a class="btn secondary small lp-plan-btn" href="#try" data-plan-cta="sales">${T(lang, "كلّم المبيعات", "Contact Sales")}</a>
  </div></div>
  <p class="muted small lp-plan-note">${T(
    lang,
    `أول ${num(Plans.TRIAL.days, lang)} يوم تجربة مجانية (مستخدم واحد، ${num(Plans.TRIAL.units, lang)} وحدة، ${num(Plans.TRIAL.credits, lang)} رصيد ذكاء اصطناعي)، من غير كارت. رصيد زيادة: ${Plans.BUNDLES.map((b) => `${num(b.credits, lang)} بـ ${num(b.priceEgp, lang)} ج.م`).join("، ")}. الدفع بإنستاباي أو تحويل بنكي. سولو وفريق: ابدأ بنفسك. المكاتب (١٥ مستخدم فأكتر) والإنتربرايز (٥٠+): احجز عرض مباشر. بياناتك مش بتتمسح أبداً.`,
    `The first ${Plans.TRIAL.days} days are a free trial (1 user, ${Plans.TRIAL.units} units, ${Plans.TRIAL.credits} AI credits), no card. Extra credits: ${Plans.BUNDLES.map((b) => `${b.credits} for ${b.priceEgp} EGP`).join(", ")}. Pay by InstaPay or bank transfer. Solo and Team: start on your own. Offices (15+ seats) and Enterprise (50+): book a live demo. Your data is never deleted.`
  )}</p>
</section>
${creditTable(actions, lang)}
${form}
<footer class="lp-foot">
  <span class="lp-foot-brand">${MARK}<strong>${lang === "en" ? BRAND.name : "وحدات هب"}</strong></span>
  <nav class="lp-foot-links" aria-label="${T(lang, "روابط", "Links")}">
    <a href="/app/guide?lang=${lang}">${T(lang, "الدليل", "Guide")}</a>
    <a href="/privacy?lang=${lang}">${T(lang, "الخصوصية", "Privacy")}</a>
    <a href="/terms?lang=${lang}">${T(lang, "الشروط", "Terms")}</a>
    <a href="/app/">${T(lang, "دخول", "Sign in")}</a>
  </nav>
</footer>`;
}

function mountLanding(app, { pool, assets }) {
  const render = async (req, res, lang, form = {}, status = 200) => {
    const signupOpen = await Signup.isOpen(pool);
    const actions = await Credits.actions(pool);
    const username = getConfig().telegram.botUsername;
    const telegramUrl = /^[A-Za-z0-9_]{5,32}$/.test(username || "") ? `https://t.me/${username}` : null;
    const other = lang === "en" ? "ar" : "en";
    return res
      .status(status)
      .type("html")
      .send(
        String(
          layout({
            assets: assets.url,
            lang,
            title: T(lang, "وحداتك وعملاءك على تيليجرام", "Units and clients on Telegram"),
            robots: "index, follow",
            scripts: false,
            manifest: false,
            head: html`<meta name="description" content="${T(lang, "WehdatHub: مساعد الوحدات والعملاء للبروكرز والشركات العقارية في مصر، على تيليجرام والموقع.", "WehdatHub: the units and clients assistant for real estate brokers and agencies in Egypt, on Telegram and the web.")}">
<meta property="og:title" content="${BRAND.name}">
<link rel="alternate" hreflang="${other}" href="/?lang=${other}">
<script src="${assets.url("theme.js")}" defer></script>`,
            body: html`<nav class="top lp-top">
  <a class="brand" href="/?lang=${lang}">${MARK}${lang === "en" ? html`<span dir="ltr">Wehdat <b>Hub</b></span>` : html`<span>وحدات <b>هب</b></span>`}</a>
  <div class="lp-nav-links">
    <a href="#features">${T(lang, "المميزات", "Features")}</a>
    <a href="#plans">${T(lang, "الباقات", "Plans")}</a>
    <a href="#try">${T(lang, "جرّبه", "Try it")}</a>
  </div>
  <button type="button" class="lp-theme theme-toggle" data-theme-toggle aria-label="${T(lang, "تبديل المظهر", "Switch theme")}"><span class="ico-sun">${icon("sun", 16)} ${T(lang, "فاتح", "Light")}</span><span class="ico-moon">${icon("moon", 16)} ${T(lang, "داكن", "Dark")}</span></button>
  <a class="lp-lang" href="/?lang=${other}" data-lang-switch hreflang="${other}">${other === "en" ? "English" : "العربية"}</a>
  <a class="btn small" href="/app/">${T(lang, "دخول", "Sign in")}</a>
</nav>
${landingBody(lang, { telegramUrl, form: tryForm(lang, form), signupOpen, actions })}`
          })
        )
      );
  };
  const langOf = (req) => (req.query.lang === "en" ? "en" : "ar");

  app.get("/", securityHeaders, async (req, res) => {
    res.set("Cache-Control", "no-cache");
    return render(req, res, langOf(req), { sent: req.query.sent === "1" });
  });

  app.post("/try", securityHeaders, sameOrigin(), express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 20 }), async (req, res) => {
    const lang = langOf(req);
    const body = req.body || {};
    const values = {
      name: String(body.name || "").trim().slice(0, 80),
      agency: String(body.agency || "").trim().slice(0, 120),
      phone: String(body.phone || "").trim().slice(0, 20),
      team: String(body.team || "").trim().slice(0, 4)
    };
    const done = () => res.redirect(303, `/?lang=${lang}&sent=1#try`);
    if (body.website) return done();
    if (!values.name) return render(req, res, lang, { error: "name", values }, 400);
    if (!values.agency) return render(req, res, lang, { error: "agency", values }, 400);
    const e164 = Phone.toE164(values.phone);
    if (!e164) return render(req, res, lang, { error: "phone", values }, 400);
    if (!/^\d{1,4}$/.test(values.team) || Number(values.team) < 1 || Number(values.team) > 1000) return render(req, res, lang, { error: "team", values }, 400);
    const gate = await RateLimit.hit(pool, `try:ip:${req.ip}`, TRY_IP);
    if (!gate.allowed) return render(req, res, lang, { error: "rate", values }, 429);
    const team = /^\d{1,4}$/.test(values.team) && Number(values.team) >= 1 && Number(values.team) <= 1000 ? Number(values.team) : null;
    const { rows } = await pool.query(
      "INSERT INTO demo_requests (name, agency_name, phone_e164, team_size, lang, kind) VALUES ($1, $2, $3, $4, $5, 'demo') RETURNING id",
      [values.name, values.agency, e164, team, lang]
    );
    ErrorReports.alertOwner(
      [`📅 Demo request #D${rows[0].id}`, `${values.name} · ${values.agency}`, `📞 ${e164}`, `👥 ${team} brokers`].filter(Boolean).join("\n")
    ).catch(() => {});
    return done();
  });
}

module.exports = { mountLanding, FEATURES };
