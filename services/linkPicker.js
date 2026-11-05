// services/linkPicker.js — Telegram: after a client copy (the bot's unit text with its link), the broker picks who it is for:
// a number, a lead ID (L-0042) or a shared contact, or skips. Skipping leaves the link with no recipient. The choice waits
// 10 minutes in broker_sessions; the broker's next text or contact completes it. Only the link the copy just made is
// attached (the newest bot link of that unit by this broker). Services on WhatsApp keep the copy without the picker: its
// buttons are limited to three.
"use strict";

const Phone = require("../domain/phone");
const Recipients = require("./linkRecipients");

const SESSION = "link_pick";
const TTL_MIN = 10;
const RECENT_MS = 2 * 60 * 1000;

const saveSession = (pool, brokerId, data) =>
  pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, $2, $3::jsonb, NOW() + make_interval(mins => $4))
     ON CONFLICT (broker_id, session_type) DO UPDATE SET session_data = EXCLUDED.session_data, expires_at = EXCLUDED.expires_at`,
    [brokerId, SESSION, JSON.stringify(data), TTL_MIN]
  );

async function pending(pool, broker) {
  const { rows } = await pool.query("SELECT session_data FROM broker_sessions WHERE broker_id = $1 AND session_type = $2 AND expires_at > NOW()", [broker.id, SESSION]);
  return rows[0]?.session_data || null;
}

const clearSession = (pool, brokerId) => pool.query("DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = $2", [brokerId, SESSION]);

/** The buttons under a client copy (Telegram only): who it is for, or skip. */
function buttons(lang) {
  const en = lang === "en";
  return [
    { id: "lk:num", title: en ? "📱 By number" : "📱 برقم" },
    { id: "lk:id", title: en ? "🆔 By lead ID" : "🆔 برقم العميل" },
    { id: "lk:contact", title: en ? "📇 From contact" : "📇 من جهة الاتصال" },
    { id: "lk:skip", title: en ? "⏭️ Skip" : "⏭️ تخطي" }
  ];
}

/** After a client copy: remember the link it just made, so the broker's answer attaches to that one. */
async function offer(pool, broker, listing) {
  const { rows } = await pool.query(
    `SELECT token_hash FROM share_links WHERE agency_id = $1 AND broker_id = $2 AND listing_id = $3 AND source = 'bot' AND created_at > $4
     ORDER BY created_at DESC LIMIT 1`,
    [broker.agency_id, broker.id, listing.id, new Date(Date.now() - RECENT_MS).toISOString()]
  );
  if (!rows[0]) return null;
  await saveSession(pool, broker.id, { tokenHash: rows[0].token_hash, code: listing.code, step: "choose" });
  return buttons(broker.preferred_lang);
}

/** The picker's buttons: lk:num | lk:id | lk:contact | lk:skip → the prompt to answer (or done). */
async function handleButton(pool, broker, id, { reply, lang }) {
  const en = lang === "en";
  const s = await pending(pool, broker);
  if (!s) return reply(broker, en ? "⏳ That link choice has expired. Tap Client Copy again." : "⏳ اختيار الرابط ده انتهى. اضغط نص العميل تاني.");
  if (id === "lk:skip") {
    await clearSession(pool, broker.id);
    return reply(broker, en ? `✅ Sent with no recipient (${s.code}).` : `✅ اتسجل من غير مستلم (${s.code}).`);
  }
  const step = id === "lk:num" ? "number" : id === "lk:id" ? "id" : "contact";
  await saveSession(pool, broker.id, { ...s, step });
  if (step === "number") return reply(broker, en ? "📱 Send the client's mobile number (01xxxxxxxxx), or type *skip*." : "📱 ابعت رقم العميل (01xxxxxxxxx)، أو اكتب *تخطي*.");
  if (step === "id") return reply(broker, en ? "🆔 Send the lead ID (for example L-0042), or type *skip*." : "🆔 ابعت رقم العميل في النظام (مثلاً L-0042)، أو اكتب *تخطي*.");
  return reply(broker, en ? "📇 Share a contact from Telegram (📎 → Contact), or type *skip*." : "📇 ابعت جهة اتصال من تيليجرام (📎 ← جهة اتصال)، أو اكتب *تخطي*.");
}

/**
 * The broker's next text or contact while a choice is waiting. Returns false when nothing is waiting (or the text is not an
 * answer yet), so the message goes on to the usual handlers.
 */
async function handleInput(pool, broker, message, { reply, lang }) {
  const en = lang === "en";
  const s = await pending(pool, broker);
  if (!s) return false;
  if (message.type === "text") {
    const text = String(message.text?.body || "").trim();
    if (/^(?:تخطي|skip)$/i.test(text)) {
      await clearSession(pool, broker.id);
      await reply(broker, en ? `✅ Sent with no recipient (${s.code}).` : `✅ اتسجل من غير مستلم (${s.code}).`);
      return true;
    }
    if (s.step === "choose" || !s.step) return false;
    return attach(pool, broker, s, { text }, { reply, lang });
  }
  if (message.type === "contacts") {
    const phone = message.contacts?.[0]?.phones?.[0]?.phone;
    if (!phone) return false;
    const digits = Phone.normalizePhone(phone);
    return attach(pool, broker, s, { text: digits ? `+${digits}` : String(phone) }, { reply, lang });
  }
  return false;
}

async function attach(pool, broker, s, { text }, { reply, lang }) {
  const en = lang === "en";
  const r = await Recipients.resolveRecipient(pool, broker, text);
  if (r.error) {
    await reply(broker, r.error === "lead_not_found" ? (en ? "No lead with that ID. Send another, or type *skip*." : "مفيش عميل بالرقم ده. ابعت رقم تاني، أو اكتب *تخطي*.") : en ? "That isn't a valid mobile number. Send it again, or type *skip*." : "الرقم مش صحيح. ابعته تاني، أو اكتب *تخطي*.");
    return true;
  }
  await pool.query(
    "UPDATE share_links SET recipient_phone = $3, lead_id = $4 WHERE token_hash = $1 AND agency_id = $2 AND broker_id = $5",
    [s.tokenHash, broker.agency_id, r.phone, r.leadId, broker.id]
  );
  await clearSession(pool, broker.id);
  const wa = r.phone ? Phone.waMeUrl(r.phone) : null;
  const who = r.phone ? Phone.displayPhone(r.phone) : en ? "no number" : "من غير رقم";
  const tail = wa ? (en ? `\nSend it on WhatsApp: ${wa}` : `\nابعته على واتساب: ${wa}`) : "";
  await reply(broker, en ? `✅ Linked to ${who} (${s.code}).${tail}` : `✅ اتربط بـ ${who} (${s.code}).${tail}`);
  return true;
}

module.exports = { SESSION, TTL_MIN, buttons, offer, pending, handleButton, handleInput, attach };
