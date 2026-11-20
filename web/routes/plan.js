// web/routes/plan.js — "Plan" (phase 2 step 4): the agency's plan in force, this month's AI credits (used / pool), seats; managers
// announce a payment (a plan for 1, 6 or 12 months, only the periods its price table offers, or an extra credit bundle) and can ask the owner for more credits and get the amount, a
// reference and where to pay (InstaPay or bank, as the owner set it); the owner confirms on /app/owner. Managers also
// get the agency's invite code and link (Release B N9: both agencies get a free month when the invited one pays).
"use strict";

const Billing = require("../../services/billing");
const Referrals = require("../../services/referrals");
const BillingNotices = require("../../services/billingNotices");
const Plans = require("../../domain/plans");
const { MANAGER_ROLES, isAgencyOwner } = require("../../lib/authz");
const { html } = require("../html");
const Credits = require("../../services/credits");

const { L } = require("../../lib/copy");
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const isManager = (b) => MANAGER_ROLES.includes(String(b.role || "").toLowerCase());
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");
const num = (n) => Number(n).toLocaleString("en-US");

const SOURCE = {
  pilot: ["تجربة الإطلاق: باقة المكتب مجاناً لحد نهاية التجربة", "Pilot: Office plan free until the pilot ends"],
  paid: ["مدفوعة", "Paid"],
  trial: ["تجربة مجانية", "Free trial"],
  free: ["الباقة المجانية", "Free plan"],
  grace: ["فترة سماح: الباقة خلصت", "Grace period: the plan ended"],
  readonly: ["للقراءة بس: الباقة خلصت", "Read-only: the plan ended"],
  blocked: ["متوقفة: الباقة خلصت", "Stopped: the plan ended"]
};
const STATUS = { pending: ["مستني التأكيد", "Waiting for confirmation"], confirmed: ["اتأكد ✅", "Confirmed ✅"], cancelled: ["اتلغى", "Cancelled"] };
const REQUEST_STATUS = { pending: ["مستني الرد", "Waiting"], approved: ["اتوافق ✅", "Approved ✅"], declined: ["اترفض", "Declined"] };
const CREDIT_ERRORS = {
  credits: ["اكتب عدد رصيد من 1 لـ 100,000.", "Enter a number of credits from 1 to 100,000."],
  too_many: ["عندك 3 طلبات مستنية. استنى الرد.", "You already have 3 open requests. Wait for an answer."],
  forbidden: ["صاحب الشركة بس يقدر يطلب رصيد.", "Only the agency owner can ask for credits."],
  lapsed: ["طلب الرصيد محتاج باقة شغالة. جدّد الباقة الأول.", "Asking for credits needs an active plan. Renew the plan first."]
};
const ERRORS = {
  plan: ["اختار باقة ومدة.", "Pick a plan and a period."],
  too_many: ["عندك ٣ مدفوعات مستنية؛ استنى تأكيدها أو كلّمنا.", "You have 3 payments waiting; wait for them to be confirmed or contact us."],
  forbidden: ["للمديرين بس.", "Managers only."],
  lapsed: ["الرصيد الزيادة محتاج باقة شغالة. جدّد الباقة الأول.", "Extra credits need an active plan. Renew the plan first."],
  // While a paid period runs only the same plan for the same length (renewal, queued after the end) or a higher plan (a pro-rated upgrade) is allowed.
  downgrade: ["مينفعش تنزل لباقة أقل وانت لسه في فترة مدفوعة. جدّد باقتك الحالية، أو اختار أعلى منها، ولو عايز أقل اختارها بعد ما الفترة تخلص.", "You can't move to a lower plan while a paid period is running. Renew your current plan or upgrade; a lower plan can be chosen after the period ends."],
  period_switch: ["مينفعش تغيّر مدة الباقة وانت لسه في فترة مدفوعة (مثلاً من 6 شهور لـ 12). جدّد بنفس المدة، أو اختار مدة تانية بعد ما الفترة تخلص.", "You can't change the length of your plan while a paid period is running (for example 6 to 12 months). Renew for the same length, or pick another length after the period ends."],
  upgrade_required: ["الباقة الأعلى بتتشترى كترقية بسعر متناسب مع المدة اللي فاضلة. استخدم زرار الترقية.", "A higher plan is bought as an upgrade, priced for the time left. Use the upgrade button."],
  same_plan: ["دي باقتك الحالية بالفعل. للتجديد اختار نفس الباقة والمدة.", "That is already your plan. To renew pick the same plan and length."],
  not_paid: ["الترقية لباقة مدفوعة شغالة بس. اختار باقة واشتريها عادي.", "An upgrade needs a running paid plan. Pick a plan and buy it as usual."],
  upgrade_pending: ["عندك ترقية مستنية التأكيد. استنى تأكيدها أو كلّمنا.", "You already have an upgrade waiting for confirmation. Wait for it or contact us."],
  amount: ["مفيش فرق سعر يتحسب للترقية دي.", "There is no price difference to charge for this upgrade."]
};
const UPGRADE_LAPSED = ["الباقة خلصت: جدّد الباقة بدل الترقية، وتقدر تختار أي باقة ومدة.", "Your plan has ended: renew instead of upgrading; any plan and length can be chosen."];

