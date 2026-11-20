// lib/planGuard.js — The one place that says what an agency may do once its plan period ended (the expiry ladder in
// services/billing.js effectivePlan: paid → grace → read-only → blocked; trial → read-only → blocked). Same idea as
// lib/viewGuard.js (one central guard, not checks scattered over every route), but it works on the request, not on SQL:
//   web   → planGuard.web(pool, { page })    middleware on the private router (web/index.js)
//   api   → planGuard.api(pool)              middleware on the app's private router (api/index.js)
//   bot   → planGuard.bot(pool, broker, message, lang)   called by routes/dispatch.js before a message is routed
//   AI    → services/billing.js checkAllowance throws PLAN_EXPIRED in read-only and blocked (lib/aiBlock.js kind "plan")
//   links → planGuard.assertCanCreate(pool, broker) for the few places that create a NEW public link or file (share link,
//           compare link, flyer); old public links are served by web/routes/publicUnit.js and stay live in every phase.
// Grace: everything works (a banner, one bot line a day). Read-only: view, local-parser search, CSV/Excel export, the plan
// and payment page; no add/edit/delete of units, leads or imports, no AI, no new links or flyers. Blocked: only the plan and
// payment page and the export. A broker (not a manager) never sees prices: they are told to ask their manager.
"use strict";

const Billing = require("../services/billing");
const Authz = require("./authz");
const Links = require("./links");

const dayOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const { L } = require("./copy");

/** The agency's place on the ladder, from effectivePlan: { source, lapsed, restricted, kind, end, until, readonlyStarts, blockedStarts }. */
function stateFrom(eff) {
  return {
    plan: eff.plan || null, // lib/workspace.js reads the seats from it
    pilot: eff.source === "pilot",
    source: eff.source,
    lapsed: Billing.LAPSED.includes(eff.source),
    restricted: eff.source === "readonly" || eff.source === "blocked",
    kind: eff.kind || null,
    end: eff.end || null,
    until: eff.until || null,
    readonlyStarts: eff.readonlyStarts || null,
    blockedStarts: eff.blockedStarts || null
  };
}

// Every private request asks for the plan state: kept 15 s per agency (for the pool that read it). Only a request at the real
// clock is kept (a caller that passes another `now` always reads). Every write of plan or payment state calls forget(agencyId).
const STATE_TTL_MS = 15 * 1000;
const memo = new Map();

/** Drops the remembered plan state of an agency (call after any write to its plan, payments, trial or grace dates). */
const forget = (agencyId) => memo.delete(agencyId);

async function stateOf(pool, agencyId, { now = new Date() } = {}) {
  if (!agencyId) return stateFrom({ source: "free" });
  const live = Math.abs(now.getTime() - Date.now()) < 1000;
  const hit = live && memo.get(agencyId);
  if (hit && hit.pool === pool && Date.now() - hit.at < STATE_TTL_MS) return hit.state;
  const state = stateFrom(Billing.effectivePlan(await Billing.agencyRow(pool, agencyId), now));
  if (live) memo.set(agencyId, { pool, at: Date.now(), state });
  return state;
}

// --- web -------------------------------------------------------------------------------------------------------------
// Paths are relative to /app (the private router). Read-only: GETs are open except the pages that create something; every
// write is refused except this list (the person's own settings, notifications, sign-out, the payment request).
const RO_POST_OK = /^\/(plan\/pay|usage|logout|csrf|push|notifications|settings|passkeys?|report|client-error|test-role|test-view|onboarding|owner|searches|search\/report)(\/|$)/;
// GET pages that create a unit, a lead, an import or a flyer: closed in read-only.
const RO_GET_NO = [
  /^\/units\/(new|[^/]+\/edit|[^/]+\/flyer)(\/|$)/,
  /^\/leads\/(new|import)(\/|$)/,
  /^\/(import|add|share)(\/|$)/,
  /^\/deals\/new(\/|$)/,
  /^\/catalogue\/(projects\/new|updates)(\/|$)/
];
const RO_GET_YES = /^\/import\/[^/]+\/failed\.xlsx$/; // a failed-rows download is an export
// Blocked: the plan and payment page, the export, and the bare essentials.
const BLOCKED_GET_OK = /^\/(plan|usage|units-export\.xlsx|leads\/ref\/export|logout|csrf|push|passkeys?|notifications|test-role|test-view|owner|offline)(\/|\.|$)/;
const BLOCKED_POST_OK = /^\/(plan\/pay|logout|csrf|push|passkeys?|test-role|test-view|owner|client-error)(\/|$)/;

