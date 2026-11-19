// routes/telegramIngress.js — Telegram updates (Release 3T): links an unknown Telegram user (start token or own
// contact), claims button taps, then runs the same guarded turn as WhatsApp. Split out of server.js.
"use strict";

const TG = require("../lib/telegram");
const TgLink = require("../lib/tgLink");
const TgIngress = require("../lib/tgIngress");
const TapGuard = require("../lib/tapGuard");
const TrialSignup = require("../services/trialSignup");
const WebAuth = require("../lib/webAuth");
const Links = require("../lib/links");
const ErrorReports = require("../lib/errorReports");

const TG_COPY = {
  linkAsk:
    "👋 أهلاً! عشان نوصّل حسابك اضغط «📱 ابعت رقمي» تحت (لازم يكون نفس الرقم المسجل في شركتك)، أو افتح رابط البداية اللي وصلك من مديرك.\n" +
    "👋 Hi! To link your account, tap \"📱 Share my number\" below (the number your agency registered), or open the start link your manager sent you.",
  shareButton: "📱 ابعت رقمي / Share my number",
  invalid: "⚠️ الرابط ده مش صالح أو اتستخدم قبل كده. اطلب رابط جديد من مديرك، أو اضغط «📱 ابعت رقمي».\n⚠️ This link is invalid or already used. Ask your manager for a new one, or tap \"📱 Share my number\".",
  notOwn: "⚠️ ابعت رقمك إنت من زرار «📱 ابعت رقمي».\n⚠️ Please share your own number with the \"📱 Share my number\" button.",
  unknown: "⚠️ الرقم ده مش متسجل كبروكر في WehdatHub. كلم مدير شركتك.\n⚠️ This number isn't registered as a WehdatHub broker. Ask your agency admin.",
  trialShare: (phone) =>
    `📱 عشان نتأكد إن الرقم رقمك، اضغط «📱 ابعت رقمي» تحت (لازم يكون ${phone}).
📱 To verify it is your number, tap "📱 Share my number" below (it must be ${phone}).`,
  trialInvalid: "⚠️ رابط التسجيل ده مش صالح أو انتهى. ارجع للموقع وابدأ من جديد.\n⚠️ This sign-up link is invalid or expired. Go back to the website and start again.",
  trialMismatch: "⚠️ الرقم اللي بعتّه مش نفس الرقم اللي كتبته في الموقع. جرّب تاني بالرقم الصح.\n⚠️ The number you shared is not the one you typed on the website. Try again with the right number.",
  trialLocked: "⚠️ محاولات كتير غلط. ارجع للموقع وابدأ من جديد.\n⚠️ Too many wrong attempts. Go back to the website and start again.",
  trialUsed:
    "⚠️ الرقم ده أو حساب تيليجرام ده استخدم التجربة المجانية قبل كده (تجربة واحدة بس). شوف الباقات أو كلمنا من الموقع: ",
  trialUsedEn: "⚠️ This number or Telegram account has already used its free trial (one trial only). See the plans or contact us on the website: ",
  trialHasAccount: "⚠️ حساب تيليجرام ده مربوط بحساب في WehdatHub بالفعل. ابعت «دخول».\n⚠️ This Telegram account is already linked to a WehdatHub account. Send \"login\".",
  trialDone: (b, url, minutes) =>
    b.preferred_lang === "en"
      ? `✅ Your agency is ready: 14-day free trial. Open the website (link valid ${minutes} minutes):
${url}`
      : `✅ شركتك جاهزة: تجربة مجانية 14 يوم. افتح الموقع (الرابط صالح ${minutes} دقيقة):
${url}`,
  linked: (b) => (b.preferred_lang === "en" ? `✅ Linked. Welcome, ${b.name}!` : `✅ تم ربط حسابك. أهلاً يا ${b.name}!`)
};

