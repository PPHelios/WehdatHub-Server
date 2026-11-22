// web/routes/signup.js — Agency self-serve trial signup (Phase 5): /app/signup, open to everyone while the owner has it
// switched on (services/signup.js isOpen). No approval and no card: the form (agency, name, Egyptian mobile) creates a pending
// signup and shows a one-time Telegram link; the bot verifies the number by contact share and starts the 14-day trial
// (services/trialSignup.js). One trial per phone and per Telegram id, ever. Offices of 15+ seats go to the demo form on the landing page.
// An optional invite code (prefilled from ?ref=) links the agency that invited it (services/referrals.js).
// Honeypot, a rate limit per visitor, and the app's same-origin check.
"use strict";

const Signup = require("../../services/signup");
const TrialSignup = require("../../services/trialSignup");
const Referrals = require("../../services/referrals");
const Phone = require("../../domain/phone");
const RateLimit = require("../../lib/rateLimit");
const { html } = require("../html");
const { MARK } = require("../icons");

const { L } = require("../../lib/copy");
const ERRORS = {
  closed: ["التجربة دي مش متاحة دلوقتي. اختار تجربة تانية لو موجودة.", "This trial is currently closed. Choose another trial if available."],
  agency: ["اكتب اسم الشركة.", "Enter the agency name."],
  name: ["اكتب اسمك.", "Enter your name."],
  phone: ["رقم موبايل مصري صحيح (01xxxxxxxxx).", "A valid Egyptian mobile (01xxxxxxxxx)."],
  referral: ["كود الدعوة ده مش موجود؛ راجعه أو سيبه فاضي.", "That invite code doesn't exist; check it or leave it empty."],
  phone_taken: ["الرقم ده متسجل بالفعل. ابعت «دخول» للبوت.", "This number is already registered. Send \"login\" to the bot."],
  trial_used: ["الرقم ده استخدم التجربة المجانية قبل كده (تجربة واحدة لكل رقم). شوف الباقات أو كلمنا من الصفحة الرئيسية.", "This number has already used its free trial (one trial per number). See the plans or contact us on the home page."],
  telegram_off: ["التسجيل مش متاح دلوقتي. جرب بعد شوية.", "Sign-up is not available right now. Try again later."],
  consent: ["لازم توافق على الشروط.", "Please agree to the terms."],
  rate: ["طلبات كتير؛ جرب بعد شوية.", "Too many requests; try again later."]
};

function closedPage(lang) {
  return html`<div class="card auth"><h1>${L(lang, "التسجيل مقفول دلوقتي", "Sign-up is closed for now")}</h1>
<p>${L(lang, "سيب بياناتك في فورم «احجز عرض مباشر» وهنكلمك.", "Leave your details in the \"Book a live demo\" form and we'll call you.")}</p>
<p><a class="btn" href="/?lang=${lang}#try">${L(lang, "احجز عرض مباشر", "Book a live demo")}</a></p></div>`;
}

function signupForm(lang, { error, values = {}, tiers } = {}) {
  return html`<form method="post" action="/app/signup" class="card stack auth" id="signup">
  <div class="auth-head">
    <span class="auth-mark" aria-hidden="true">${MARK}</span>
    <h1>${L(lang, "سجّل شركتك", "Sign up your agency")}</h1>
    <p class="muted">${L(lang, `تجربة مجانية من غير كارت ومن غير موافقة. بتتأكد من رقمك على تيليجرام في ثواني. بعدها تختار باقة، وبياناتك مش بتتمسح أبداً.`, `A free trial with no card and no approval. You confirm your number on Telegram in seconds. Then pick a plan; your data is never deleted.`)}</p>
    <p class="muted">${L(lang, "مكتب من ١٥ بروكر أو أكتر؟ احجز عرض مباشر بدل التجربة الذاتية.", "An office of 15+ brokers? Book a live demo instead of the self-serve trial.")} <a href="/?lang=${lang}#try">${L(lang, "احجز عرض مباشر", "Book a live demo")}</a></p>
  </div>
  ${error ? html`<p class="notice bad" role="alert">❌ ${ERRORS[error][lang === "en" ? 1 : 0]}${error === "trial_used" ? html` <a href="/?lang=${lang}#plans">${L(lang, "الباقات", "Plans")}</a> · <a href="/?lang=${lang}#try">${L(lang, "تواصل معنا", "Contact us")}</a>` : ""}</p>` : ""}
  <label>${L(lang, "اسم الشركة", "Agency name")} <input name="agency" required maxlength="120" autocomplete="organization" value="${values.agency || ""}"></label>
  <label>${L(lang, "اسمك", "Your name")} <input name="name" required maxlength="80" autocomplete="name" value="${values.name || ""}"></label>
  <label>${L(lang, "موبايلك (هو اللي هتدخل بيه)", "Your mobile (you'll sign in with it)")} <input name="phone" required inputmode="tel" dir="ltr" placeholder="01xxxxxxxxx" maxlength="20" value="${values.phone || ""}"></label>
  <fieldset class="trial-choices stack">
    <legend>${L(lang, "اختار التجربة", "Choose your trial")}</legend>
    ${Object.entries(tiers).filter(([, plan]) => plan.enabled).map(([tier, plan]) => {
      return html`<label class="trial-choice">
        <input type="radio" name="tier" value="${tier}"${(tiers[values.tier]?.enabled ? values.tier : tiers.solo.enabled ? "solo" : "team") === tier ? html` checked` : ""}>
        <span><strong>${tier === "solo" ? L(lang, "شغال لوحدي (سولو)", "Solo Trial") : L(lang, "معايا فريق", "Team Trial")}</strong>
          <small>${L(lang, `${plan.days} يوم · ${plan.seats} مستخدم · ${plan.units} وحدة · ${plan.credits} رصيد ذكاء اصطناعي`, `${plan.days} ${plan.days === 1 ? "day" : "days"} · ${plan.seats} ${plan.seats === 1 ? "user" : "users"} · ${plan.units} units · ${plan.credits} AI credits`)}</small>
        </span>
      </label>`;
    })}
  </fieldset>
  <label>${L(lang, "كود دعوة من شركة تانية (اختياري)", "Invite code from another agency (optional)")} <input name="referral" maxlength="12" dir="ltr" autocapitalize="characters" autocomplete="off" value="${values.referral || ""}"></label>
  ${values.referral ? html`<p class="muted">🎁 ${L(lang, "لما تدفع أول باقة، إنت والشركة اللي دعتك تاخدوا شهر مجاني.", "When you pay for your first plan, you and the agency that invited you each get a free month.")}</p>` : ""}
  <label class="hp" aria-hidden="true">Website <input name="website" tabindex="-1" autocomplete="off"></label>
  <label class="check"><input type="checkbox" name="consent" value="1" required> ${L(lang, "موافق إن بيانات الشركة وعملاءها تتحفظ على WehdatHub عشان الخدمة، وإن رقمي يتستخدم للتواصل بخصوص الحساب.", "I agree that the agency's and its clients' data are stored on WehdatHub to provide the service, and that my number is used to contact me about the account.")}</label>
  <button type="submit">${L(lang, "ابدأ التجربة المجانية", "Start the free trial")}</button>
</form>`;
}

