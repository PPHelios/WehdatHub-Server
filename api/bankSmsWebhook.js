// The configured SMS relay forwards bank alerts for review and exact deposit matching.
"use strict";

const { timingSafeEqual } = require("node:crypto");
const { parseBankSms } = require("../services/bankSmsParser");
const Billing = require("../services/billing");
const BillingNotices = require("../services/billingNotices");
const ErrorReports = require("../lib/errorReports");

function register(api, { pool }) {
  api.post("/webhooks/bank-sms", async (req, res) => {
    const secret = process.env.BANK_WEBHOOK_SECRET;
    if (!secret || !(await Billing.paymentChannels(pool)).sms) return res.status(503).json({ error: "sms_disabled" });
    const provided = Buffer.from(req.get("x-bank-webhook-secret") || "");
    const expected = Buffer.from(secret);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const body = req.body || {};
    const text = body.message || body.text || body.body;
    if (typeof text !== "string" || !text.trim() || text.length > 3000) return res.status(422).json({ error: "invalid_message" });
    const sender = String(body.sender || body.from || "Unknown").slice(0, 120);
    const { reference, amount, incoming } = parseBankSms(text);
    const payment = reference ? (await pool.query(
      "SELECT p.*, a.name AS agency_name FROM payments p JOIN agencies a ON a.id = p.agency_id WHERE p.reference = $1",
      [reference]
    )).rows[0] : null;
    const exact = Boolean(incoming && payment?.status === "pending" && amount === Number(payment.amount_egp));
    const details = [
      "Bank SMS",
      `Sender: ${sender}`,
      `Reference: ${reference || "Unknown"} · Amount: ${amount == null ? "Unknown" : `${amount} EGP`}`,
      payment && `Agency: ${payment.agency_name} · ${payment.kind} ${payment.plan || payment.bundle_id || ""} · Expected: ${payment.amount_egp} EGP · ${payment.status}`,
      exact ? "Exact incoming deposit match." : "No automatic confirmation. Review the payment in CRM.",
      text
    ].filter(Boolean).join("\n");
    const sent = await ErrorReports.alertOwner(details, { category: "payments" });
    if (!sent) return res.status(503).json({ error: "telegram_delivery_failed" });
    if (!exact) return res.json({ ok: true, matched: false });
    const result = await Billing.confirmPayment(pool, payment.id);
    if (!result.ok) return res.status(409).json({ error: result.error });
    await BillingNotices.paymentConfirmed(pool, result).catch(() => {});
    return res.json({ ok: true, matched: true, payment: reference });
  });
}

module.exports = { register };
