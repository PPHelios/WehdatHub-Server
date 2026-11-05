// services/planRules.js — A project's payment plan rules (custom plan calculator, step 1). Managers set them on the
// project's Plans section; the calculator reads them to tell a plan inside the rules from an exception.
"use strict";

const { isManager } = require("../lib/authz");

const FREQUENCIES = ["monthly", "quarterly", "semi_annual", "annual"];
const DUE = ["delivery", "installments", "contract"];
const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
const inRange = (n, lo, hi) => n === null || (Number.isFinite(n) && n >= lo && n <= hi);

/** Clean the rules from a form body. Every field is optional. Returns { rules } or { error }. */
function cleanRules(input = {}) {
  const rules = {
    min_down_payment_pct: num(input.min_down_payment_pct),
    max_years: num(input.max_years),
    max_discount_pct: num(input.max_discount_pct),
    maintenance_pct: num(input.maintenance_pct),
    maintenance_due: DUE.includes(input.maintenance_due) ? input.maintenance_due : null,
    frequencies: [].concat(input.frequencies || []).filter((f) => FREQUENCIES.includes(f)),
    optional_fees: []
  };
  if (!inRange(rules.min_down_payment_pct, 0, 100)) return { error: "min_down_payment_pct" };
  if (!inRange(rules.max_years, 0, 20)) return { error: "max_years" };
  if (!inRange(rules.max_discount_pct, 0, 100)) return { error: "max_discount_pct" };
  if (!inRange(rules.maintenance_pct, 0, 30)) return { error: "maintenance_pct" };
  const labels = [].concat(input.fee_label || []);
  const amounts = [].concat(input.fee_amount || []);
  const dues = [].concat(input.fee_due || []);
  labels.forEach((label, i) => {
    const text = String(label || "").trim().slice(0, 60);
    const amount = num(amounts[i]);
    if (!text) return;
    if (amount === null || !Number.isFinite(amount) || amount < 0) return;
    rules.optional_fees.push({ label: text, amount: Math.round(amount), due: DUE.includes(dues[i]) ? dues[i] : "delivery" });
  });
  return { rules };
}

/** Save a project's rules (managers only). */
async function saveRules(db, actor, projectId, input = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  if (!/^[0-9a-f-]{36}$/i.test(String(projectId || ""))) return { error: "not_found" };
  const cleaned = cleanRules(input);
  if (cleaned.error) return cleaned;
  const { rows } = await db.query(
    "UPDATE projects SET plan_rules = $3::jsonb, updated_at = now() WHERE id = $1 AND agency_id = $2 RETURNING id",
    [projectId, actor.agency_id, JSON.stringify(cleaned.rules)]
  );
  return rows[0] ? { ok: true, rules: cleaned.rules } : { error: "not_found" };
}

/**
 * Check one plan against the rules: { exception: bool, reasons: [] }. A project with no rules has no exceptions.
 * plan: { down_payment_pct, years, frequency, discount_pct, maintenance_pct }.
 */
function checkPlan(rules = {}, plan = {}) {
  const reasons = [];
  if (rules.min_down_payment_pct != null && Number(plan.down_payment_pct) < rules.min_down_payment_pct) reasons.push("down_payment");
  if (rules.max_years != null && Number(plan.years) > rules.max_years) reasons.push("years");
  if (rules.max_discount_pct != null && Number(plan.discount_pct) > rules.max_discount_pct) reasons.push("discount");
  if (Array.isArray(rules.frequencies) && rules.frequencies.length && !rules.frequencies.includes(plan.frequency)) reasons.push("frequency");
  return { exception: reasons.length > 0, reasons };
}

module.exports = { FREQUENCIES, DUE, cleanRules, saveRules, checkPlan };
