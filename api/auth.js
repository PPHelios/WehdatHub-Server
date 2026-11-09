// api/auth.js — App sign-in with the six-digit code the bot sends (the same code and rules as the website's "send me a
// code"), then a session token. Asking for a code answers the same whether or not the number is registered.
"use strict";

const WebAuth = require("../lib/webAuth");
const RateLimit = require("../lib/rateLimit");
const Onboarding = require("../lib/onboarding");
const { notifyPreferred } = require("../lib/dispatcher");
const { logOperation: logOp } = require("../lib/db");
const Audit = require("../services/audit");
const { t } = require("../lib/copy");

const logOperation = (pool, p) => {
  Audit.fromOperation(pool, p);
  return logOp(pool, p);
};

const phoneOf = (v) => Onboarding.normalizeEgyptMobile(v) || String(v || "").replace(/\D/g, "");
const BROKER_BY_PHONE = `SELECT id, agency_id, name, phone_number, phone_normalized, role, preferred_lang
   FROM brokers WHERE phone_normalized = $1 AND is_active = true LIMIT 1`;

const brokerView = (b) => ({ id: b.id, name: b.name, role: b.role, lang: b.preferred_lang === "en" ? "en" : "ar" });
const agencyView = (a) => ({ id: a.id, name: a.name, slug: a.slug, logoUrl: a.logo_url || null });

function register(api, { pool }) {
  api.post("/auth/code/request", async (req, res) => {
    const ipGate = await RateLimit.hit(pool, `login_request:ip:${req.ip}`, RateLimit.LIMITS.loginRequestIp);
    if (!ipGate.allowed) return res.set("Retry-After", String(ipGate.retryAfterSec)).status(429).json({ error: "too_many" });
    const phone = phoneOf(req.body?.phone);
    if (phone.length >= 8) {
      const phoneGate = await RateLimit.hit(pool, `login_request:phone:${phone}`, RateLimit.LIMITS.loginRequestPhone);
      if (!phoneGate.allowed) return res.set("Retry-After", String(phoneGate.retryAfterSec)).status(429).json({ error: "too_many" });
      const broker = (await pool.query(BROKER_BY_PHONE, [phone])).rows[0];
      if (broker) {
        const code = await WebAuth.issueLoginCode(pool, broker);
        const lang = broker.preferred_lang || "ar";
        const sent = await notifyPreferred(broker, t("web_login_code", lang, { code, minutes: WebAuth.LOGIN_CODE_TTL_MINUTES }), { pool, kind: "web_login_link", action: "sign_in" });
        logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "api_login_code_request", status: sent ? "success" : "dropped" });
      }
    }
    return res.json({ ok: true, codeMinutes: WebAuth.LOGIN_CODE_TTL_MINUTES });
  });

  api.post("/auth/code/verify", async (req, res) => {
    const phone = phoneOf(req.body?.phone);
    const ipGate = await RateLimit.hit(pool, `login_confirm:ip:${req.ip}`, RateLimit.LIMITS.loginConfirmIp);
    if (!ipGate.allowed) return res.set("Retry-After", String(ipGate.retryAfterSec)).status(429).json({ error: "too_many" });
    const phoneGate = await RateLimit.hit(pool, `login_code_try:phone:${phone}`, { limit: 5, windowSec: 900 });
    if (!phoneGate.allowed) return res.set("Retry-After", String(phoneGate.retryAfterSec)).status(429).json({ error: "too_many" });
    const found = (await pool.query(BROKER_BY_PHONE, [phone])).rows[0];
    const broker = await WebAuth.consumeLoginCode(pool, found, req.body?.code);
    if (!broker) {
      logOperation(pool, { operation_type: "api_login_code", status: "failed", metadata: { ip: req.ip } });
      return res.status(401).json({ error: "invalid_code" }); // wrong, expired and used read the same
    }
    const { sid, expiresAt } = await WebAuth.createSession(pool, broker, { userAgent: req.get("user-agent") });
    const session = await WebAuth.getSession(pool, sid);
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "api_login_code", metadata: { ip: req.ip } });
    return res.json({ token: sid, expiresAt, broker: brokerView(session.broker), agency: agencyView(session.agency) });
  });

  api.post("/auth/logout", async (req, res) => {
    if (req.token) await WebAuth.revokeSession(pool, req.token);
    if (req.session) logOperation(pool, { agency_id: req.session.broker.agency_id, broker_id: req.session.broker.id, operation_type: "api_logout" });
    return res.json({ ok: true });
  });

  api.get("/me", async (req, res) => {
    if (!req.session) return res.status(401).json({ error: "unauthorized" });
    return res.json({ broker: brokerView(req.session.broker), agency: agencyView(req.session.agency), rights: await require("../services/unitRights").rights(pool, req.session.broker), expiresAt: req.session.expiresAt });
  });
}

module.exports = { register };
