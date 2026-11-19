// services/leadIntake.js — Per-agency lead intake (next picks L1, L7, L8), direct from Facebook Lead Ads. The app owner
// pastes a Page access token for an agency's Page; the app checks it with Graph and subscribes the Page to the app's
// leadgen webhook (POST /webhook/leadgen in server.js). Each new lead is fetched from Graph with the Page token and goes
// through services/leads.js captureLead (dedupe by phone, erasures, the response rule), gets the intake's source and the
// next broker in the round robin; the broker hears on Telegram/the website, managers get the new-lead alert. A repeat
// (same Meta lead id) is taken once. Every lead is logged without the phone (last 4 digits only). The Page token is never
// logged or shown (only its last 4 characters); it is kept encrypted (lib/secretBox.js) and decrypted only inside graph().
// Every Graph call carries appsecret_proof. A Graph error that means "this token is dead" (code 190, or permission codes
// 10/200/283) marks the intake 'disconnected' once and alerts the owner and the agency's managers once; a disconnected
// intake makes no Graph call until the owner updates the token. A temporary error (5xx, network, rate limit) is retried
// once and never disconnects. An intake with no lead for its quiet days alerts the owner and managers once.
"use strict";

const crypto = require("crypto");
const SecretBox = require("../lib/secretBox");
const { getConfig } = require("../config");
const Leads = require("./leads");
const LeadRules = require("./leadRules");
const LeadRequests = require("./leadRequests");
const Notifications = require("../lib/notifications");
const ErrorReports = require("../lib/errorReports");
const RateLimit = require("../lib/rateLimit");
const LeadImport = require("../domain/leadImport");
const Stages = require("../domain/leadStages");
const Card = require("../domain/leadCard");
const Vis = require("../lib/visibility");

const PER_HOUR = { limit: 300, windowSec: 3600 };
const LOG_KEEP = 50;
const L = (b, ar, en) => (b?.preferred_lang === "en" ? en : ar);

