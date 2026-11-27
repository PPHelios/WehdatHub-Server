// services/bankSmsParser.js — Parses incoming bank SMS / InstaPay alerts for amount and WH- reference.
"use strict";

const REF_RE = /\bWH-([A-Z0-9]{4,10})\b/i;
const AMOUNT_RE = /(?:EGP|جم|جنيه|مبلغ)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:EGP|جم|جنيه)/i;

/**
 * Extracts reference code (WH-XXXXXX) and numeric amount from a bank SMS.
 * @param {string} text
 * @returns {{ reference: string | null, amount: number | null, isBankSms: boolean }}
 */
function parseBankSms(text) {
  const str = String(text || "").trim();
  if (!str) return { reference: null, amount: null, isBankSms: false, incoming: false };

  const refMatch = REF_RE.exec(str);
  const reference = refMatch ? `WH-${refMatch[1].toUpperCase()}` : null;

  const depositText = str.split(/\b(?:available\s+|current\s+|remaining\s+)?balance\b|الرصيد/i, 1)[0];
  const amtMatch = AMOUNT_RE.exec(depositText);
  let amount = null;
  if (amtMatch) {
    const rawNum = (amtMatch[1] || amtMatch[2] || "").replace(/,/g, "");
    const parsed = parseFloat(rawNum);
    if (Number.isFinite(parsed) && parsed > 0) amount = parsed;
  }

  const isBankSms = /إنستاباي|instapay|ipn|تحويل|transfer|credited|حسابك/i.test(str);

  const incoming = /\bcredited\b|\binward\s+(?:ipn\s+)?transfer\b|إيداع|ايداع|تم إضافة|تم اضافة|تم استلام تحويل/i.test(depositText) &&
    !/\bdebited\b|\bsent\b|\bfailed\b|خصم|فشل|مرفوض/i.test(str);
  return { reference, amount, isBankSms, incoming };
}

module.exports = { parseBankSms };
