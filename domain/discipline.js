// domain/discipline.js — Pure classification of how consistently each broker updates the app after client actions.
"use strict";

const UPDATE_EVENT_KINDS = Object.freeze([
  "contacted",
  "stage",
  "note",
  "follow_up_set",
  "follow_up_done",
  "follow_up_postponed"
]);

/**
 * Classifies one broker's CRM update discipline.
 * Inactive brokers or those holding < 3 open leads are never flagged silent so new/light seats don't trigger noise.
 * @returns {"consistent"|"lagging"|"silent"}
 */
function classifyBroker({ active = true, open = 0, updates48h = 0, staleOpen = 0, noNextStep = 0, missed = 0, responded = 0 } = {}) {
  if (!active) return "consistent";
  if (Number(open) >= 3 && Number(updates48h) === 0) return "silent";
  if (Number(staleOpen) > 0 || Number(noNextStep) >= 3 || (Number(open) >= 3 && Number(missed) > Number(responded))) {
    return "lagging";
  }
  return "consistent";
}

/** Summarizes discipline counts across a dashboard board slice (active brokers for status buckets). */
function summarizeBoard(board = []) {
  const out = { consistent: 0, lagging: 0, silent: 0, totalNoNextStep: 0, totalMissed: 0 };
  for (const row of board) {
    if (row.active === false) continue;
    out.totalNoNextStep += Number(row.noNextStep) || 0;
    out.totalMissed += Number(row.missed) || 0;
    const status = row.discipline === "silent" || row.discipline === "lagging" ? row.discipline : "consistent";
    out[status] += 1;
  }
  return out;
}

module.exports = { UPDATE_EVENT_KINDS, classifyBroker, summarizeBoard };