/**
 * The soft warning at 85% of the unit cap (and at 100%): a banner for the Plan and dashboard pages. units = { used, limit, level }
 * (Billing.unitStatus); nothing for a plan with no unit cap or below 85%.
 */
function unitBanner(units, lang) {
  const level = units.level ?? Billing.unitLevel(units);
  if (!level) return "";
  const pct = Math.min(100, Math.round((units.used * 100) / units.limit));
  return html`<p class="card notice ${level >= 100 ? "bad" : "warn"}" role="status" data-unit-warning="${level}">📦 ${level >= 100
    ? L(lang, `وصلت للحد الأقصى للوحدات: ${num(units.used)} من ${num(units.limit)}. رقّي الباقة عشان تضيف وحدات جديدة.`, `You have reached your unit limit: ${num(units.used)} of ${num(units.limit)}. Upgrade to add more units.`)
    : L(lang, `الوحدات قربت تخلص: ${num(units.used)} من ${num(units.limit)} (${pct}%). بتتحسب المتاحة والمؤرشفة والمباعة. رقّي الباقة قبل ما توصل للحد.`, `Your units are almost full: ${num(units.used)} of ${num(units.limit)} (${pct}%). Available, archived and sold units all count. Upgrade before you reach the limit.`)}</p>`;
}

function meter(label, used, limit) {
  const pct = limit > 0 ? Math.min(100, Math.round((used * 100) / limit)) : 100;
  return html`<div class="card tile" data-meter="${label[1].toLowerCase()}"><div class="muted">${label[0]}</div><strong>${num(used)} / ${Number(limit) >= Plans.UNLIMITED ? "∞" : num(limit)}</strong><progress max="100" value="${pct}">${pct}%</progress></div>`;
}

function paymentCard(p, payTo, lang) {
  return html`<section class="card notice" data-payment="${p.reference}">
  <h2>💳 ${L(lang, "ادفع كده", "How to pay")}</h2>
  <p>${L(lang, "المبلغ", "Amount")}: <strong>${num(p.amount_egp)} ${L(lang, "ج.م", "EGP")}</strong></p>
  <p>${L(lang, "اكتب المرجع ده في ملاحظة التحويل", "Put this reference in the transfer note")}: <strong dir="ltr">${p.reference}</strong></p>
  ${payTo.instapay ? html`<p>InstaPay: <strong dir="ltr">${payTo.instapay}</strong></p>` : ""}
  ${payTo.bank ? html`<p>${L(lang, "تحويل بنكي", "Bank transfer")}: <span dir="auto">${payTo.bank}</span></p>` : ""}
  ${!payTo.instapay && !payTo.bank ? html`<p class="muted">${L(lang, "تفاصيل الدفع هتوصلك مننا قريب.", "We'll send you the payment details shortly.")}</p>` : ""}
  <p class="muted">${L(lang, "أول ما الفلوس توصل بنأكد الدفع وتتبلغ.", "As soon as the money arrives we confirm it and you'll be told.")}</p>
</section>`;
}

