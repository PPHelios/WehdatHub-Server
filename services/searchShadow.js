// services/searchShadow.js — After a search is answered: learn from the AI's reading when there was one, and (POC only,
// SEARCH_SHADOW_AI=true) ask the AI quietly about every search the parser answered alone, so the nightly check can compare
// the two readings. The quiet read has no broker in its context: it spends no agency credits, only a daily POC budget.
"use strict";

const Search = require("./search");
const Learn = require("./searchLearn");

const enabled = () => /^(1|true|on|yes)$/i.test(String(process.env.SEARCH_SHADOW_AI || ""));
const dailyMax = () => Math.max(0, Number(process.env.SEARCH_SHADOW_DAILY_MAX) || 300);

async function underBudget(pool) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM search_log WHERE created_at > now() - interval '1 day' AND source = 'parser' AND ai_filters IS NOT NULL");
  return rows[0].n < dailyMax();
}

/** Does the work of one search; never throws. */
async function observe(pool, AI, { logId, text, parse }) {
  try {
    if (!logId || !parse) return;
    if (parse.ai) {
      await Learn.learn(pool, { text, local: parse.local, ai: parse.ai });
      return;
    }
    if (parse.source !== "parser" || !enabled() || !(await underBudget(pool))) return;
    const r = await Search.parseRequest(AI, { text, ctx: { pool }, forceAi: true });
    if (!r.ai) return;
    await pool.query("UPDATE search_log SET ai_filters = $2::jsonb WHERE id = $1", [logId, JSON.stringify(r.ai.filters)]);
    await Learn.learn(pool, { text, local: parse.local, ai: r.ai });
  } catch (err) {
    console.warn("Search shadow check failed:", err.message);
  }
}

/** Fire and forget, after the answer has been sent. */
function schedule(pool, AI, args) {
  const t = setTimeout(() => {
    observe(pool, AI, args);
  }, 1500);
  if (t.unref) t.unref();
}

module.exports = { enabled, observe, schedule };