/** What to do with a private web request in a phase: "ok" | "deny" (a refusal) | "plan" (send the person to the plan page). Pure. */
function webDecision(source, method, path) {
  if (source !== "readonly" && source !== "blocked") return "ok";
  const get = method === "GET" || method === "HEAD";
  if (source === "readonly") {
    if (get) return RO_GET_YES.test(path) ? "ok" : RO_GET_NO.some((r) => r.test(path)) ? "plan" : "ok";
    return RO_POST_OK.test(path) ? "ok" : "deny";
  }
  if (get) return BLOCKED_GET_OK.test(path) ? "ok" : "plan";
  return BLOCKED_POST_OK.test(path) ? "ok" : "deny";
}

/** The bilingual line a private page shows in grace, read-only and blocked (null otherwise). */
function bannerText(state, lang, { manager = false } = {}) {
  if (!state.lapsed) return null;
  const renew = manager ? L(lang, " جدّد من صفحة الباقة.", " Renew on the Plan page.") : L(lang, " اطلب من مديرك يجدّد الباقة.", " Ask your manager to renew the plan.");
  if (state.source === "grace") {
    return L(lang, `⏳ باقتك خلصت وإنت في فترة سماح لحد ${dayOf(state.readonlyStarts)}. كل حاجة شغالة.${renew}`, `⏳ Your plan ended and you are in a grace period until ${dayOf(state.readonlyStarts)}. Everything still works.${renew}`);
  }
  if (state.source === "readonly") {
    return L(
      lang,
      `🔒 الحساب للقراءة بس: تقدر تشوف وتبحث وتصدّر، لكن مينفعش تضيف أو تعدّل أو تستخدم الذكاء الاصطناعي. هيتوقف يوم ${dayOf(state.blockedStarts)}.${renew}`,
      `🔒 The account is read-only: you can view, search and export, but not add, edit or use AI. It stops on ${dayOf(state.blockedStarts)}.${renew}`
    );
  }
  return L(lang, `⛔ الحساب متوقف لحد التجديد. بياناتك محفوظة وتقدر تصدّرها.${renew}`, `⛔ The account is stopped until it is renewed. Your data is safe and you can export it.${renew}`);
}

/** The banner for a request: { phase, text, url, cta } or null. A broker gets no payment link (and no prices anywhere). */
function bannerFor(state, lang, broker) {
  const manager = Authz.isManager(broker);
  const text = bannerText(state, lang, { manager });
  return text ? { phase: state.source, text, url: manager ? "/app/usage#plan" : null, cta: manager ? L(lang, "الباقة", "Plan") : null } : null;
}

/** The refusal text for a write the phase does not allow (a manager is pointed to the plan page, a broker to the manager). */
function refusalText(state, lang, broker) {
  if (!Authz.isManager(broker)) return L(lang, "الحساب للقراءة بس دلوقتي. اطلب من مديرك يجدّد الباقة.", "The account is read-only right now. Ask your manager to renew the plan.");
  return state.source === "blocked"
    ? L(lang, "الحساب متوقف. جدّد من صفحة الباقة (/app/usage#plan).", "The account is stopped. Renew on the Plan page (/app/usage#plan).")
    : L(lang, "الحساب للقراءة بس: التعديل والإضافة والذكاء الاصطناعي واللينكات الجديدة متوقفين لحد التجديد. جدّد من صفحة الباقة (/app/usage#plan).", "The account is read-only: adding, editing, AI and new links are off until it is renewed. Renew on the Plan page (/app/usage#plan).");
}

/**
 * Express middleware for the private web router (after sign-in). Sets req.session.planState and req.session.planBanner (the page
 * layout shows it) and enforces read-only / blocked by path. `page` renders a full page (web/index.js).
 */
function web(pool, { page = null, now = () => new Date() } = {}) {
  return async (req, res, next) => {
    try {
      const broker = req.session?.broker;
      if (!broker?.agency_id) return next();
      // The test number viewing another agency is already read-only (lib/viewGuard.js) and must see that agency's pages.
      if (broker.view_of) return next();
      const state = await stateOf(pool, broker.agency_id, { now: now() });
      const lang = req.lang === "en" ? "en" : "ar";
      req.session.planState = state;
      if (state.lapsed) req.session.planBanner = bannerFor(state, lang, broker);
      const d = webDecision(state.source, req.method, req.path);
      if (d === "ok") return next();
      const manager = Authz.isManager(broker);
      const htmx = Boolean(req.get("HX-Request"));
      if (d === "plan" && manager && !htmx) return res.redirect(303, "/app/usage#plan");
      const text = refusalText(state, lang, broker);
      if (req.method === "GET" && !htmx && page) {
        const { html } = require("../web/html");
        return page(
          req,
          res,
          { title: L(lang, "الحساب متوقف", "Account stopped"), body: html`<div class="card notice bad" data-plan-ended="${state.source}"><h1>${state.source === "blocked" ? "⛔" : "🔒"} ${text}</h1>${manager ? html`<p><a class="btn" href="/app/usage#plan">${L(lang, "صفحة الباقة", "Plan page")}</a></p>` : ""}</div>` },
          403
        );
      }
      return res.status(402).type("text/plain").send(text);
    } catch (err) {
      return next(err);
    }
  };
}

