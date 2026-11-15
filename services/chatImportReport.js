// services/chatImportReport.js — One summary of the WhatsApp import, from the logs it already writes (web and app):
// how much the parser read on its own, where AI was needed and whether it agreed with the parser, what people corrected
// in the review, how long each step took and what failed, how often the app is used and how it ends.
// Read only. Cell names and counts only: the logs never hold a name, phone or the text of a post.
"use strict";

const P = (col) => `round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${col}))::int AS p50, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ${col}))::int AS p95`;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

/**
 * @param {Object} o
 * @param {number} [o.days=30] how far back
 * @param {string|null} [o.agencyId] one agency, or all
 */
async function report(pool, { days = 30, agencyId = null } = {}) {
  const since = [Math.max(1, Math.min(365, Number(days) || 30)), agencyId];
  const where = (extra = "") => `created_at > NOW() - ($1::int * INTERVAL '1 day') AND ($2::uuid IS NULL OR agency_id = $2::uuid) ${extra}`;
  const q = async (sql) => (await pool.query(sql, since)).rows;

  const [parse] = await q(`
    SELECT count(*)::int AS posts,
           count(*) FILTER (WHERE (metadata->>'complete_by_parser')::boolean)::int AS complete_by_parser,
           count(*) FILTER (WHERE (metadata->>'ai_used')::boolean)::int AS ai_used,
           count(*) FILTER (WHERE status = 'error')::int AS ai_errors,
           count(*) FILTER (WHERE metadata->>'ai_skipped' = 'rules_only')::int AS rules_only,
           count(*) FILTER (WHERE metadata->>'ai_skipped' IS NOT NULL AND metadata->>'ai_skipped' <> 'rules_only')::int AS ai_skipped_other,
           ${P("total_duration_ms")}
      FROM operation_logs WHERE operation_type = 'chat_parse' AND ${where()}`);

  const agreement = await q(`
    SELECT cell, count(*) FILTER (WHERE kind = 'agree')::int AS agree, count(*) FILTER (WHERE kind = 'differ')::int AS differ
      FROM (
        SELECT jsonb_array_elements_text(metadata #> '{ai_vs_parser,agree}') AS cell, 'agree' AS kind FROM operation_logs WHERE operation_type = 'chat_parse' AND ${where()}
        UNION ALL
        SELECT jsonb_array_elements_text(metadata #> '{ai_vs_parser,differ}'), 'differ' FROM operation_logs WHERE operation_type = 'chat_parse' AND ${where()}
      ) x GROUP BY cell ORDER BY (count(*)) DESC`);

  const corrected = await q(`
    SELECT cell, count(*)::int AS times
      FROM (SELECT jsonb_array_elements_text(d->'edited') AS cell
              FROM operation_logs, jsonb_array_elements(COALESCE(metadata->'detail', '[]'::jsonb)) AS d
             WHERE operation_type = 'chat_import_apply' AND ${where()}) x
     GROUP BY cell ORDER BY times DESC`);
  const [applied] = await q(`SELECT count(*)::int AS applies, COALESCE(sum((metadata->>'rows')::int), 0)::int AS rows, COALESCE(sum((metadata->>'edited')::int), 0)::int AS rows_edited FROM operation_logs WHERE operation_type = 'chat_import_apply' AND ${where()}`);

  const steps = await q(`
    SELECT metadata->>'step' AS step, count(*)::int AS n, count(*) FILTER (WHERE status = 'ok')::int AS ok, ${P("total_duration_ms")}
      FROM operation_logs WHERE operation_type = 'chat_import_step' AND ${where()} GROUP BY 1 ORDER BY n DESC`);
  const stepErrors = await q(`
    SELECT metadata->>'step' AS step, error_code, count(*)::int AS n
      FROM operation_logs WHERE operation_type = 'chat_import_step' AND status = 'error' AND ${where()} GROUP BY 1, 2 ORDER BY n DESC LIMIT 20`);

  const codes = await q(`
    SELECT metadata->>'channel' AS channel, count(*)::int AS calls, COALESCE(sum((metadata->>'codes')::int), 0)::int AS codes,
           COALESCE(sum((metadata->>'update')::int), 0)::int AS update, COALESCE(sum((metadata->>'taken')::int), 0)::int AS taken, COALESCE(sum((metadata->>'fresh')::int), 0)::int AS fresh,
           ${P("total_duration_ms")}
      FROM operation_logs WHERE operation_type = 'chat_import_codes' AND ${where()} GROUP BY 1`);

  const plans = await q(`
    SELECT count(*)::int AS plans, count(*) FILTER (WHERE (metadata->>'rules_only')::boolean)::int AS rules_only, count(*) FILTER (WHERE status = 'error')::int AS failed, ${P("total_duration_ms")}
      FROM operation_logs WHERE operation_type = 'web_import_plan' AND metadata->>'kind' = 'chat' AND ${where()}`);

  const app = await q(`
    SELECT event, count(*)::int AS n, count(*) FILTER (WHERE ok)::int AS ok, ${P("ms")}
      FROM usage_events WHERE event LIKE 'wa\\_import\\_%' AND ${where()} GROUP BY event ORDER BY event`);
  const appOutcomes = await q(`
    SELECT event, COALESCE(meta->>'outcome', meta->>'reason', meta->>'stage', 'ok') AS what, count(*)::int AS n
      FROM usage_events WHERE event LIKE 'wa\\_import\\_%' AND ${where()} GROUP BY 1, 2 ORDER BY event, n DESC`);
  const appAi = await q(`
    SELECT COALESCE(meta->>'ai', 'n/a') AS ai, count(*)::int AS n, count(*) FILTER (WHERE meta->>'outcome' = 'saved')::int AS saved
      FROM usage_events WHERE event = 'wa_import_add' AND ${where()} GROUP BY 1`);

  const agree = agreement.reduce((n, r) => n + r.agree, 0);
  const differ = agreement.reduce((n, r) => n + r.differ, 0);
  return {
    days: since[0],
    parser: { ...parse, complete_pct: pct(parse.complete_by_parser, parse.posts), ai_used_pct: pct(parse.ai_used, parse.posts), ai_error_pct: pct(parse.ai_errors, parse.ai_used) },
    ai_vs_parser: { agree, differ, agree_pct: pct(agree, agree + differ), by_cell: agreement.map((r) => ({ ...r, agree_pct: pct(r.agree, r.agree + r.differ) })) },
    review: { ...applied, edited_pct: pct(applied.rows_edited, applied.rows), cells_corrected: corrected },
    steps: steps.map((s) => ({ ...s, ok_pct: pct(s.ok, s.n) })),
    step_errors: stepErrors,
    codes,
    plans: plans[0],
    app: { events: app.map((e) => ({ ...e, ok_pct: pct(e.ok, e.n) })), outcomes: appOutcomes, ai_switch: appAi },
  };
}

module.exports = { report };