const INVITED = {
  pending: ["مستنية موافقتنا", "Waiting for our approval"],
  approved: ["مستنية أول دفعة", "Waiting for its first payment"],
  rejected: ["اترفضت", "Rejected"],
  rewarded: ["دفعت: الشهر المجاني اتحسب 🎁", "Paid: free month earned 🎁"]
};

function referralSection(r, lang) {
  const text = L(lang, `جرّب WehdatHub لشركتك. سجّل بالكود ${r.code} وناخد إحنا الاتنين شهر مجاني لما تشترك: ${r.link}`, `Try WehdatHub for your agency. Sign up with code ${r.code} and we both get a free month when you subscribe: ${r.link}`);
  return html`<section class="card stack" id="referral" data-referral="${r.code}">
  <h2>🎁 ${L(lang, "ادعي شركة تانية", "Invite another agency")}</h2>
  <p>${L(lang, "لما الشركة اللي دعيتها تدفع أول باقة، إنتوا الاتنين تاخدوا شهر مجاني.", "When an agency you invite pays for its first plan, you both get a free month.")}</p>
  <p>${L(lang, "كود الدعوة", "Invite code")}: <strong dir="ltr">${r.code}</strong></p>
  <label>${L(lang, "لينك التسجيل", "Sign-up link")} <span class="row"><input readonly dir="ltr" value="${r.link}" id="referral-link"> <button type="button" class="secondary" data-copy="#referral-link">📋 ${L(lang, "نسخ", "Copy")}</button></span></label>
  <p><a class="btn secondary" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">${L(lang, "ابعته على واتساب", "Send on WhatsApp")}</a></p>
  ${r.credit ? html`<p class="notice ok">${L(lang, `عندك ${r.credit} شهر مجاني هيتضاف لأول دفعة جاية.`, `You have ${r.credit} free month(s) that will be added to your next payment.`)}</p>` : ""}
  ${r.referredBy ? html`<p class="muted">${L(lang, `شركتك اتدعت من ${r.referredBy}`, `Your agency was invited by ${r.referredBy}`)}${r.rewarded ? "" : L(lang, " — أول دفعة ليك فيها شهر مجاني.", " — your first payment includes a free month.")}</p>` : ""}
  ${r.invited.length
    ? html`<table><tbody>${r.invited.map((x) => html`<tr data-invited><td>${x.name}</td><td>${INVITED[x.referral_rewarded_at ? "rewarded" : x.approval][lang === "en" ? 1 : 0]}</td></tr>`)}</tbody></table>`
    : ""}
</section>`;
}

