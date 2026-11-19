// services/billingNotices.js — What billing tells people (phase 2 step 4): the owner hears about a new payment or
// sign-up (Telegram owner alert), an agency's managers hear when a payment is confirmed, before their trial or paid period ends (trial 3 and 1 days
// before; monthly plans 7, 3, 1; 6 and 12 month plans 30, 14, 7, 3, 1) and when units reach 85% and 100% of the cap (hourly job). Kept apart from services/billing.js, which lib/ai.js loads.
"use strict";

const Notifications = require("../lib/notifications");
const ErrorReports = require("../lib/errorReports");
const Billing = require("./billing");
const Plans = require("../domain/plans");
const Authz = require("../lib/authz");
const { MANAGER_ROLES } = Authz;

const L = (b, ar, en) => (b.preferred_lang === "en" ? en : ar);
const day = (d) => new Date(d).toISOString().slice(0, 10);

async function toManagers(pool, agencyId, { dedupeKey, title, body, now = new Date() }) {
  let n = 0;
  for (const m of await Notifications.managersOf(pool, agencyId)) {
    await Notifications.notifyBroker(pool, m, { kind: "manager_alert", dedupeKey, title: title(m), body: body ? body(m) : "", url: "/app/usage#plan", now });
    n++;
  }
  return n;
}

function paymentRequested(payment, agency, manager, pool = null) {
  const what = payment.kind === "credit_bundle" ? `credit bundle (${Plans.bundleById(payment.bundle_id)?.credits ?? "?"} credits)` : payment.kind === "voice_pack" ? "voice pack (old)" : payment.kind === "upgrade" ? `upgrade ${payment.detail?.from || ""} to ${payment.plan} (${payment.detail?.remainingDays ?? "?"} days left)` : `${payment.plan} × ${payment.months} month(s)`;
  return ErrorReports.alertOwner([`💳 Payment announced ${payment.reference}`, `${agency.name} · ${manager.name || ""}`, `${what} · ${payment.amount_egp} EGP`, "Confirm on /app/owner once it arrives."].join("\n"), { category: "payments", pool }).catch(() => {});
}

function signupRequested(agency, broker, referrer = null, pool = null) {
  const lines = [`🆕 Sign-up waiting: ${agency.name}`, `${broker.name} · +${broker.phone_number}`];
  if (referrer) lines.push(`🎁 Invited by ${referrer.name}`);
  lines.push("Approve or reject on /app/owner.");
  return ErrorReports.alertOwner(lines.join("\n"), { category: "new_trial", pool }).catch(() => {});
}

async function paymentConfirmed(pool, { payment, agency, referral = null, restored: back = null }, { now = new Date() } = {}) {
  const until = agency.paid_until ? day(agency.paid_until) : null;
  const bonus = referral ? referral.bonus : 0;
  // The inviting agency hears that its free month landed (on its paid period, or held for its next payment).
  if (referral && referral.referrer) {
    const r = referral.referrer;
    await toManagers(pool, r.id, {
      dedupeKey: `referral_ok:${payment.agency_id}`,
      title: (m) =>
        r.credited
          ? L(m, `🎁 ${agency.name} اشتركت بدعوتك: شهر مجاني هيتضاف لأول دفعة جاية ليك`, `🎁 ${agency.name} joined on your invite: a free month will be added to your next payment`)
          : L(m, `🎁 ${agency.name} اشتركت بدعوتك: اتضافلك شهر مجاني`, `🎁 ${agency.name} joined on your invite: a free month was added to your plan`),
      now
    });
  }
  if (back) await restored(pool, { payment, agency }, { now }).catch((e) => console.warn("Restore notice failed:", e.message));
  return toManagers(pool, payment.agency_id, {
    dedupeKey: `payment_ok:${payment.id}`,
    title: (m) =>
      payment.kind === "credit_bundle" || payment.kind === "voice_pack"
        ? L(m, `✅ وصل الدفع ${payment.reference}: ${Plans.bundleById(payment.bundle_id)?.credits ?? ""} رصيد زيادة الشهر الحالي`, `✅ Payment ${payment.reference} received: ${Plans.bundleById(payment.bundle_id)?.credits ?? ""} extra credits this month`)
        : payment.kind === "upgrade"
        ? L(m, `✅ وصل الدفع ${payment.reference}: الباقة اترقّت لـ ${Plans.planName(Plans.planById(payment.plan), "ar")} ولسه شغالة لحد ${until}`, `✅ Payment ${payment.reference} received: your plan is now ${Plans.planName(Plans.planById(payment.plan), "en")}, still running until ${until}`)
        : L(m, `✅ وصل الدفع ${payment.reference}: الباقة شغالة لحد ${until}`, `✅ Payment ${payment.reference} received: your plan runs until ${until}`) +
          (bonus ? L(m, ` (منهم ${bonus} شهر مجاني من الدعوات 🎁)`, ` (including ${bonus} free month(s) from invites 🎁)`) : ""),
    now
  });
}