// --- the app's API ----------------------------------------------------------------------------------------------------
// Paths are relative to /api/v1. Read-only: every GET works; writes are refused except the person's own bits and the payment request.
const API_RO_POST_OK = /^\/(auth|me|test-role|test-view|devices|client-error|notifications|notification-settings|settings|usage-events|plan\/pay|saved-searches|report|ask\/report|places\/box\/resolve|units\/code-check|platform)(\/|$)/;
const API_BLOCKED_GET_OK = /^\/(plan|usage|me|capabilities|config|notifications|notification-settings|export|units\/export|auth)(\/|$)/;
const API_BLOCKED_POST_OK = /^\/(auth|me|test-role|test-view|devices|client-error|plan\/pay|usage-events|platform)(\/|$)/;

function apiDecision(source, method, path) {
  if (source !== "readonly" && source !== "blocked") return "ok";
  const get = method === "GET" || method === "HEAD";
  if (source === "readonly") return get || API_RO_POST_OK.test(path) ? "ok" : "deny";
  return (get ? API_BLOCKED_GET_OK : API_BLOCKED_POST_OK).test(path) ? "ok" : "deny";
}

/** Express middleware for the app's private API router (after requireAuth). */
function api(pool, { now = () => new Date() } = {}) {
  return async (req, res, next) => {
    try {
      const broker = req.session?.broker;
      if (!broker?.agency_id || broker.view_of) return next();
      const state = await stateOf(pool, broker.agency_id, { now: now() });
      req.planState = state;
      if (apiDecision(state.source, req.method, req.path) === "ok") return next();
      const lang = broker.preferred_lang === "en" ? "en" : "ar";
      return res.status(402).json({ error: state.source === "blocked" ? "plan_blocked" : "plan_readonly", message: refusalText(state, lang, broker) });
    } catch (err) {
      return next(err);
    }
  };
}

// --- creating a new public link or file -------------------------------------------------------------------------------
/** Throws PLAN_READONLY when the agency may not create new share links, compare links or flyers (read-only and blocked). Old links are untouched. */
async function assertCanCreate(pool, broker, { now = new Date(), planState = null } = {}) {
  const state = planState || (await stateOf(pool, broker?.agency_id, { now }));
  if (state.restricted) {
    const err = new Error(`Read only: the plan period ended (${state.source})`);
    err.code = "PLAN_READONLY";
    err.phase = state.source;
    throw err;
  }
  return state;
}

// --- the bot ---------------------------------------------------------------------------------------------------------
// Read-only still answers: help, language, stats, export, "more", a bare unit code, "my leads", links, follow-ups, a phone or lead
// ref alone, and plain search text (the local parser: AI is refused by checkAllowance). Anything that writes, builds a flyer or
// link, or uses AI (voice, photos, documents, ask) gets the payment link instead.
const BOT_READ_WORDS = new Set(["مساعدة", "help", "اوامر", "الأوامر", "menu", "قائمة", "العربية", "الإنجليزية", "إلغاء", "الغاء", "cancel", "خروج", "قفل", "مخزون", "المخزون", "stats", "احصائيات", "إحصائيات", "تصدير", "export", "excel", "شيت", "اكسل", "إكسل", "اكسيل", "إكسيل", "المزيد", "more", "مزيد", "كمان", "عملائي", "leads", "العملاء", "روابط", "links", "متابعات", "followups", "المتابعات", "متابعاتي", "دخول", "login", "عربي", "english", "الدخول", "لوجين"]);
const BOT_READ_BUTTON = /^(cmd:export|cmd_export|MORE_SEARCH|search_more:|open:|ownerdata:|draft_cancel|DRAFT_CANCEL|del_cancel:|CANCEL_ACTION|edit_cancel|cancel_and_search)/;
const BOT_WRITE_WORD = /^(اضافة|إضافة|add|new|جديد|وحدة جديدة|تم|حفظ|done|save|خلاص|مراجعة|تعديل|edit|عدل|سعر|السعر|price|تم البيع|مباع|sold|اتباعت|تم بيعها|ارشفة|ارشف|أرشف|archive|متاحة|available|تفعيل|نشط|active|حذف|delete|مسح|صفقة|deal|تحديث|update|حدث|ليد|lead|عميل جديد|طلب|request|حول|assign|فلاير|flyer|unbranded|بروشور|كتالوج|بدون بيانات|عميل|client|جدول|انظمة السداد|سداد|اسأل|ask|سؤال|يا مساعد|مخطط|layout|بلاغ|bug|مشكلة)(\s|$)/i;