/** The plan part of the Usage page (managers and the owner): plan in force, seats and units, payment, bundles, credit requests, invite code, payments. */
function planSections({ a, requests = [], limits = {}, payments, payTo, lang, manager, referral = null, notice = null, created = null, quotes = {}, now = new Date() }) {
  const p = a.plan;
  // While a paid period runs: the same plan for the same length (renewal) or a higher plan (upgrade, pro-rated); nothing else.
  const running = a.source === "paid";
  const curTier = Plans.tierOf(p.id);
  const lastMonths = Number(a.agency?.last_months) || 0;
  const priceTag = (x, m) => Billing.priceAt(a.agency, x.id, m, now) || { amount: Plans.priceFor(x, m), locked: false };
  return html`<div id="plan" class="stack">
<h2>${L(lang, "الباقة", "Plan")}</h2>
${notice || ""}
${unitBanner(a.units, lang)}
${created ? paymentCard(created, payTo, lang) : ""}
<section class="card" data-plan="${p.id}" data-source="${a.source}">
  <h2>${Plans.planName(p, lang)} · ${SOURCE[a.source][lang === "en" ? 1 : 0]}</h2>
  ${a.until ? html`<p>${L(lang, "لحد", "Until")} <span dir="ltr">${day(a.until)}</span></p>` : ""}
  <div class="grid">
    ${meter([L(lang, "المستخدمين", "Users"), "seats"], a.seats.used, a.seats.limit)}
    ${meter([L(lang, "الوحدات (المتاحة والمؤرشفة والمباعة)", "Units (available, archived and sold)"), "units"], a.units.used, a.units.limit)}
  </div>
  <p class="muted" data-credit-split>${L(lang, `الرصيد: ${num(a.credits.plan)} من الباقة` + (a.credits.bundles ? ` + ${num(a.credits.bundles)} باقات زيادة` : "") + (a.credits.grants ? ` + ${num(a.credits.grants)} هدية من صاحب التطبيق` : ""), `Credits: ${num(a.credits.plan)} from the plan` + (a.credits.bundles ? ` + ${num(a.credits.bundles)} from bundles` : "") + (a.credits.grants ? ` + ${num(a.credits.grants)} granted by the app owner` : ""))}</p>
  <p class="muted">${L(lang, "لو الرصيد خلص، البحث والعملاء والوحدات بيفضلوا شغالين يدوي؛ اللي بيقف هو قراءة الفويس والوصف بالذكاء الاصطناعي لحد أول الشهر. بياناتك مش بتتمسح أبداً.", "When an allowance runs out, search, clients and units keep working by hand; only AI reading of voice notes and descriptions stops until the month turns. Your data is never deleted.")}</p>
</section>
${manager
  ? html`<form method="post" action="/app/plan/pay" class="card stack">
  <h2>${L(lang, "اختار باقة", "Choose a plan")}</h2>
  ${running ? html`<p class="muted" data-plan-rules>${L(lang, "طول ما باقتك شغالة تقدر تجدد نفس الباقة بنفس المدة (بتبدأ بعد ما الحالية تخلص)، أو ترقّي لباقة أعلى بسعر متناسب مع الأيام اللي فاضلة. النزول لباقة أقل أو تغيير المدة بيكون بعد ما الفترة تخلص، ومفيش استرداد جزئي.", "While your plan runs you can renew the same plan for the same length (it starts after the current one ends) or upgrade to a higher plan, priced for the days left. A lower plan or another length can be chosen after the period ends; there are no partial refunds.")}</p>` : ""}
  <div class="plancards">${Plans.PLANS.filter((x) => Plans.periodsOf(x).length).map((x) => {
    const tier = Plans.tierOf(x.id);
    if (running && curTier >= 0 && tier < curTier) return ""; // a lower plan: not offered mid-cycle
    const facts = html`<ul><li>${x.seats} ${L(lang, "مستخدم", "users")}</li><li>${num(x.credits)} ${L(lang, "رصيد ذكاء اصطناعي في الشهر", "AI credits a month")}</li><li>${(limits[x.id] ?? x.units) >= Plans.UNLIMITED ? L(lang, "وحدات بلا حد", "Unlimited units") : `${num(limits[x.id] ?? x.units)} ${L(lang, "وحدة", "units")}`}</li></ul>`;
    if (running && curTier >= 0 && tier > curTier) {
      const q = quotes[x.id];
      return html`<fieldset class="plancard" data-plan-card="${x.id}" data-upgrade-card><legend><strong>${Plans.planName(x, lang)}</strong></legend>
      ${facts}
      ${q ? html`<p data-upgrade-quote="${q.amount}">${L(lang, "الترقية دلوقتي", "Upgrade now")}: <span class="price">${num(q.amount)} <small>${L(lang, "ج.م", "EGP")}</small></span> <small class="muted">${L(lang, `لـ ${q.detail.remainingDays} يوم فاضلين. تاريخ نهاية الباقة مش بيتغير.`, `for the ${q.detail.remainingDays} days left. Your end date does not change.`)}</small></p>
      <button type="submit" name="choice" value="upgrade:${x.id}" class="secondary" data-upgrade-to="${x.id}">${L(lang, "رقّي", "Upgrade")}</button>` : ""}</fieldset>`;
    }
    const periods = running && curTier >= 0 && lastMonths && Plans.priceFor(x, lastMonths) ? [lastMonths] : Plans.periodsOf(x);
    const first = x.id === (a.source === "paid" ? p.id : "office");
    return html`<fieldset class="plancard" data-plan-card="${x.id}"><legend><strong>${Plans.planName(x, lang)}</strong></legend>
      ${facts}
      ${periods.map((m, i) => {
        const t = priceTag(x, m);
        return html`<label class="period" data-period="${m}"><input type="radio" name="choice" value="${x.id}:${m}" ${first && i === 0 ? "checked" : ""}> ${m === 1 ? L(lang, "شهر", "1 month") : L(lang, `${m} شهور`, `${m} months`)} · <span class="price">${num(t.amount)} <small>${L(lang, "ج.م", "EGP")}</small></span>${t.locked ? html` <small class="muted" data-price-locked>${L(lang, "(سعر مثبّت)", "(locked price)")}</small>` : ""}${m > 1 ? html` <small class="muted" data-per-month>(~${num(Plans.perMonth(t.amount, m))}${L(lang, "/شهر", "/mo")})</small>` : ""}</label>`;
      })}</fieldset>`;
  })}</div>
  <input type="hidden" name="kind" value="plan">
  <button type="submit">${L(lang, "هدفع", "I'll pay")}</button>
</form>
${a.ladder ? "" : html`<section class="card stack" data-bundles>
  <h2>${L(lang, "رصيد زيادة (صالح ٣٠ يوم)", "Extra credits (valid 30 days)")}</h2>
  ${Plans.BUNDLES.map(
    (x) => html`<form method="post" action="/app/plan/pay" class="row" data-bundle="${x.id}">
    <input type="hidden" name="kind" value="credit_bundle"><input type="hidden" name="bundle" value="${x.id}">
    <span>${num(x.credits)} ${L(lang, "رصيد", "credits")} · ${num(x.priceEgp)} ${L(lang, "ج.م", "EGP")}</span>
    <button type="submit" class="secondary">${L(lang, "اشتري", "Buy")}</button>
  </form>`
  )}
</section>`}
${a.ladder ? "" : html`<form method="post" action="/app/plan/credit-request" class="card stack" data-credit-request>
  <h2>${L(lang, "اطلب رصيد زيادة", "Ask for more credits")}</h2>
  <p class="muted">${L(lang, "بتوصل لصاحب التطبيق على تليجرام، وبيرد عليك هنا.", "The app owner gets it on Telegram and answers here.")}</p>
  <label>${L(lang, "كام رصيد؟", "How many credits?")} <input name="credits" type="number" min="1" max="100000" required></label>
  <label>${L(lang, "ملاحظة (اختياري)", "Note (optional)")} <input name="note" maxlength="300"></label>
  <button type="submit" class="secondary">${L(lang, "ابعت الطلب", "Send request")}</button>
  ${requests.length ? html`<table data-credit-requests><tbody>${requests.map((x) => html`<tr data-request="${x.id}"><td>${num(x.credits)}</td><td>${(REQUEST_STATUS[x.status] || REQUEST_STATUS.pending)[lang === "en" ? 1 : 0]}</td><td dir="ltr">${day(x.created_at)}</td></tr>`)}</tbody></table>` : ""}
</form>`}`
  : html`<p class="muted">${L(lang, "صاحب الشركة بس يقدر يغيّر الباقة.", "Only the agency owner can change the plan.")}</p>`}
${referral ? referralSection(referral, lang) : ""}
${payments.length
  ? html`<section class="card"><h2>${L(lang, "المدفوعات", "Payments")}</h2><div class="scroll"><table><tbody>${payments.map(
      (x) => html`<tr data-ref="${x.reference}"><td dir="ltr">${x.reference}</td><td>${x.kind === "credit_bundle" ? L(lang, `رصيد زيادة ${num(Plans.bundleById(x.bundle_id)?.credits ?? 0)}`, `Extra credits ${num(Plans.bundleById(x.bundle_id)?.credits ?? 0)}`) : x.kind === "voice_pack" ? L(lang, "باقة فويس", "Voice pack") : x.kind === "upgrade" ? L(lang, `ترقية لـ ${Plans.planName(Plans.planById(x.plan), lang)}`, `Upgrade to ${Plans.planName(Plans.planById(x.plan), lang)}`) : `${Plans.planName(Plans.planById(x.plan), lang)} × ${x.months}`}</td><td>${num(x.amount_egp)} ${L(lang, "ج.م", "EGP")}</td><td>${STATUS[x.status][lang === "en" ? 1 : 0]}</td><td dir="ltr">${day(x.created_at)}</td></tr>`
    )}</tbody></table></div></section>`
  : ""}
</div>`;
}