/**
 * Hourly: the agency owner and managers of agencies whose trial or paid period is ending hear at the reminder days (once per
 * day count and end date): the trial 3 and 1 days before (day 11 and day 13 of 14), a monthly plan 7, 3 and 1, a plan paid for
 * 6 or 12 months 30, 14, 7, 3 and 1. The words after the end are never a threat: the data is never deleted.
 */
async function remindEnding(pool, { now = new Date() } = {}) {
  let sent = 0;
  for (const a of await Billing.endingSoon(pool, { now, days: Math.max(...Billing.REMINDER_DAYS.long) })) {
    const paid = a.paid_until && new Date(a.paid_until) > now;
    const end = paid ? a.paid_until : a.trial_ends_at;
    const kind = paid ? (Number(a.last_months) >= 6 ? "long" : "monthly") : "trial";
    const due = Billing.reminderDue(kind, new Date(end) - now);
    if (!due) continue;
    const left = (m) => (due.days === 1 ? L(m, "فاضل يوم", "1 day left") : L(m, `فاضل ${due.days} أيام`, `${due.days} days left`));
    sent += await toManagers(pool, a.id, {
      dedupeKey: `plan_end:${a.id}:${day(end)}:${due.days}`,
      title: (m) =>
        paid
          ? L(m, `⏳ باقتك بتخلص ${day(end)} (${left(m)}). جدّدها من صفحة الباقة.`, `⏳ Your plan ends on ${day(end)} (${left(m)}). Renew it from the Plan page.`)
          : L(m, `⏳ التجربة المجانية بتخلص ${day(end)} (${left(m)}). اختار باقة من صفحة الباقة عشان تكمّل.`, `⏳ Your free trial ends on ${day(end)} (${left(m)}). Pick a plan on the Plan page to carry on.`),
      body: (m) => L(m, "بياناتك مش بتتمسح أبداً.", "Your data is never deleted."),
      now
    });
  }
  return { sent };
}

/** The agency's brokers who are not managers (and not data entry's lead work): they hear only when read-only starts, when blocked starts and when access is restored. */
async function toBrokers(pool, agencyId, { dedupeKey, title, now = new Date() }) {
  const { rows } = await pool.query(
    "SELECT id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs, telegram_chat_id FROM brokers WHERE agency_id = $1 AND is_active AND lower(role) <> ALL($2::text[])",
    [agencyId, MANAGER_ROLES]
  );
  let n = 0;
  for (const b of rows) {
    await Notifications.notifyBroker(pool, b, { kind: "system_alert", dedupeKey, title: title(b), url: "/app/", now });
    n++;
  }
  return n;
}

// What each step of the expiry ladder says (services/billing.js ladderNotices). Managers and the owner get the Plan page and the
// date; a broker gets "ask your manager" and no prices. Never a threat: the data is never deleted.
function ladderText(id, kind, l, m) {
  const ro = day(l.graceEnd);
  const block = day(l.readonlyEnd);
  const graceDays = Math.round((l.graceEnd - l.end) / 86400000);
  const renew = (b) => (Authz.isManager(b) ? L(b, "جدّد من صفحة الباقة.", "Renew on the Plan page.") : L(b, "اطلب من مديرك يجدّد الباقة.", "Ask your manager to renew the plan."));
  const safe = (b) => L(b, "بياناتك محفوظة ومش بتتمسح، وتقدر تصدّرها.", "Your data is safe, never deleted, and you can export it.");
  switch (id) {
    case "grace":
      return L(m, `⏳ باقتك خلصت. عندك ${graceDays} أيام سماح لحد ${ro}: كل حاجة شغالة. ${renew(m)}`, `⏳ Your plan ended. You have ${graceDays} days of grace until ${ro}: everything still works. ${renew(m)}`);
    case "ro_eve":
      return L(m, `⏳ بكرة (${ro}) الحساب هيبقى للقراءة بس: مفيش إضافة ولا تعديل ولا ذكاء اصطناعي. ${renew(m)}`, `⏳ Tomorrow (${ro}) the account becomes read-only: no adding, editing or AI. ${renew(m)}`);
    case "ro_start":
      return L(m, `🔒 الحساب بقى للقراءة بس: تقدر تشوف وتبحث وتصدّر. هيتوقف يوم ${block}. ${renew(m)}`, `🔒 The account is now read-only: you can view, search and export. It stops on ${block}. ${renew(m)}`);
    case "ro_notice":
      return L(m, `🔒 التجربة خلصت والحساب بقى للقراءة بس لحد ${block}. ${Authz.isManager(m) ? "اختار باقة من صفحة الباقة عشان تكمّل." : renew(m)}`, `🔒 The trial ended and the account is read-only until ${block}. ${Authz.isManager(m) ? "Pick a plan on the Plan page to carry on." : renew(m)}`);
    case "block_3":
      return L(m, `⛔ الحساب هيتوقف بعد 3 أيام (${block}). ${renew(m)}`, `⛔ The account stops in 3 days (${block}). ${renew(m)}`);
    case "block_1":
      return L(m, `⛔ آخر يوم: الحساب هيتوقف بكرة (${block}). ${renew(m)}`, `⛔ Last day: the account stops tomorrow (${block}). ${renew(m)}`);
    default:
      return L(m, `⛔ الحساب اتوقف لحد التجديد. ${safe(m)} ${renew(m)}`, `⛔ The account is stopped until it is renewed. ${safe(m)} ${renew(m)}`);
  }
}