const clean = (v, max) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || "v25.0"}`;
// Looked up at call time so tests can replace global fetch.
const defaultFetch = (...a) => globalThis.fetch(...a);
// Every intake column except the Page token (which is never read back into a page or a log).
const PUBLIC = "id, agency_id, name, source, token_hint, quiet_days, last_lead_at, quiet_alerted_at, created_at, revoked_at, page_id, page_name, subscribed_at, status, disconnect_reason, disconnected_at, last_error_at, last_error_code";
const RETRY_MS = 400;
const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * One Graph call → { ok, status, json, err } (never throws). `stored` is the Page token as kept in the database (encrypted or a
 * legacy plain value): it is decrypted here and nowhere else. The token goes in the query with its appsecret_proof and is never
 * logged. err = { code, subcode } from Graph's { error } body.
 */
async function graph(fetchFn, method, path, stored, params = {}) {
  let token;
  try {
    token = SecretBox.decrypt(stored);
  } catch {
    return { ok: false, status: 0, json: {}, err: { code: "decrypt", subcode: null } };
  }
  const qs = new URLSearchParams({ ...params, access_token: token });
  const secret = getConfig().whatsapp.appSecret;
  if (secret) qs.set("appsecret_proof", crypto.createHmac("sha256", secret).update(token).digest("hex"));
  try {
    const res = await fetchFn(`${GRAPH}/${path}?${qs}`, { method });
    const json = (await res.json().catch(() => ({}))) || {};
    const e = json.error;
    return { ok: Boolean(res.ok) && !e, status: res.status, json, err: e ? { code: e.code ?? null, subcode: e.error_subcode ?? null } : null };
  } catch {
    return { ok: false, status: 0, json: {}, err: null };
  }
}
const graphDetail = (r) => `graph ${r.status}${r.err?.code ? ` #${r.err.code}${r.err.subcode ? `/${r.err.subcode}` : ""}` : ""}`;

/** Why a failed Graph call matters: { kind: 'disconnect', reason } (token dead), { kind: 'transient' } or { kind: 'other' }. */
function classify(r) {
  const code = Number(r.err?.code);
  const sub = Number(r.err?.subcode);
  if (code === 190) return { kind: "disconnect", reason: sub === 460 ? "password_changed" : sub === 492 ? "removed" : sub === 459 ? "checkpoint" : "token_invalid" };
  if ([10, 200, 283].includes(code)) return { kind: "disconnect", reason: "permission" };
  if (r.err?.code === "decrypt") return { kind: "other" };
  if (!r.status || r.status >= 500 || [4, 17, 32, 613].includes(code)) return { kind: "transient" };
  return { kind: "other" };
}

/** What each reason means for the agency's managers (ar, en) and the one thing to do. */
const REASONS = {
  password_changed: ["صاحب الصفحة غيّر باسورد فيسبوك.", "The Page owner changed their Facebook password."],
  removed: ["الشخص اللي رابط الصفحة اتشال من الصفحة أو فقد صلاحيته عليها.", "The person who connected the Page was removed from it or lost access."],
  checkpoint: ["فيسبوك عايز الشخص اللي رابط الصفحة يأكد هويته.", "Facebook needs the person who connected the Page to confirm their identity."],
  token_invalid: ["ربط الصفحة بفيسبوك بقى مش شغال (التوكن خلص أو اتلغى).", "The Page connection to Facebook stopped working (the token expired or was cancelled)."],
  permission: ["صلاحية العملاء على الصفحة ناقصة.", "The Page's leads permission is missing."]
};
const reasonOf = (reason, i) => REASONS[reason]?.[i] || REASONS.token_invalid[i];

/** Remember a Graph failure (code only) for the owner's tab. */
async function noteError(pool, intakeId, r, now) {
  const code = r.err?.code ? `${r.err.code}${r.err.subcode ? `/${r.err.subcode}` : ""}` : r.status ? `http ${r.status}` : "network";
  await pool.query("UPDATE lead_intakes SET last_error_at = $2, last_error_code = $3 WHERE id = $1", [intakeId, now.toISOString(), code]);
}

/**
 * Active → disconnected, once: only the call that makes the change alerts (the owner on Telegram, the agency's managers in the app).
 * Returns true when this call changed the status.
 */
async function disconnect(pool, intake, reason, r, now = new Date()) {
  await noteError(pool, intake.id, r, now);
  const { rows } = await pool.query(
    `UPDATE lead_intakes SET status = 'disconnected', disconnect_reason = $2, disconnected_at = $3 WHERE id = $1 AND status = 'active' RETURNING id`,
    [intake.id, reason, now.toISOString()]
  );
  if (!rows[0]) return false;
  const agency = (await pool.query("SELECT name FROM agencies WHERE id = $1", [intake.agency_id])).rows[0];
  ErrorReports.alertOwner(
    [
      `🔌 Facebook intake disconnected: ${agency?.name || intake.agency_id} · ${intake.name}`,
      `Page: ${intake.page_name || intake.page_id || "?"}. Reason: ${reason} (Graph ${r.err?.code ?? r.status}${r.err?.subcode ? `/${r.err.subcode}` : ""}) — ${reasonOf(reason, 1)}`,
      "Leads from this Page are NOT coming in. Get a new Page token from the agency, then press Update token on /app/owner (Facebook leads tab)."
    ].join("\n"),
    { category: "lead_intake", pool }
  ).catch(() => {});
  try {
    for (const m of await Notifications.managersOf(pool, intake.agency_id)) {
      await Notifications.notifyBroker(pool, m, {
        kind: "manager_alert",
        dedupeKey: `intake_disconnected:${intake.id}:${now.toISOString()}`,
        title: L(m, `⚠️ ربط «${intake.name}» مع فيسبوك وقف`, `⚠️ The "${intake.name}" Facebook connection stopped`),
        body: L(m, `${reasonOf(reason, 0)} العملاء الجداد من الصفحة مش هيوصلوا. ابعت لدعم WehdatHub توصّل الصفحة تاني.`, `${reasonOf(reason, 1)} New leads from the Page will not arrive. Ask WehdatHub support to reconnect the Page.`),
        url: "/app/sources",
        now
      });
    }
  } catch (e) {
    console.warn("Intake disconnect notice failed:", e.message);
  }
  return true;
}

/**
 * Owner: a new intake for an agency's Facebook Page → { intake, agency } or { error }.
 * The Page token is checked with Graph, then the Page is subscribed to this app's leadgen webhook.
 */
async function create(pool, agencyId, { name, source, quietDays = 3, pageId, pageToken } = {}, { fetch = defaultFetch, config = getConfig() } = {}) {
  const n = clean(name, 60);
  const s = clean(source, 60);
  const page = String(pageId ?? "").trim();
  const tok = String(pageToken ?? "").trim();
  const q = Number(quietDays);
  if (!n || !s || !/^\d{5,30}$/.test(page) || tok.length < 20 || /\s/.test(tok)) return { error: "fields" };
  if (!Number.isInteger(q) || q < 1 || q > 60) return { error: "quiet_days" };
  if (!SecretBox.hasKey(config)) return { error: "encryption_key" };
  const agency = (await pool.query("SELECT id, name FROM agencies WHERE id = $1", [agencyId])).rows[0];
  if (!agency) return { error: "not_found" };
  if ((await pool.query("SELECT 1 FROM lead_intakes WHERE page_id = $1 AND revoked_at IS NULL", [page])).rows.length) return { error: "duplicate" };
  const info = await graph(fetch, "GET", page, tok, { fields: "name" });
  if (!info.ok) return { error: "page_token" };
  const sub = await graph(fetch, "POST", `${page}/subscribed_apps`, tok, { subscribed_fields: "leadgen" });
  if (!sub.ok || sub.json.success === false) return { error: "subscribe" };
  const { rows } = await pool.query(
    `INSERT INTO lead_intakes (agency_id, name, source, page_id, page_name, page_token, token_hint, subscribed_at, quiet_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8) RETURNING ${PUBLIC}`,
    [agencyId, n, s, page, clean(info.json.name, 120), SecretBox.encrypt(tok, { config }), tok.slice(-4), q]
  );
  return { intake: rows[0], agency };
}

/** Owner: stops an intake: forgets its Page token, best-effort unsubscribes the Page; leads for it are ignored from now on. */
async function revoke(pool, intakeId, { now = new Date(), fetch = defaultFetch } = {}) {
  const old = (await pool.query("SELECT page_id, page_token FROM lead_intakes WHERE id = $1 AND revoked_at IS NULL", [intakeId])).rows[0];
  const { rows } = await pool.query(
    `UPDATE lead_intakes SET revoked_at = $2, page_token = NULL WHERE id = $1 AND revoked_at IS NULL RETURNING ${PUBLIC}`,
    [intakeId, now.toISOString()]
  );
  if (!rows[0]) return { error: "not_found" };
  if (old?.page_id && old.page_token) await graph(fetch, "DELETE", `${old.page_id}/subscribed_apps`, old.page_token);
  return { intake: rows[0] };
}

/**
 * Owner: the reconnect path. A new Page token replaces the old one: checked with Graph, the Page subscribed again, the
 * intake active again. → { intake } or { error } (fields, not_found, page_token, subscribe, encryption_key).
 */
async function updateToken(pool, intakeId, pageToken, { fetch = defaultFetch, now = new Date(), config = getConfig() } = {}) {
  const tok = String(pageToken ?? "").trim();
  if (tok.length < 20 || /\s/.test(tok)) return { error: "fields" };
  if (!SecretBox.hasKey(config)) return { error: "encryption_key" };
  const old = (await pool.query("SELECT id, page_id FROM lead_intakes WHERE id = $1 AND revoked_at IS NULL AND page_id IS NOT NULL", [intakeId])).rows[0];
  if (!old) return { error: "not_found" };
  const info = await graph(fetch, "GET", old.page_id, tok, { fields: "name" });
  if (!info.ok) return { error: "page_token" };
  const sub = await graph(fetch, "POST", `${old.page_id}/subscribed_apps`, tok, { subscribed_fields: "leadgen" });
  if (!sub.ok || sub.json.success === false) return { error: "subscribe" };
  const { rows } = await pool.query(
    `UPDATE lead_intakes SET page_token = $2, token_hint = $3, page_name = COALESCE($4, page_name), subscribed_at = $5, status = 'active',
            disconnect_reason = NULL, disconnected_at = NULL, last_error_at = NULL, last_error_code = NULL
      WHERE id = $1 AND revoked_at IS NULL RETURNING ${PUBLIC}`,
    [intakeId, SecretBox.encrypt(tok, { config }), tok.slice(-4), clean(info.json.name, 120), now.toISOString()]
  );
  return rows[0] ? { intake: rows[0] } : { error: "not_found" };
}

/**
 * Body → cells for domain/leadImport.js rowToLead, plus the extra answers for the notes and the sender's lead id.
 * Accepts flat fields ({ full_name, phone_number, platform, campaign_name, … }) and Meta's field_data
 * ([{ name, values: [...] }]) as Graph returns a lead (GET /{leadgen_id}).
 */
function readBody(body = {}) {
  const flat = {};
  const add = (k, v) => {
    if (v === null || v === undefined || typeof v === "object") return;
    if (!(k in flat)) flat[k] = v;
  };
  for (const [k, v] of Object.entries(body || {})) {
    if (k === "field_data" && Array.isArray(v)) {
      for (const f of v) if (f && f.name) add(String(f.name), Array.isArray(f.values) ? f.values.join(", ") : f.value);
    } else add(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const externalId = clean(flat.leadgen_id ?? flat.lead_id ?? flat.id, 100);
  const cells = {};
  const extra = [];
  for (const [k, v] of Object.entries(flat)) {
    if (/^(id|leadgen_id|lead_id|created_time|test|ad_id|adset_id|campaign_id|form_id|page_id|is_organic)$/i.test(k)) continue;
    const col = LeadImport.columnFor(k.replace(/_/g, " "));
    if (col && !(col in cells)) cells[col] = v;
    else if (clean(v, 300) && extra.length < 15) extra.push(`${clean(k.replace(/_/g, " "), 60)}: ${clean(v, 300)}`);
  }
  return { cells, extra, externalId };
}

async function logRow(pool, intake, row) {
  await pool.query(
    `INSERT INTO lead_intake_log (intake_id, agency_id, outcome, external_id, lead_id, phone_tail, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [intake.id, intake.agency_id, row.outcome, row.externalId || null, row.leadId || null, row.phoneTail || null, row.detail ? String(row.detail).slice(0, 200) : null]
  );
  // Keep the newest rows per intake only.
  await pool.query(
    `DELETE FROM lead_intake_log WHERE intake_id = $1 AND id < (SELECT id FROM lead_intake_log WHERE intake_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)`,
    [intake.id, LOG_KEEP * 10]
  );
}