/** What the Usage page needs for the plan part (managers and the owner only; anyone else gets an empty string). */
async function sectionsFor(pool, req, extra = {}) {
  const lang = langOf(req);
  const broker = req.session.broker;
  if (!isManager(broker)) return "";
  const [a, payTo, limits, payments, requests, referral] = await Promise.all([
    Billing.allowance(pool, broker.agency_id), Billing.payTo(pool), Billing.planLimits(pool),
    Billing.paymentsOf(pool, broker.agency_id), Credits.requestsOf(pool, broker.agency_id), Referrals.summary(pool, broker.agency_id)
  ]);
  // The platform owner's extra-seats records are not shown to agencies: only the seats and credits totals reflect them.
  return planSections({ a, requests, limits, payments: payments.filter((x) => x.kind !== "extra_seats"), payTo, lang, manager: isAgencyOwner(broker), referral, quotes: Billing.upgradeQuotes(a.agency), ...extra });
}

function register(web, { pool, page }) {
  const render = (req, res, extra = {}, status = 200) => require("./usage").renderUsage(pool, page, req, res, extra, status);

  // The plan lives on the Usage page now; old links and bookmarks land there.
  web.get("/plan", (req, res) => res.redirect(303, "/app/usage#plan"));

  web.post("/plan/credit-request", async (req, res) => {
    const lang = langOf(req);
    const broker = req.session.broker;
    if (!isAgencyOwner(broker)) return res.status(403).type("text/plain").send(ERRORS.forbidden[lang === "en" ? 1 : 0]);
    const r = await Credits.requestMore(pool, broker, { credits: req.body.credits, note: req.body.note });
    if (r.error) return render(req, res, { notice: html`<p class="card notice bad" role="alert">❌ ${(CREDIT_ERRORS[r.error] || CREDIT_ERRORS.credits)[lang === "en" ? 1 : 0]}</p>` }, r.error === "forbidden" ? 403 : 400);
    return render(req, res, { notice: html`<p class="card notice ok" role="status" data-credit-request-sent>✅ ${L(lang, "الطلب وصل لصاحب التطبيق.", "Your request reached the app owner.")}</p>` });
  });

  web.post("/plan/pay", async (req, res) => {
    const lang = langOf(req);
    const broker = req.session.broker;
    if (!isAgencyOwner(broker)) return res.status(403).type("text/plain").send(ERRORS.forbidden[lang === "en" ? 1 : 0]);
    // The plan cards post one choice "plan:months"; plan and months fields still work.
    // The upgrade buttons post "upgrade:plan".
    const [cPlan, cMonths] = String(req.body.choice || "").split(":");
    const upgrade = cPlan === "upgrade" || req.body.kind === "upgrade";
    const r = await Billing.requestPayment(pool, broker, upgrade ? { kind: "upgrade", plan: cPlan === "upgrade" ? cMonths : req.body.plan } : { kind: req.body.kind, plan: cPlan || req.body.plan, months: cMonths || req.body.months, bundle: req.body.bundle });
    if (r.error) {
      const msg = (r.error === "lapsed" && upgrade ? UPGRADE_LAPSED : ERRORS[r.error] || ERRORS.plan)[lang === "en" ? 1 : 0];
      return render(req, res, { notice: html`<p class="card notice bad" role="alert" data-plan-error="${r.error}">❌ ${msg}</p>` }, r.error === "forbidden" ? 403 : 400);
    }
    BillingNotices.paymentRequested(r.payment, r.agency, broker, pool);
    return render(req, res, { created: r.payment });
  });
}

module.exports = { register, sectionsFor, unitBanner };