/** The page after the form: open the bot, share the number there. The link is valid 15 minutes and works once. */
function telegramStep(lang, r) {
  return html`<div class="card notice ok stack auth" role="status" data-signup-telegram>
  <h1>📲 ${L(lang, "كمّل على تيليجرام", "Continue on Telegram")}</h1>
  <p>${L(lang, `افتح البوت واضغط «ابعت رقمي» عشان نتأكد إن ${r.phone} رقمك. بعدها شركتك بتتفتح فوراً وبيجيلك لينك الدخول على تيليجرام.`, `Open the bot and tap "Share my number" to confirm ${r.phone} is yours. Your agency is created right away and your sign-in link arrives on Telegram.`)}</p>
  <p><a class="btn" href="${r.url}" rel="noopener" data-signup-link>${L(lang, "افتح تيليجرام", "Open Telegram")}</a></p>
  <p class="muted">${L(lang, "اللينك صالح ١٥ دقيقة ويشتغل مرة واحدة. تجربة واحدة لكل رقم وحساب تيليجرام.", "The link is valid for 15 minutes and works once. One trial per number and Telegram account.")}</p>
</div>`;
}

function register(web, { pool, page }) {
  const title = (lang) => L(lang, "سجّل شركتك", "Sign up your agency");

  web.get("/signup", async (req, res) => {
    const lang = req.lang;
    const { enabled, tiers } = await Signup.trialSettings(pool);
    if (!enabled || !Object.values(tiers).some((tier) => tier.enabled)) return page(req, res, { title: title(lang), langSwitch: true, body: closedPage(lang) });
    return page(req, res, { title: title(lang), langSwitch: true, body: signupForm(lang, { tiers, values: { referral: Referrals.normalize(req.query.ref), tier: req.query.tier === "team" ? "team" : "solo" } }) });
  });

  web.post("/signup", async (req, res) => {
    const lang = req.lang;
    const body = req.body || {};
    const { enabled, tiers } = await Signup.trialSettings(pool);
    const values = { agency: String(body.agency || "").slice(0, 120), name: String(body.name || "").slice(0, 80), phone: String(body.phone || "").slice(0, 20), referral: Referrals.normalize(body.referral), tier: body.tier === "team" ? "team" : "solo" };
    const again = (error, status) => page(req, res, { title: title(lang), langSwitch: true, body: signupForm(lang, { error, values, tiers }) }, status);
    if (!enabled || !Object.values(tiers).some((tier) => tier.enabled)) return page(req, res, { title: title(lang), langSwitch: true, body: closedPage(lang) }, 403);
    if (!tiers[values.tier].enabled) return again("closed", 403);
    if (body.website) return res.redirect(303, "/app/signup");
    if (body.consent !== "1") return again("consent", 400);
    const ipGate = await RateLimit.hit(pool, `signup:ip:${req.ip}`, TrialSignup.LIMITS.ip);
    if (!ipGate.allowed) return again("rate", 429);
    const digits = Phone.normalizePhone(values.phone);
    if (digits) {
      const phoneGate = await RateLimit.hit(pool, `signup:phone:${digits}`, TrialSignup.LIMITS.phone);
      if (!phoneGate.allowed) return again("rate", 429);
    }
    const r = await TrialSignup.start(pool, { ...values, lang });
    if (r.error) return again(r.error, r.error === "telegram_off" ? 503 : r.error === "closed" ? 403 : 400);
    return page(req, res, { title: title(lang), langSwitch: true, body: telegramStep(lang, r) });
  });
}

module.exports = { register };
