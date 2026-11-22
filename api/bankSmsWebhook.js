// api/bankSmsWebhook.js — Inbound webhook for bank SMS / InstaPay alerts (Option B).
"use strict";

const { parseBankSms } = require("../services/bankSmsParser");
const Billing = require("../services/billing");
const ErrorReports = require("../lib/errorReports");

function register(api, { pool }) {
  api.post("/webhooks/bank-sms", async (req, res) => {
    const auth = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const headerSecret = req.get("x-bank-webhook-secret");
    const querySecret = req.query.secret;
    const provided = headerSecret || auth || querySecret;
    const expected = process.env.BANK_WEBHOOK_SECRET || process.env.WHATSAPP_APP_SECRET || "wehdat-bank-sms-secret";

    if (!provided || provided !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const text = req.body?.message || req.body?.text || req.body?.body || "";
    const sender = req.body?.sender || req.body?.from || "Bank";
    const { reference, amount, isBankSms } = parseBankSms(text);

    if (!reference) {
      if (isBankSms) {
        ErrorReports.alertOwner(
          `⚠️ Unmatched Bank Deposit Alert:\nSender: ${sender}\nAmount: ${amount ? `${amount} EGP` : "Unknown"}\n"${String(text).slice(0, 200)}"\nConfirm manually on /app/owner if pending.`,
          { category: "payments", pool }
        ).catch(() => {});
      }
      return res.json({ ok: true, matched: false, reason: "no_reference" });
    }

    const { rows: payments } = await pool.query(
      "SELECT * FROM payments WHERE reference = $1 AND status = 'pending' LIMIT 1",
      [reference]
    );
    const p = payments[0];
    if (!p) {
      ErrorReports.alertOwner(
        `⚠️ Bank SMS received with reference ${reference}, but no pending payment found in database.\n"${String(text).slice(0, 150)}"`,
        { category: "payments", pool }
      ).catch(() => {});
      return res.json({ ok: true, matched: false, reason: "payment_not_found", reference });
    }

    const result = await Billing.confirmPayment(pool, p.id);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    ErrorReports.alertOwner(
      `✅ Auto-Confirmed: Payment ${reference} (${p.amount_egp} EGP) automatically verified via Bank SMS (${sender}).`,
      { category: "payments", pool }
    ).catch(() => {});

    return res.json({ ok: true, matched: true, payment: reference });
  });
}

module.exports = { register };