/** The broker who already has a lead hears that the client asked again through this source. */
async function tellRepeat(pool, lead, intake, now) {
  if (!lead.assigned_broker_id) return;
  const b = (await pool.query(`SELECT * FROM brokers WHERE id = $1 AND agency_id = $2 AND is_active`, [lead.assigned_broker_id, lead.agency_id])).rows[0];
  if (!b) return;
  await Notifications.notifyBroker(pool, b, {
    kind: "assignment",
    dedupeKey: `intake_repeat:${lead.id}:${now.toISOString().slice(0, 10)}`,
    title: L(b, `🔁 ${Card.displayName(lead, "ar")} (${Card.refLabel(lead.ref)}) سأل تاني من ${intake.source}`, `🔁 ${Card.displayName(lead, "en")} (${Card.refLabel(lead.ref)}) asked again via ${intake.source}`),
    body: L(b, "كلّمه وهو لسه مهتم.", "Call while they're still interested."),
    url: `/app/leads/${Card.refLabel(lead.ref)}`,
    leadId: lead.id,
    now
  });
}

/** A sample Meta lead (the field names Meta uses), for tests and docs. */
const SAMPLE = {
  platform: "fb",
  campaign_name: "WehdatHub test",
  field_data: [{ name: "full_name", values: ["Test lead"] }, { name: "phone_number", values: ["p:+201000000000"] }]
};