/**
 * Hourly: agencies past their period end hear the next step of the ladder (services/billing.js ladderNotices): owner and managers at
 * every step, brokers only when read-only starts and when blocked starts. Once per step and period end (the key carries the period end
 * and the grace end, so a grace the owner extended is announced again). A job that ran late sends only the tightest step due.
 */
async function remindLapsed(pool, { now = new Date() } = {}) {
  let sent = 0;
  for (const a of await Billing.lapsedForNotices(pool, { now })) {
    const due = Billing.ladderNoticeDue(a, now);
    if (!due) continue;
    const { notice, ladder: l } = due;
    const key = `plan_ladder:${a.id}:${day(l.end)}:${day(l.graceEnd)}:${notice.id}`;
    sent += await toManagers(pool, a.id, { dedupeKey: key, title: (m) => ladderText(notice.id, l.kind, l, m), body: (m) => L(m, "بياناتك مش بتتمسح أبداً.", "Your data is never deleted."), now });
    if (notice.brokers) sent += await toBrokers(pool, a.id, { dedupeKey: key, title: (b) => ladderText(notice.id, l.kind, l, b), now });
  }
  return { sent };
}

/** Access is back after a payment in grace, read-only or blocked: owner, managers and brokers are told once per payment. */
async function restored(pool, { payment, agency }, { now = new Date() } = {}) {
  const until = agency.paid_until ? day(agency.paid_until) : "";
  const key = `plan_restored:${payment.id}`;
  const text = (b) => L(b, `✅ الباقة اتجدّدت: كل حاجة رجعت شغالة لحد ${until}.`, `✅ The plan is renewed: everything works again until ${until}.`);
  return (await toManagers(pool, payment.agency_id, { dedupeKey: key, title: text, now })) + (await toBrokers(pool, payment.agency_id, { dedupeKey: key, title: text, now }));
}

/**
 * Soft warning before the unit cap: when the agency's units (available, archived and sold) reach 85% of its plan's cap, and
 * again at 100%, the owner and managers hear once per level and plan. Plans with no unit cap are skipped.
 */
async function warnUnits(pool, { now = new Date() } = {}) {
  let sent = 0;
  const { rows } = await pool.query("SELECT id FROM agencies WHERE approval = 'approved'");
  for (const { id } of rows) {
    const st = await Billing.unitStatus(pool, id, { now });
    if (!st.level) continue;
    sent += await toManagers(pool, id, {
      dedupeKey: `units_warn:${st.plan.id}:${st.level}`,
      title: (m) =>
        st.level >= 100
          ? L(m, `📦 وصلت للحد الأقصى للوحدات: ${st.used} من ${st.limit}`, `📦 Unit limit reached: ${st.used} of ${st.limit}`)
          : L(m, `📦 الوحدات قربت تخلص: ${st.used} من ${st.limit} (${st.level}%)`, `📦 Units are almost full: ${st.used} of ${st.limit} (${st.level}%)`),
      body: (m) => L(m, "بتتحسب المتاحة والمؤرشفة والمباعة. رقّي الباقة من صفحة الباقة قبل ما توصل للحد.", "Available, archived and sold units all count. Upgrade from the Plan page before you hit the limit."),
      now
    });
  }
  return { sent };
}

/** The scheduler job entry (lib/jobs.js): hourly; the dedupe keys keep it to one notice per level and period end. */
const reminderJob = () => ({
  name: "plan_reminders",
  everyMs: 60 * 60 * 1000,
  run: async ({ pool, now }) => ({ counts: { ...(await remindEnding(pool, { now })), lapsed: (await remindLapsed(pool, { now })).sent, units: (await warnUnits(pool, { now })).sent } })
});

module.exports = { paymentRequested, signupRequested, paymentConfirmed, remindEnding, remindLapsed, restored, ladderText, warnUnits, reminderJob };
