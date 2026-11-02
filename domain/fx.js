// domain/fx.js — Dollar and euro rates per agency (EGP per one unit). Pure: no I/O.
// A rate is set by the owner or a manager. A blank rate means "not set": units and budgets in that currency are then
// left out of price matches, and search shows a notice.
"use strict";

const CURRENCIES = ["USD", "EUR"];
const MIN_RATE = 1;
const MAX_RATE = 1000;

/** A form value to a rate: null for blank, a number to 2 decimals, or undefined when it is not a usable rate. */
function parseRate(raw) {
  const s = String(raw ?? "").trim().replace(/,/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < MIN_RATE || n > MAX_RATE) return undefined;
  return Math.round(n * 100) / 100;
}

/** Stored rates ({ USD, EUR }) from the agency's saved settings. Missing values are null. */
function ratesFrom(stored) {
  const out = {};
  for (const c of CURRENCIES) {
    const v = Number(stored?.[c]);
    out[c] = Number.isFinite(v) && v >= MIN_RATE ? v : null;
  }
  return out;
}

/** Converts an amount in a currency to EGP. EGP and no currency stay as they are; a missing rate gives null. */
function toEgp(amount, currency, rates) {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return null;
  if (!currency || currency === "EGP") return Number(amount);
  const r = rates?.[currency];
  return r ? Math.round(Number(amount) * r) : null;
}

/** The currency a message names: USD ($, dollar, دولار), EUR (€, euro, يورو), or null for none. Works on raw text. */
function currencyOfText(raw) {
  const s = String(raw || "");
  if (/\$|\busd\b|\bdollars?\b|دولار/i.test(s)) return "USD";
  if (/€|\beur\b|\beuros?\b|يورو/i.test(s)) return "EUR";
  return null;
}

/** Currency words removed from normalized search text, so they never become place names. */
const CURRENCY_WORDS = /\s(usd|dollars?|eur|euros?|دولار|دولارات|يورو|يوروهات)(?=\s)/g;

/** Currencies that have no rate yet. */
function missing(currencies, rates) {
  return CURRENCIES.filter((c) => currencies.includes(c) && !rates?.[c]);
}

module.exports = { CURRENCIES, MIN_RATE, MAX_RATE, parseRate, ratesFrom, toEgp, currencyOfText, CURRENCY_WORDS, missing };
