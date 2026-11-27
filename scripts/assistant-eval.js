// scripts/assistant-eval.js — Local check of the Ask assistant: every question of the fixture, as owner, manager and broker1.
// Usage: node --env-file=.env scripts/assistant-eval.js [--agency <id>] [--ai] [--fixture <file>] [--only <id>]
// Without --ai no AI key is used, so nothing is spent (a question that needs AI then shows as its own result).
// A role that may not see a report must get a role answer (notForRole + suggestions), never a generic clarify; an intent may set
// "brokerExpect": "not_for_role" in the fixture to require it for broker1 (optional, older fixtures keep working).
// Checks: route, queue and window of the router; unit-search filters; off-topic -> clarify; a CRM question never becomes a unit
// search; the same question twice gives the same answer; a queue count equals the list the app screen shows.
// Prints counts and ids only (no client names or phones) and writes nothing to disk. Exit code 1 when anything FAILs.
"use strict";

const path = require("path");

const ROLES = ["owner", "manager", "broker1"];
const VOLATILE = /(At|Url|Ms)$|^(now|suggestions|id|logId)$/; // keys that change between two identical asks

const stable = (v) => JSON.stringify(v, (k, x) => (VOLATILE.test(k) ? undefined : x));
const short = (s, n = 46) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Independent SQL for the queue definitions (not the service's code): who sees which leads, then the queue's own rule. */
async function independentCount(pool, actor, kind, windowInfo, now) {
  const manager = ["owner", "manager", "admin"].includes(actor.role);
  const args = [actor.agency_id];
  let scope = "";
  if (!manager) { args.push(actor.id); scope = ` AND l.assigned_broker_id = $${args.length}`; }
  const n = args.length;
  const q = async (sql, extra = []) => Number((await pool.query(sql.replace("/*scope*/", scope), [...args, ...extra])).rows[0].n);
  const Vis = require("../lib/visibility");
  if (kind === "viewings") {
    if (!windowInfo?.from || !windowInfo?.to) return null;
    const win = [new Date(windowInfo.from).toISOString(), new Date(windowInfo.to).toISOString()];
    const OPEN = require("../services/viewings").OPEN;
    // Booked = leads with an open row in the viewings table (what the Calendar lists), counted from that table and from every in-scope broker's Calendar list.
    const booked = await q(`SELECT count(DISTINCT l.id)::int AS n FROM viewings v JOIN leads l ON l.id = v.lead_id AND l.agency_id = v.agency_id
      WHERE ${Vis.leads("l")} AND v.agency_id = $1 AND v.status = ANY($${n + 3}) AND v.starts_at >= $${n + 1} AND v.starts_at < $${n + 2}/*scope*/`, [...win, OPEN]);
    const confirmed = await q(`SELECT count(DISTINCT l.id)::int AS n FROM viewings v JOIN leads l ON l.id = v.lead_id AND l.agency_id = v.agency_id
      WHERE ${Vis.leads("l")} AND v.agency_id = $1 AND v.status = 'confirmed' AND v.starts_at >= $${n + 1} AND v.starts_at < $${n + 2}/*scope*/`, win);
    const ids = manager ? (await pool.query("SELECT * FROM brokers WHERE agency_id = $1 AND is_active", [actor.agency_id])).rows : [actor];
    let calendar = 0;
    for (const b of ids) calendar += (await require("../services/viewings").listForBroker(pool, b, { from: new Date(win[0]), to: new Date(win[1]) })).length;
    // Planned = an open viewing follow-up in the window with no open booking at all.
    const planned = await q(`SELECT count(*)::int AS n FROM leads l WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.follow_up_status = 'open' AND l.follow_up_kind = 'viewing'
      AND l.stage NOT IN ('won', 'lost') AND l.next_follow_up_at >= $${n + 1} AND l.next_follow_up_at < $${n + 2}
      AND NOT EXISTS (SELECT 1 FROM viewings o WHERE o.agency_id = l.agency_id AND o.lead_id = l.id AND o.status = ANY($${n + 3}))/*scope*/`, [...win, OPEN]);
    return { want: booked + planned, split: { booked, confirmed, planned }, calendar };
  }
  if (kind === "approaching_sla") {
    const rules = await require("../services/leadRules").getRules(pool, actor.agency_id);
    const ago = (m) => new Date(now.getTime() - m * 60000).toISOString();
    if (rules.enabled) return q(`SELECT count(*)::int AS n FROM leads l WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.stage = 'new' AND l.last_contact_at IS NULL
      AND l.response_due_at > $${n + 1} AND l.response_due_at <= $${n + 2}/*scope*/`, [now.toISOString(), new Date(now.getTime() + 1800000).toISOString()]);
    return q(`SELECT count(*)::int AS n FROM leads l WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.assigned_broker_id IS NOT NULL AND l.stage = 'new' AND l.last_contact_at IS NULL
      AND l.created_at > $${n + 1} AND l.created_at <= $${n + 2}/*scope*/`, [ago(60), ago(40)]);
  }
  if (kind === "opened_no_followup") {
    return q(`SELECT count(DISTINCT l.id)::int AS n FROM leads l JOIN share_links s ON s.lead_id = l.id AND s.agency_id = l.agency_id
      JOIN listings u ON u.id = s.listing_id AND u.agency_id = s.agency_id
      WHERE ${Vis.leads("l")} AND ${Vis.units("u")} AND l.agency_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND s.open_count > 0
        AND l.stage NOT IN ('won', 'lost') AND l.follow_up_status IS DISTINCT FROM 'open'/*scope*/`);
  }
  return undefined;
}

/** Clients with an open saved request of this type + place, in what the actor may see (own leads unless managers or the agency switch is on). */
async function independentClientMatches(pool, actor, { types, place, bedsMin = 0, bedsMax = 1e9, priceMin = 0, priceMax = 1e12 }) {
  const manager = ["owner", "manager", "admin"].includes(actor.role);
  const sw = (await pool.query("SELECT crm_settings->>'brokers_see_all_leads' AS v FROM agencies WHERE id = $1", [actor.agency_id])).rows[0]?.v;
  const args = [actor.agency_id, types[0], JSON.stringify([{ kind: "area", key: place }]), bedsMin, bedsMax, priceMin, priceMax];
  let scope = "";
  if (!manager && sw === "false") { args.push(actor.id); scope = " AND l.assigned_broker_id = $8"; }
  const Vis = require("../lib/visibility");
  const { rows } = await pool.query(`SELECT count(DISTINCT l.id)::int AS n FROM saved_searches s JOIN leads l ON l.id = s.lead_id AND l.agency_id = s.agency_id
    WHERE ${Vis.leads("l")} AND s.agency_id = $1 AND s.fulfilled_at IS NULL AND l.stage NOT IN ('won', 'lost')
      AND s.filters->'property_types' ? $2 AND s.filters->'places' @> $3::jsonb
      AND COALESCE((s.filters->>'bedrooms_max')::numeric, 1e9) >= $4::numeric AND COALESCE((s.filters->>'bedrooms_min')::numeric, 0) <= $5::numeric
      AND COALESCE((s.filters->>'price_max')::numeric, 1e12) >= $6::numeric AND COALESCE((s.filters->>'price_min')::numeric, 0) <= $7::numeric${scope}`, args);
  return rows[0].n;
}

/**
 * Runs the fixture and returns { results: [{ ok, role, intent, q, reason }], failed }.
 * actors: { owner, manager, broker1 } broker rows. AI: the lib/ai module (or a fake).
 */
async function run({ pool, actors, fixture, AI, only = null }) {
  const Router = require("../domain/assistantRouter");
  const AssistantQuery = require("../services/assistantQuery");
  const Leads = require("../services/leads");
  const SearchLink = require("../domain/searchLink");
  const results = [];
  const add = (ok, role, intent, q, reason = "") => results.push({ ok, role, intent, q, reason });

  const ask = (actor, q) => AssistantQuery.query(pool, { AI, actor, agency: null, text: q, mode: "auto" });
  const jobs = [];
  for (const i of fixture.intents || []) if (!only || i.id === only) for (const q of i.questions) jobs.push({ kind: "intent", id: i.id, expect: i.expect || {}, brokerExpect: i.brokerExpect, eval: i.eval, q });
  for (const u of fixture.unitSearches || []) if (!only || only === "unitSearches") jobs.push({ kind: "unit", id: "unit_search", expect: u.expect || {}, q: u.q });
  for (const q of fixture.offTopic || []) if (!only || only === "offTopic") jobs.push({ kind: "off", id: "off_topic", expect: {}, q });

  for (const job of jobs) {
    const { q, expect } = job;
    let r = null;
    if (job.kind === "intent") {
      r = Router.classifyAssistantQuery({ text: q, mode: "auto" });
      const bad = [];
      if (expect.route && r.route !== expect.route) bad.push(`route ${r.route} != ${expect.route}`);
      if (expect.queueHint && r.queueHint !== expect.queueHint) bad.push(`queue ${r.queueHint || "-"} != ${expect.queueHint}`);
      if (expect.clarifyKind && r.clarifyKind !== expect.clarifyKind) bad.push(`clarify ${r.clarifyKind || "-"} != ${expect.clarifyKind}`);
      if (expect.windowKey && r.windowInfo?.key !== expect.windowKey) bad.push(`window ${r.windowInfo?.key || "-"} != ${expect.windowKey}`);
      if (bad.length) add(false, "router", r.route, q, bad.join("; "));
    }
    for (const role of ROLES) {
      const actor = actors[role];
      if (!actor) continue;
      let a;
      let b;
      try {
        a = await ask(actor, q);
        b = await ask(actor, q);
      } catch (err) {
        add(false, role, "error", q, `threw: ${String(err.message || err).slice(0, 80)}`);
        continue;
      }
      const intent = a?.intent || (a?.error ? `error:${a.error}` : "?");
      const bad = [];
      if (a?.error) bad.push(`error ${a.error}`);
      if (stable(a) !== stable(b)) bad.push("answer differs on second ask");
      if (job.kind === "intent") {
        const crm = String(expect.route || "").startsWith("crm_");
        if (crm && intent === "unit_search") bad.push("CRM question became a unit search");
        else if (intent === "clarify" && expect.route !== "clarify" && !a.notForRole) bad.push("got clarify");
        if (expect.route === "crm_leads" && intent !== "crm_leads") bad.push(`intent ${intent}`);
        if (expect.clarifyKind) {
          if (a?.clarifyKind !== expect.clarifyKind) bad.push(`clarifyKind ${a?.clarifyKind} != ${expect.clarifyKind}`);
          if (a?.suggestions?.length !== 2 || !/^وحدات: /.test(a.suggestions[0]?.q || "") || !/^عملاء: /.test(a.suggestions[1]?.q || "")) bad.push("clarify chips are not the two prefixed choices");
        }
        if (expect.route === "crm_client_matches") {
          const cm = a?.cards?.find((c) => c.kind === "client_matches");
          if (intent !== "crm_client_matches" || !cm) bad.push(`intent ${intent}, no client_matches card`);
          else {
            if (/2010000d{5}/.test(JSON.stringify(a))) bad.push("a phone number is in the answer");
            if (job.eval?.clientMatches) {
              const want = await independentClientMatches(pool, actor, job.eval.clientMatches);
              if (Number(cm.total) !== want) bad.push(`count ${cm.total} != independent SQL ${want} (client_matches)`);
            }
            // The seeded request that fits nothing must say 0 matching units; the ones that fit must say 1 or more.
            for (const it of cm.items) {
              if (it.name === "QA Wants cheap NC" && it.matchCount !== 0) bad.push(`matchCount ${it.matchCount} != 0 for the request that fits nothing`);
              if (it.name === "QA Wants apartment NC" && !(it.matchCount >= 1)) bad.push("matchCount 0 for a request that fits seeded units");
            }
          }
        }
        if (a?.notForRole) {
          if (role === "owner" || role === "manager") bad.push("owner/manager got a role decline");
          else if (!a.headline || !a.suggestions?.length) bad.push("role decline without text or suggestions");
        } else if (job.brokerExpect === "not_for_role" && role === "broker1") bad.push("broker1 should get a role answer");
        const card = a?.cards?.find((c) => c.kind === "stuck_leads");
        if (card) {
          const kindOf = { crm_viewings: "viewings", crm_approaching_sla: "approaching_sla", crm_opened_no_followup: "opened_no_followup" }[intent];
          if (kindOf) {
            const want = await independentCount(pool, actor, kindOf, r.windowInfo, new Date());
            const exact = want?.want ?? want;
            if (exact != null && Number(card.total) !== exact) bad.push(`count ${card.total} != independent SQL ${exact} (${kindOf})`);
            if (want?.split) {
              if (stable(card.split) !== stable(want.split)) bad.push(`split ${JSON.stringify(card.split)} != independent SQL ${JSON.stringify(want.split)}`);
              if (want.calendar !== card.split?.booked) bad.push(`booked ${card.split?.booked} != Calendar lists ${want.calendar}`);
            }
          } else {
            const list = await Leads.listLeads(pool, actor, { queue: card.queue, limit: 1, offset: 0 });
            if (Number(list.total) !== Number(card.total)) bad.push(`count ${card.total} != app list ${list.total} (${card.queue})`);
          }
        }
      } else if (job.kind === "unit") {
        if (intent !== "unit_search" && intent !== "inventory_count") bad.push(`intent ${intent}`);
        const f = a?.units?.f ? SearchLink.decodeFilters(a.units.f) : null;
        for (const [k, v] of Object.entries(expect)) if (!f || f[k] !== v) bad.push(`${k} ${f ? f[k] : "-"} != ${v}`);
      } else if (intent !== "clarify") {
        bad.push(`off-topic answered as ${intent}`);
      }
      add(!bad.length, role, intent, q, bad.join("; "));
    }
  }
  return { results, total: results.length, failed: results.filter((r) => !r.ok).length };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  if (!args.includes("--ai")) process.env.GEMINI_API_KEY = ""; // before anything is required: no AI call can be made
  if (!/(localhost|127\.0\.0\.1)/.test(process.env.DATABASE_URL || "")) throw new Error("Refusing to run: DATABASE_URL is not localhost.");
  const { createPool } = require("../lib/db");
  const { agencyOf } = require("./seed-ask");
  const fixture = require(path.resolve(opt("--fixture", path.join(__dirname, "..", "tests", "fixtures", "assistant-questions.json"))));
  const pool = createPool();
  try {
    const agencyId = await agencyOf(pool, args);
    const one = async (sql, p = []) => (await pool.query(`SELECT * FROM brokers WHERE agency_id = $1 AND is_active AND ${sql} ORDER BY created_at, id LIMIT 1`, [agencyId, ...p])).rows[0];
    const actors = { owner: await one("role = 'owner'"), manager: await one("role IN ('manager', 'admin')"), broker1: await one("phone_normalized = '201100000003'") };
    const { results, total, failed } = await run({ pool, actors, fixture, AI: require("../lib/ai"), only: opt("--only") });
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.role.padEnd(7)} ${String(r.intent).padEnd(18)} ${short(r.q)}${r.reason ? `  | ${r.reason}` : ""}`);
    console.log(`${total - failed}/${total} passed, ${failed} failed${actors.owner && actors.manager && actors.broker1 ? "" : " (a role is missing: run seed-ask.js seed)"}`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

module.exports = { run };