/**
 * One leadgen change from Meta's webhook: { leadgen_id, page_id, form_id, ad_id, created_time } (or the change holding it
 * as .value). A Page with no active intake is ignored (nothing logged). Never throws: a Graph failure is logged as 'error'.
 */
async function handleLeadgen(pool, change, { fetch = defaultFetch, now = new Date(), retryMs = RETRY_MS } = {}) {
  const v = change?.value || change || {};
  const leadgenId = clean(v.leadgen_id, 100);
  const pageId = clean(v.page_id, 40);
  if (!leadgenId || !pageId) return { ignored: true };
  try {
    const intake = (await pool.query("SELECT * FROM lead_intakes WHERE page_id = $1 AND revoked_at IS NULL AND page_token IS NOT NULL", [pageId])).rows[0];
    if (!intake) return { ignored: true };
    if (intake.status === "disconnected") {
      await logRow(pool, intake, { outcome: "error", externalId: leadgenId, detail: `disconnected: ${intake.disconnect_reason || "token"}` });
      return { status: 200, json: { ok: false, outcome: "error" } };
    }
    let r = await graph(fetch, "GET", leadgenId, intake.page_token);
    let kind = r.ok ? null : classify(r);
    if (kind?.kind === "transient") {
      await wait(retryMs);
      r = await graph(fetch, "GET", leadgenId, intake.page_token);
      kind = r.ok ? null : classify(r);
    }
    if (!r.ok) {
      if (kind.kind === "disconnect") await disconnect(pool, intake, kind.reason, r, now);
      else await noteError(pool, intake.id, r, now);
      await logRow(pool, intake, { outcome: "error", externalId: leadgenId, detail: graphDetail(r) });
      return { status: 200, json: { ok: false, outcome: "error" } };
    }
    const body = { ...r.json, leadgen_id: leadgenId };
    if (v.platform && !body.platform) body.platform = v.platform;
    return await receiveFor(pool, intake, body, { now });
  } catch (err) {
    console.error("Leadgen handling failed:", err.code || err.message);
    return { status: 500, json: { ok: false, error: "temporary" } };
  }
}