/** Whether the bot may handle this message in read-only. Pure; `canonical` is the text after domain/commandWords canonicalCommand. */
function botAllowsReadOnly(message, canonical = "") {
  if (message.type === "interactive") {
    const o = message.interactive;
    return BOT_READ_BUTTON.test(String(o?.button_reply?.id || o?.list_reply?.id || o?.id || ""));
  }
  if (message.type !== "text") return false;
  const text = String(canonical || message.text?.body || "").trim();
  if (!text || text.includes("\n")) return false; // a pasted card, a forwarded portal enquiry, a lead message
  if (BOT_READ_WORDS.has(text) || BOT_READ_WORDS.has(text.toLowerCase())) return true;
  return !BOT_WRITE_WORD.test(text);
}

/** The bot's reply when the plan does not allow what was asked: the payment link for a manager, "ask your manager" for a broker. */
function botBlockedText(state, lang, broker) {
  if (!Authz.isManager(broker)) {
    return L(lang, "🔒 باقة الشركة خلصت وده مش متاح دلوقتي. اطلب من مديرك يجدّد الباقة.", "🔒 Your agency's plan has ended and this is not available right now. Ask your manager to renew the plan.");
  }
  const url = Links.appUrl("/usage");
  return state.source === "blocked"
    ? L(lang, `⛔ الحساب متوقف لحد التجديد. بياناتك محفوظة. جدّد الباقة من هنا: ${url}`, `⛔ The account is stopped until it is renewed. Your data is safe. Renew the plan here: ${url}`)
    : L(lang, `🔒 الحساب للقراءة بس: الإضافة والتعديل والذكاء الاصطناعي واللينكات متوقفين لحد التجديد. جدّد الباقة من هنا: ${url}`, `🔒 The account is read-only: adding, editing, AI and links are off until it is renewed. Renew the plan here: ${url}`);
}

/** The one line the bot adds once a day in grace. */
function botGraceLine(state, lang, broker) {
  const d = dayOf(state.readonlyStarts);
  return Authz.isManager(broker)
    ? L(lang, `⏳ باقة الشركة خلصت وإنتو في فترة سماح لحد ${d}. جدّد من ${Links.appUrl("/usage")}`, `⏳ Your plan ended and you are in a grace period until ${d}. Renew at ${Links.appUrl("/usage")}`)
    : L(lang, `⏳ باقة الشركة خلصت (فترة سماح لحد ${d}). اطلب من مديرك يجدّد الباقة.`, `⏳ Your agency's plan ended (grace until ${d}). Ask your manager to renew it.`);
}

/** True the first time it is asked for this broker on this day (one row per broker in app_settings holds the last day). */
async function firstTodayFor(pool, broker, now) {
  const { rows } = await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW() WHERE app_settings.value IS DISTINCT FROM EXCLUDED.value RETURNING key`,
    [`grace_line:${broker.id}`, JSON.stringify(dayOf(now))]
  );
  return rows.length > 0;
}

/**
 * Called once per inbound bot message: { block: text } (reply with this and stop), { note: text } (grace: the once-a-day line, sent
 * after the answer) or null. Pilots, paid and trial agencies are never touched.
 */
async function bot(pool, broker, message, lang, { now = new Date(), canonical = "" } = {}) {
  if (!broker?.agency_id || broker.view_of) return null;
  const state = await stateOf(pool, broker.agency_id, { now });
  if (state.source === "blocked") return { block: botBlockedText(state, lang, broker), state };
  if (state.source === "readonly") return botAllowsReadOnly(message, canonical) ? null : { block: botBlockedText(state, lang, broker), state };
  if (state.source === "grace" && (await firstTodayFor(pool, broker, now).catch(() => false))) return { note: botGraceLine(state, lang, broker), state };
  return null;
}

module.exports = { stateOf, forget, stateFrom, webDecision, apiDecision, bannerText, bannerFor, refusalText, web, api, assertCanCreate, botAllowsReadOnly, botBlockedText, botGraceLine, bot };
