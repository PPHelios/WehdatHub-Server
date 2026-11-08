// domain/dealType.js — One "deal type" choice for the units list and the map: rent, resale cash, resale with installments,
// primary. Pure: the SQL for each one is a fixed string (no user text inside).
"use strict";

const DEALS = ["rent", "resale_cash", "resale_installments", "primary"];

const LABELS = {
  rent: ["إيجار", "Rent"],
  resale_cash: ["ريسيل كاش", "Resale, cash"],
  resale_installments: ["ريسيل بالتقسيط", "Resale with installments"],
  primary: ["برايمري", "Primary"]
};

/** @returns {string} the deal type if known, else "". */
const clean = (v) => (DEALS.includes(String(v || "")) ? String(v) : "");

/** SQL condition for a deal type on a listings alias (use "" for a bare table). */
function sql(deal, alias = "l") {
  const c = alias ? `${alias}.` : "";
  switch (deal) {
    case "rent":
      return `${c}listing_type = 'rent'`;
    case "resale_cash":
      return `(${c}listing_type = 'sale' AND ${c}market = 'resale' AND coalesce(${c}remaining_amount, 0) = 0)`;
    case "resale_installments":
      return `(${c}listing_type = 'sale' AND ${c}market = 'resale' AND coalesce(${c}remaining_amount, 0) > 0)`;
    case "primary":
      return `${c}market = 'primary'`;
    default:
      return "TRUE";
  }
}

const label = (deal, lang = "ar") => (LABELS[deal] ? LABELS[deal][lang === "en" ? 1 : 0] : "");

module.exports = { DEALS, LABELS, clean, sql, label };