/** Owner: the test button. Checks the Page token and the leadgen subscription with Graph; saves nothing. */
async function testIntake(pool, intakeId, { fetch = defaultFetch } = {}) {
  const intake = (await pool.query("SELECT id, agency_id, name, page_id, page_name, page_token, status FROM lead_intakes WHERE id = $1 AND revoked_at IS NULL", [intakeId])).rows[0];
  if (!intake) return { ok: false, error: "not_found" };
  if (!intake.page_id || !intake.page_token) return { ok: false, error: "no_page" };
  const failed = async (r) => {
    const k = classify(r);
    if (k.kind === "disconnect") await disconnect(pool, intake, k.reason, r, new Date());
    return { ok: false, error: "page_token" };
  };
  const info = await graph(fetch, "GET", intake.page_id, intake.page_token, { fields: "name" });
  if (!info.ok) return failed(info);
  const subs = await graph(fetch, "GET", `${intake.page_id}/subscribed_apps`, intake.page_token);
  if (!subs.ok) return failed(subs);
  const on = (Array.isArray(subs.json.data) ? subs.json.data : []).some((a) => (a.subscribed_fields || []).includes("leadgen"));
  if (!on) return { ok: false, error: "not_subscribed", name: info.json.name || null };
  // A working token on a disconnected intake: it is connected again.
  if (intake.status === "disconnected") {
    await pool.query("UPDATE lead_intakes SET status = 'active', disconnect_reason = NULL, disconnected_at = NULL, last_error_at = NULL, last_error_code = NULL WHERE id = $1", [intake.id]);
  }
  return { ok: true, name: info.json.name || null };
}

