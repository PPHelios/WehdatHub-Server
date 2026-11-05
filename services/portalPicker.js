// services/portalPicker.js — Finish a saved portal enquiry from the chat (Telegram and WhatsApp). After a manager's Bayut
// (Dubizzle, Nawy) enquiry is saved, the manager's next text is the client's phone, then the broker's name or phone. Both
// steps wait 10 minutes in broker_sessions; "skip" or "تخطي" ends it. The last step calls PortalEnquiries.assign, so the
// enquiry becomes a lead exactly as it does on the website.
"use strict";

const Phone = require("../domain/phone");
const PortalEnquiries = require("./portalEnquiries");

const SESSION = "portal_pick";
const TTL_MIN = 10;

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

/** After a saved enquiry: the manager's next text is the phone. */
async function offer(pool, broker, enquiryId) {
  await saveSession(pool, broker.id, { enquiryId, step: "phone" });
}

/** Finds one active broker of the agency by exact phone or by name (case-insensitive). Null when none or several match. */
async function findBroker(pool, agencyId, text) {
  const digits = Phone.normalizePhone(text);
  const { rows } = await pool.query(
    `SELECT id, name FROM brokers WHERE agency_id = $1 AND is_active
       AND (lower(name) = lower($2) OR ($3::text IS NOT NULL AND phone_normalized = $3))
     LIMIT 2`,
    [agencyId, text, digits || null]
  );
  return rows.length === 1 ? rows[0] : null;
}

/**
 * The manager's next text while an enquiry waits for its phone and broker. Returns false when nothing is waiting, so the
 * message goes on to the usual handlers.
 */
async function handleInput(pool, broker, message, { reply, lang }) {
  if (message.type !== "text") return false;
  const s = await pending(pool, broker);
  if (!s) return false;
  const en = lang === "en";
  const text = String(message.text?.body || "").trim();

  if (/^(?:تخطي|skip)$/i.test(text)) {
    await clearSession(pool, broker.id);
    await reply(broker, en ? "✅ Left in Portal enquiries. Add the phone on the website when ready." : "✅ اتسجل في استفسارات البوابات. ضيف الرقم على الموقع لما تكون جاهز.");
    return true;
  }

  if (s.step === "phone") {
    const e164 = Phone.toE164(text);
    if (!e164) {
      await reply(broker, en ? "That isn't a valid mobile number. Send it again, or type *skip*." : "الرقم مش صحيح. ابعته تاني، أو اكتب *تخطي*.");
      return true;
    }
    await saveSession(pool, broker.id, { enquiryId: s.enquiryId, step: "broker", phone: e164 });
    await reply(broker, en ? "👤 Send the broker's name or mobile number, or type *skip*." : "👤 ابعت اسم الوسيط أو رقم موبايله، أو اكتب *تخطي*.");
    return true;
  }

  // step "broker"
  const target = await findBroker(pool, broker.agency_id, text);
  if (!target) {
    await reply(broker, en ? "No single active broker matches that. Send the name or number again, or type *skip*." : "مفيش وسيط نشط مطابق للاسم أو الرقم ده. ابعته تاني، أو اكتب *تخطي*.");
    return true;
  }
  const res = await PortalEnquiries.assign(pool, broker, s.enquiryId, { phone: s.phone, brokerId: target.id });
  await clearSession(pool, broker.id);
  if (res.error) {
    await reply(broker, en ? `⚠️ Could not make it a lead (${res.error}). Try again on the website.` : `⚠️ ما اتحولش لعميل (${res.error}). جرب من الموقع.`);
    return true;
  }
  await reply(broker, en ? `✅ Lead ${res.leadRef} created for ${target.name}.` : `✅ اتسجل العميل ${res.leadRef} لـ ${target.name}.`);
  return true;
}

module.exports = { SESSION, TTL_MIN, offer, pending, handleInput };
