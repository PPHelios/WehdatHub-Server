// domain/parserReport.js — The weekly one-page agreement report for every text parser (Parser consolidation, Phase 5).
// Pure: takes `parser_read` rows (operation_logs.metadata) and search_log rows, returns numbers and a short text page.
// Only counts and field names; never the logged text.
"use strict";

const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);

/** @param {{ metadata: object, status?: string }[]} reads  @returns per parser: runs, fields read, empty, agreement */
function summarizeReads(reads = []) {
  const by = {};
  for (const r of reads) {
    const m = r.metadata || {};
    const p = (by[m.parser || "unknown"] ||= { parser: m.parser || "unknown", runs: 0, errors: 0, read: {}, empty: {}, unsure: {}, agree: {}, differ: {} });
    p.runs++;
    if (r.status && r.status !== "ok") p.errors++;
    for (const [key, list] of [["read", m.read], ["empty", m.empty], ["unsure", m.unsure], ["agree", m.agree], ["differ", m.differ]]) {
      for (const f of Array.isArray(list) ? list : []) p[key][f] = (p[key][f] || 0) + 1;
    }
  }
  return Object.values(by).map((p) => {
    const fields = [...new Set([...Object.keys(p.agree), ...Object.keys(p.differ)])];
    const perField = fields
      .map((f) => ({ field: f, agree: p.agree[f] || 0, differ: p.differ[f] || 0, agreement: pct(p.agree[f] || 0, (p.agree[f] || 0) + (p.differ[f] || 0)) }))
      .sort((a, b) => (a.agreement ?? 101) - (b.agreement ?? 101));
    const agreeTotal = perField.reduce((n, x) => n + x.agree, 0);
    const compared = perField.reduce((n, x) => n + x.agree + x.differ, 0);
    const emptyTop = Object.entries(p.empty).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([field, n]) => ({ field, n, rate: pct(n, p.runs) }));
    return { parser: p.parser, runs: p.runs, errors: p.errors, agreement: pct(agreeTotal, compared), perField, emptyTop };
  });
}

/** Search: per filter, how often parser and AI disagreed (search_log.disagree is a list of filter names). */
function summarizeSearch(rows = []) {
  const total = rows.length;
  const withAi = rows.filter((r) => r.source === "ai").length;
  const counts = {};
  let disagreed = 0;
  for (const r of rows) {
    const d = Array.isArray(r.disagree) ? r.disagree : [];
    if (d.length) disagreed++;
    for (const f of d) counts[f] = (counts[f] || 0) + 1;
  }
  const perFilter = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([filter, n]) => ({ filter, n, rate: pct(n, withAi || total) }));
  return { total, withAi, disagreed, agreement: pct(withAi - disagreed, withAi), perFilter };
}

/** One page of plain text for the owner. */
function renderReport({ days = 7, reads = [], search = [] } = {}) {
  const parsers = summarizeReads(reads);
  const s = summarizeSearch(search);
  const out = [`Parser agreement report, last ${days} days`, ""];
  out.push(`Search: ${s.total} searches, ${s.withAi} read by both parser and AI, agreement ${s.agreement ?? "n/a"}%`);
  for (const f of s.perFilter.slice(0, 8)) out.push(`  - ${f.filter}: differed ${f.n} times (${f.rate}%)`);
  out.push("");
  if (!parsers.length) out.push("No parser_read rows in this period.");
  for (const p of parsers) {
    out.push(`${p.parser}: ${p.runs} runs, ${p.errors} errors${p.agreement === null ? "" : `, agreement with the AI ${p.agreement}%`}`);
    for (const f of p.perField.slice(0, 5)) out.push(`  - ${f.field}: ${f.agreement}% (${f.agree} agree, ${f.differ} differ)`);
    for (const e of p.emptyTop) out.push(`  - left empty: ${e.field} in ${e.rate}% of runs`);
  }
  out.push("", "Next: turn the differing fields and the often-empty ones into golden cases (tests/parsers), fix, re-run the harness, refresh the recall set.");
  return out.join("\n");
}

module.exports = { summarizeReads, summarizeSearch, renderReport };