async function receiveFor(pool, intake, body, { now = new Date(), test = false } = {}) {
  const gate = await RateLimit.hit(pool, `intake:${intake.id}`, PER_HOUR);
  if (!gate.allowed) return { status: 429, json: { ok: false, error: "rate_limited" } };

  const isTest = test || body?.test === true || body?.test === "true";
  const { cells, extra, externalId } = readBody(body);
  const lead = LeadImport.rowToLead(cells);
  const phoneTail = lead.phones[0] ? lead.phones[0].slice(-4) : null;
  if (lead.errors.length) {
    await logRow(pool, intake, { outcome: "invalid", externalId, phoneTail, detail: lead.errors.join(", ") });
    return { status: 200, json: { ok: false, outcome: "invalid", error: lead.errors[0] } };
  }
  if (isTest) {
    await logRow(pool, intake, { outcome: "test", phoneTail, detail: [lead.name ? "name" : null, lead.source || intake.source].filter(Boolean).join(", ") });
    return { status: 200, json: { ok: true, outcome: "test", source: lead.source || intake.source } };
  }
  if (externalId) {
    const seen = await pool.query(
      "SELECT lead_id FROM lead_intake_log WHERE intake_id = $1 AND external_id = $2 AND outcome IN ('created', 'merged', 'colleague') LIMIT 1",
      [intake.id, externalId]
    );
    if (seen.rows.length) {
      await logRow(pool, intake, { outcome: "repeat", leadId: seen.rows[0].lead_id, phoneTail });
      return { status: 200, json: { ok: true, outcome: "repeat" } };
    }
  }

  try {
    // The intake acts as a manager of its agency (so it can assign); nobody is "the one who added it".
    const actor = { id: null, agency_id: intake.agency_id, role: "admin", name: intake.name, preferred_lang: "ar" };
    const next = await LeadRules.nextBroker(pool, intake.agency_id, { now });
    const notes = [lead.notes, ...extra].filter(Boolean).join("\n");
    const res = await Leads.captureLead(
      pool,
      actor,
      { phones: lead.phones, name: lead.name, kind: lead.kind || undefined, source: lead.source || intake.source, notes, lawfulBasis: "client_request", assignTo: next?.id || null },
      { now }
    );
    const outcome = ["created", "merged", "colleague", "erased_before"].includes(res.outcome) ? res.outcome : "invalid";
    await logRow(pool, intake, { outcome, externalId, leadId: res.lead?.id || null, phoneTail, detail: res.error || null });
    if (outcome === "created" || outcome === "merged") {
      await pool.query("UPDATE lead_intakes SET last_lead_at = $2 WHERE id = $1", [intake.id, now.toISOString()]);
      // The rotation moves on only when this lead really went to the picked broker (not on a repeat or a colleague's lead).
      if (outcome === "created" && res.lead?.assigned_broker_id && res.lead.assigned_broker_id === next?.id) await LeadRules.advanceRotation(pool, intake.agency_id, next.id);
      if (outcome === "created" && lead.request) await LeadRequests.saveRequest(pool, actor, res.lead.id, lead.request, { now }).catch(() => {});
      if (outcome === "merged") await tellRepeat(pool, res.lead, intake, now).catch((e) => console.warn("Intake repeat notice failed:", e.message));
    }
    return { status: 200, json: { ok: outcome !== "invalid", outcome, ref: res.lead?.ref ? Card.refLabel(res.lead.ref) : undefined } };
  } catch (err) {
    console.error("Lead intake failed:", err.code || err.message);
    await logRow(pool, intake, { outcome: "error", externalId, phoneTail, detail: err.code || "error" }).catch(() => {});
    return { status: 500, json: { ok: false, error: "temporary" } };
  }
}