/** Builds the Telegram update handler around the pool, the tap guard and the shared turn runner. */
function createTelegramIngress({ pool, tapGuard, runTurn }) {
  async function tgAskToLink(chatId, text = TG_COPY.linkAsk) {
    await TG.call("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: { keyboard: [[{ text: TG_COPY.shareButton, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
    }).catch((e) => console.warn("Telegram link prompt failed:", e.message));
  }

  /** Links an unknown Telegram user (start token or own contact); true when the update was about linking. */
  async function tgLink(norm) {
    let res = null;
    if (norm.start) res = await TgLink.linkByToken(pool, norm.start, norm.ids);
    else if (norm.contact) res = await TgLink.linkByContact(pool, norm.contact, norm.ids);
    else {
      await tgAskToLink(norm.ids.chatId);
      return null;
    }
    if (res.broker) {
      await TG.call("sendMessage", { chat_id: norm.ids.chatId, text: TG_COPY.linked(res.broker), reply_markup: { remove_keyboard: true } }).catch(() => {});
      return res.broker;
    }
    await tgAskToLink(norm.ids.chatId, res.error === "not_own" ? TG_COPY.notOwn : res.error === "unknown" ? TG_COPY.unknown : TG_COPY.invalid);
    return null;
  }

  /** Self-serve trial signup (services/trialSignup.js): the start link and the contact share. true when the update was handled here. */
  async function trialSignupTurn(norm) {
    const chatId = norm.ids.chatId;
    const say = (text, markup) => TG.call("sendMessage", { chat_id: chatId, text, ...(markup ? { reply_markup: markup } : {}) }).catch((e) => console.warn("Telegram signup reply failed:", e.message));
    const usedText = () => `${TG_COPY.trialUsed}${Links.siteOrigin()}/#plans

${TG_COPY.trialUsedEn}${Links.siteOrigin()}/#plans`;
    const failText = (error) =>
      error === "not_own" ? TG_COPY.notOwn : error === "mismatch" ? TG_COPY.trialMismatch : error === "locked" ? TG_COPY.trialLocked : error === "trial_used" || error === "phone_taken" ? usedText() : error === "has_account" ? TG_COPY.trialHasAccount : TG_COPY.trialInvalid;
    if (norm.start && TrialSignup.isSignupToken(norm.start)) {
      const r = await TrialSignup.begin(pool, norm.start, norm.ids);
      if (!r.ok) {
        await say(failText(r.error));
        return true;
      }
      await say(TG_COPY.trialShare(r.signup.phone_e164), { keyboard: [[{ text: TG_COPY.shareButton, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true });
      return true;
    }
    if (norm.contact && (await TrialSignup.pendingFor(pool, norm.ids.userId))) {
      const r = await TrialSignup.verifyContact(pool, norm.contact, norm.ids);
      if (!r.ok) {
        await say(failText(r.error), r.error === "not_own" || r.error === "mismatch" ? { keyboard: [[{ text: TG_COPY.shareButton, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } : { remove_keyboard: true });
        return true;
      }
      const token = await WebAuth.issueLoginToken(pool, r.broker, { channel: "web" });
      await say(TG_COPY.trialDone(r.broker, Links.loginLinkUrl(token), WebAuth.LOGIN_TOKEN_TTL_MINUTES), { remove_keyboard: true });
      ErrorReports.alertOwner(`🆕 Self-serve trial: ${r.agency.name} (${r.broker.name}) +${r.broker.phone_number}`, { category: "new_trial", pool }).catch(() => {});
      return true;
    }
    return false;
  }

  /** One Telegram update: link if needed, then the same guarded turn as WhatsApp, answered on Telegram. */
  async function handleTelegramUpdate(update) {
    const norm = TgIngress.normalize(update);
    if (!norm) return;
    // A tap's spinner is stopped once we know whether the tap runs (a dropped tap gets a short toast instead).
    let answered = !norm.callbackId;
    const answer = (text = "") => {
      if (answered) return;
      answered = true;
      TG.answerCallback(norm.callbackId, text).catch(() => {});
    };
    let tap = null;
    try {
      await telegramTurn(norm, answer, (t) => (tap = t));
    } finally {
      answer();
      tap?.release();
    }
  }

  async function telegramTurn(norm, answer, holdTap) {
    if (!norm.callbackId && (await trialSignupTurn(norm))) return;
    let broker = await TgLink.findBroker(pool, norm.ids.userId);
    let message = norm.message || null;
    if (!broker) {
      broker = await tgLink(norm);
      if (!broker) return;
      message = { id: `tg:${norm.ids.chatId}:start:${Date.now()}`, from: `tg:${norm.ids.userId}`, type: "text", text: { body: broker.preferred_lang === "en" ? "help" : "مساعدة" } };
    } else if (norm.start !== undefined) {
      // /start from a linked broker: the command list.
      message = { id: `tg:${norm.ids.chatId}:start:${Date.now()}`, from: `tg:${norm.ids.userId}`, type: "text", text: { body: broker.preferred_lang === "en" ? "help" : "مساعدة" } };
    } else if (norm.callbackId) {
      const id = await TgLink.decodeCallback(pool, norm.data);
      if (!id) return;
      const tap = tapGuard.claim(broker.id, id);
      if (!tap.ok) return answer(TapGuard.toast(tap.reason, broker.preferred_lang));
      holdTap(tap);
      message = TgIngress.buttonMessage(norm, id);
      // "More" is used once: its button leaves the earlier results (the next page comes as a new message).
      if (norm.messageId && (id === "MORE_SEARCH" || id.startsWith("search_more:") || id.startsWith("SEARCH_STATUS:"))) {
        TG.call("editMessageReplyMarkup", { chat_id: norm.ids.chatId, message_id: norm.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
    }
    if (!message) return;
    if (String(broker.telegram_chat_id) !== String(norm.ids.chatId)) {
      await pool.query("UPDATE brokers SET telegram_chat_id = $2 WHERE id = $1", [broker.id, norm.ids.chatId]);
    }
    broker = { ...broker, channel: "telegram", telegram_chat_id: norm.ids.chatId };
    answer();
    TG.sendTyping(norm.ids.chatId).catch(() => {});
    await runTurn(broker, message, `tg:${norm.ids.userId}`);
  }

  return { handleTelegramUpdate };
}

module.exports = { TG_COPY, createTelegramIngress };
