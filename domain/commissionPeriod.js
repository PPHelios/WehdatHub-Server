// domain/commissionPeriod.js — The period filter of the commissions tab. Periods follow the Cairo calendar: a month
// runs from its 1st to the next 1st, a week from Saturday to Saturday. `at` is any day inside the period (default: today),
// and prev/next step the period by one month or one week.
"use strict";

const Stages = require("./leadStages");

const PERIODS = ["month", "week", "all"];
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

// Calendar arithmetic on plain YYYY-MM-DD strings, so no timezone is involved.
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const addMonths = (day, n) => {
  const d = new Date(`${day.slice(0, 8)}01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
// The week starts on Saturday (Egypt's working week): Saturday → itself, Friday → six days back.
const saturday = (day) => {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 1) % 7));
};
/** The Cairo midnight that starts a calendar day, as an instant. */
const cairoStart = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return Stages.cairoDayAt(new Date(Date.UTC(y, m - 1, d)), 0, 0);
};

/**
 * @param {string} period - "month" | "week" | "all"
 * @param {string} [at] - a YYYY-MM-DD day inside the period
 * @returns {{ period, at, from, to, fromDay, toDay, prevAt, nextAt }} from/to are ISO instants (to is exclusive);
 *          all null for "all".
 */
function periodRange(period, at, now = new Date()) {
  const p = PERIODS.includes(period) ? period : "month";
  const anchor = isDay(at) ? at : Stages.cairoDay(now);
  if (p === "all") return { period: p, at: anchor, from: null, to: null, fromDay: null, toDay: null, prevAt: null, nextAt: null };
  const fromDay = p === "week" ? saturday(anchor) : `${anchor.slice(0, 8)}01`;
  const endDay = p === "week" ? addDays(fromDay, 7) : addMonths(anchor, 1);
  const step = (n) => (p === "week" ? addDays(anchor, 7 * n) : addMonths(anchor, n));
  return {
    period: p,
    at: anchor,
    from: cairoStart(fromDay).toISOString(),
    to: cairoStart(endDay).toISOString(),
    fromDay,
    toDay: addDays(endDay, -1),
    prevAt: step(-1),
    nextAt: step(1)
  };
}

module.exports = { PERIODS, periodRange, isDay };
