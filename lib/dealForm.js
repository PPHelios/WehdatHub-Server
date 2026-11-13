// lib/dealForm.js — Deal form fields (website and app send the same ones) → the input services/deals.js takes. One reading for both.
"use strict";

const Commission = require("../domain/commission");
const T = require("./text");
const { parseCommission } = require("./deals");
const { isManager } = require("./authz");

/** Form fields → services/deals.js input. */
function inputFromForm(body, broker) {
  const commission = parseCommission(String(body.commission || "")) || {};
  const extText = String(body.external || "").trim();
  const extPct = Commission.parsePct(extText);
  const extAmount = !extPct && extText ? T.parseEgyptianPrice(T.normalizeDigits(extText))?.priceValue || null : null;
  const external = extPct ? { pct: extPct.pct, name: body.external_name } : extAmount ? { amount: extAmount, name: body.external_name } : null;
  const price = String(body.price || "").trim() ? T.parseEgyptianPrice(T.normalizeDigits(String(body.price)))?.priceValue || -1 : null;
  const splitPct = Number(String(body.split_pct || "").replace(/[%٪\s]/g, ""));
  return {
    leadKey: String(body.lead || "").trim(),
    unitCode: String(body.unit || "").trim() || null,
    price,
    mode: commission.mode,
    pct: commission.pct,
    amount: commission.amount,
    external,
    splits: body.split_with ? [{ brokerId: body.split_with, pct: splitPct }] : [],
    dealType: body.deal_type,
    status: body.status,
    markSold: body.mark_sold === "1",
    notes: body.notes,
    closingBrokerId: isManager(broker) && body.closing_broker ? body.closing_broker : null
  };
}


/** A manager's correction: { mode, pct|amount, price?, external } or null when the commission is missing. */
function correctionFrom(body) {
  const c = parseCommission(String(body.commission || ""));
  if (!c) return null;
  const out = { ...c };
  const price = T.parseEgyptianPrice(T.normalizeDigits(String(body.price || "")))?.priceValue;
  if (price) out.price = price;
  const ext = String(body.external || "").trim();
  const pct = Commission.parsePct(ext);
  out.external = pct ? { pct: pct.pct } : { amount: ext ? T.parseEgyptianPrice(T.normalizeDigits(ext))?.priceValue || 0 : 0 };
  return out;
}

module.exports = { inputFromForm, correctionFrom };