/** Owner and managers: an agency's intakes with their last 30 days' counts. */
async function listForAgency(pool, agencyId) {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC.split(", ").map((c) => "i." + c).join(", ")}, (SELECT count(*)::int FROM lead_intake_log g WHERE g.intake_id = i.id AND g.outcome = 'created' AND g.received_at > now() - interval '30 days') AS created_30,
            (SELECT count(*)::int FROM lead_intake_log g WHERE g.intake_id = i.id AND g.outcome IN ('invalid', 'error') AND g.received_at > now() - interval '30 days') AS failed_30
       FROM lead_intakes i WHERE i.agency_id = $1 ORDER BY i.revoked_at NULLS FIRST, i.created_at`,
    [agencyId]
  );
  return rows;
}

/**
 * Owner: the Facebook leads tab. One grouped query over the last 30 days of lead_intake_log (indexed by intake and time)
 * plus the intakes; the newest log rows come from one more query. No phone numbers, no tokens.
 * → { agencies, rows, summary, log }
 */
async function tracking(pool, { now = new Date(), logLimit = 20 } = {}) {
  const at = now.toISOString();
  const cols = PUBLIC.split(", ").map((c) => "i." + c).join(", ");
  const [agencies, rows, log] = await Promise.all([
    pool.query("SELECT id, name FROM agencies ORDER BY name").then((r) => r.rows),
    pool.query(
      `SELECT ${cols}, a.name AS agency_name,
              COALESCE(g.leads_24h, 0) AS leads_24h, COALESCE(g.leads_7d, 0) AS leads_7d, COALESCE(g.leads_30d, 0) AS leads_30d,
              COALESCE(g.failed_30d, 0) AS failed_30d, COALESCE(g.repeats_30d, 0) AS repeats_30d, COALESCE(g.rows_30d, 0) AS rows_30d
         FROM lead_intakes i JOIN agencies a ON a.id = i.agency_id
         LEFT JOIN (
           SELECT intake_id,
                  count(*) FILTER (WHERE outcome IN ('created', 'merged') AND received_at > $1::timestamptz - interval '1 day')::int AS leads_24h,
                  count(*) FILTER (WHERE outcome IN ('created', 'merged') AND received_at > $1::timestamptz - interval '7 days')::int AS leads_7d,
                  count(*) FILTER (WHERE outcome IN ('created', 'merged'))::int AS leads_30d,
                  count(*) FILTER (WHERE outcome IN ('invalid', 'error'))::int AS failed_30d,
                  count(*) FILTER (WHERE outcome = 'repeat')::int AS repeats_30d,
                  count(*) FILTER (WHERE outcome <> 'test')::int AS rows_30d
             FROM lead_intake_log WHERE received_at > $1::timestamptz - interval '30 days' GROUP BY intake_id
         ) g ON g.intake_id = i.id
        WHERE i.revoked_at IS NULL
        ORDER BY (i.status = 'disconnected') DESC, a.name, i.created_at LIMIT 200`,
      [at]
    ).then((r) => r.rows),
    pool.query(
      `SELECT g.id, g.received_at, g.outcome, g.phone_tail, g.detail, i.name AS intake_name, a.name AS agency_name
         FROM lead_intake_log g JOIN lead_intakes i ON i.id = g.intake_id JOIN agencies a ON a.id = g.agency_id ORDER BY g.id DESC LIMIT $1`,
      [logLimit]
    ).then((r) => r.rows)
  ]);
  const sum = (k) => rows.reduce((n, r) => n + Number(r[k]), 0);
  const summary = {
    active: rows.filter((r) => r.status === "active").length,
    disconnected: rows.filter((r) => r.status === "disconnected").length,
    leads30: sum("leads_30d"),
    failed30: sum("failed_30d"),
    graphCalls30: sum("rows_30d")
  };
  return { agencies, rows, summary, log };
}

/** The newest log rows of an agency (or of one intake). */
async function log(pool, agencyId, { intakeId = null, limit = LOG_KEEP } = {}) {
  const { rows } = await pool.query(
    `SELECT g.*, i.name AS intake_name, l.ref AS lead_ref FROM lead_intake_log g JOIN lead_intakes i ON i.id = g.intake_id
       LEFT JOIN leads l ON l.id = g.lead_id
      WHERE ${Vis.leads("l")} AND g.agency_id = $1 ${intakeId ? "AND g.intake_id = $3" : ""} ORDER BY g.id DESC LIMIT $2`,
    intakeId ? [agencyId, limit, intakeId] : [agencyId, limit]
  );
  return rows;
}

/** L8: the sources an agency's leads use: the common ones, then its intakes' and its own (most used first). */
async function sourcesFor(pool, agencyId) {
  const known = Stages.SOURCES.map(([en]) => en);
  const { rows } = await pool.query(
    `SELECT source FROM (
       SELECT source, 1000000 AS n FROM lead_intakes WHERE agency_id = $1 AND revoked_at IS NULL
       UNION ALL SELECT source, count(*) AS n FROM leads WHERE ${Vis.leads("leads")} AND agency_id = $1 AND source IS NOT NULL AND source <> '' GROUP BY source
     ) s GROUP BY source ORDER BY max(n) DESC, source LIMIT 40`,
    [agencyId]
  );
  return rows.map((r) => r.source).filter((s) => !known.includes(s)).slice(0, 20);
}

/** Scheduler step: an intake with no lead for its quiet days alerts once (until a lead arrives again). */
async function quietCheck(pool, { now = new Date() } = {}) {
  const { rows } = await pool.query(
    `SELECT i.*, a.name AS agency_name FROM lead_intakes i JOIN agencies a ON a.id = i.agency_id
      WHERE i.revoked_at IS NULL AND i.status = 'active' AND COALESCE(i.last_lead_at, i.created_at) < $1::timestamptz - make_interval(days => i.quiet_days)
        AND (i.quiet_alerted_at IS NULL OR i.quiet_alerted_at < COALESCE(i.last_lead_at, i.created_at))`,
    [now.toISOString()]
  );
  for (const i of rows) {
    await pool.query("UPDATE lead_intakes SET quiet_alerted_at = $2 WHERE id = $1", [i.id, now.toISOString()]);
    const since = i.last_lead_at ? new Date(i.last_lead_at).toISOString().slice(0, 10) : null;
    ErrorReports.alertOwner([`🔕 Lead intake quiet: ${i.agency_name} · ${i.name}`, since ? `No lead since ${since} (${i.quiet_days}+ days).` : `No lead yet, ${i.quiet_days}+ days after it was made.`, "Check the Page token on /app/owner (Test) and the Page's leads access."].join("\n"), { category: "lead_intake", pool }).catch(() => {});
    for (const m of await Notifications.managersOf(pool, i.agency_id)) {
      await Notifications.notifyBroker(pool, m, {
        kind: "manager_alert",
        dedupeKey: `intake_quiet:${i.id}:${now.toISOString().slice(0, 10)}`,
        title: L(m, `🔕 مفيش عملاء من «${i.name}» من ${i.quiet_days} يوم أو أكتر`, `🔕 No leads from "${i.name}" for ${i.quiet_days}+ days`),
        body: L(m, "لو الإعلانات شغالة، كلّم دعم WehdatHub نتأكد من الربط.", "If your ads are running, tell WehdatHub support so we check the connection."),
        url: "/app/sources",
        now
      });
    }
  }
  return { counts: { quiet: rows.length } };
}

const quietJob = () => ({ name: "intake_quiet", everyMs: 60 * 60 * 1000, run: ({ pool, now }) => quietCheck(pool, { now }) });

module.exports = { PER_HOUR, SAMPLE, REASONS, create, revoke, updateToken, readBody, handleLeadgen, testIntake, listForAgency, tracking, log, sourcesFor, quietCheck, quietJob };
