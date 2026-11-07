// tests/heavy/load-30-agencies.test.js — Load test copy (patch 6): 30 agencies, 750 people, 50,000 units in one database. Measures the
// website's lists and search for every agency at once, bot replies, and an import; checks no agency sees another's data; prints a
// report with the real numbers (search the log for "LOAD REPORT").
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const crypto = require("crypto");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(900000);

const AGENCIES = 30;
const PER_AGENCY = 25;
const UNITS = 50000;

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const pct = (list, p) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor((list.length * p) / 100))];
const stats = (list) => ({ n: list.length, p50: pct(list, 50), p95: pct(list, 95), max: Math.max(...list) });

test("30 agencies, 750 people and 50,000 units: everything answers, nothing leaks, numbers are reported", async () => {
  const report = {};
  const ag = Array.from({ length: AGENCIES }, (_, i) => ({ id: crypto.randomUUID(), n: i + 1 }));
  await h.pool.query("SET session_replication_role = replica");
  for (const a of ag) {
    await h.pool.query("INSERT INTO agencies (id, name, slug, phone, pilot) VALUES ($1, $2, $3, $4, true)", [a.id, `LoadAgency${a.n}`, `load-agency-${a.n}`, `02${String(30000000 + a.n)}`]);
    a.owner = crypto.randomUUID();
    await h.pool.query(
      `INSERT INTO brokers (id, agency_id, phone_number, name, role, is_active, preferred_lang, notify_prefs, telegram_user_id, telegram_chat_id)
       SELECT CASE WHEN g = 1 THEN $3::uuid ELSE gen_random_uuid() END, $1::uuid, '010' || lpad(($2::int * 100 + g)::text, 8, '0'), 'Load ' || $2 || '-' || g,
              CASE WHEN g = 1 THEN 'owner' ELSE 'broker' END, true, 'ar', '{"quiet":{"enabled":false}}'::jsonb, $2::int * 1000 + g, $2::int * 1000 + g
         FROM generate_series(1, ${PER_AGENCY}) g`,
      [a.id, a.n, a.owner]
    );
  }
  const t0 = Date.now();
  await h.pool.query(
    `INSERT INTO listings (code, agency_id, broker_id, title, property_type, listing_type, market, price_value, area_value, bedrooms, compound, compound_key, search_text_normalized, status, details, confirmed_at)
     SELECT 'L' || a.n || '-' || g, a.id, b.id, 'unit ' || g, CASE WHEN g % 7 = 0 THEN 'villa' ELSE 'apartment' END, CASE WHEN g % 3 = 0 THEN 'rent' ELSE 'sale' END, 'resale',
            1000000 + g * 90, 100 + g % 200, 1 + g % 5, 'Compound ' || (g % 50), 'compound_' || (g % 50), 'unit ' || g || ' compound ' || (g % 50) || ' load' || a.n,
            'active', '{}'::jsonb, NOW() - (g || ' minutes')::interval
       FROM (SELECT id, substring(name from 11)::int AS n FROM agencies WHERE name LIKE 'LoadAgency%') a
       CROSS JOIN generate_series(1, ${Math.floor(UNITS / AGENCIES)}) g
       JOIN LATERAL (SELECT id FROM brokers WHERE agency_id = a.id ORDER BY id LIMIT 1) b ON true`
  );
  await h.pool.query("SET session_replication_role = DEFAULT");
  await h.pool.query("ANALYZE listings");
  await h.pool.query("ANALYZE brokers");
  report.seed_ms = Date.now() - t0;
  const counts = (await h.query("SELECT (SELECT count(*)::int FROM agencies WHERE name LIKE 'LoadAgency%') a, (SELECT count(*)::int FROM brokers WHERE name LIKE 'Load %') b, (SELECT count(*)::int FROM listings WHERE code LIKE 'L%-%') u"))[0];
  expect(counts).toEqual({ a: AGENCIES, b: AGENCIES * PER_AGENCY, u: Math.floor(UNITS / AGENCIES) * AGENCIES });
  report.counts = counts;

  // Every agency owner signs in, then all 30 ask for the same pages at the same moment.
  const sessions = [];
  for (const a of ag) sessions.push({ a, ...(await signIn(h, { id: a.owner, agency_id: a.id })) });
  const routes = ["/app/units", "/app/units?page=3", "/app/search?q=" + encodeURIComponent("شقة 3 غرف"), "/app/leads", "/app/"];
  const leaks = [];
  const bad = [];
  const times = {};
  for (const route of routes) {
    const tr = Date.now();
    const results = await Promise.all(
      sessions.map(async (s) => {
        const t = Date.now();
        const res = await s.agent.get(route).redirects(0);
        return { s, ms: Date.now() - t, status: res.status, text: String(res.text || "") };
      })
    );
    times[route] = { ...stats(results.map((r) => r.ms)), wall_ms: Date.now() - tr };
    for (const r of results) {
      if (r.status >= 500) bad.push(`${r.status} ${route} agency ${r.s.a.n}`);
      const others = r.text.match(/\bL(\d+)-\d+\b/g) || [];
      for (const code of others) if (Number(code.slice(1).split("-")[0]) !== r.s.a.n) leaks.push(`${route}: agency ${r.s.a.n} saw ${code}`);
    }
  }
  report.web = times;
  expect(bad).toEqual([]);
  expect(leaks.slice(0, 5)).toEqual([]);

  // Bot replies: one search message from a broker of each of 10 agencies, one after the other.
  const bot = [];
  for (const a of ag.slice(0, 10)) {
    const t = Date.now();
    const out = await h.tgText(a.n * 1000 + 2, "شقة 3 غرف");
    bot.push(Date.now() - t);
    expect(out.length).toBeGreaterThan(0);
  }
  report.bot_reply = stats(bot);

  // An Excel import of 300 new units by one agency's owner while the other 29 agencies keep reading: preview, then apply.
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("x");
  ws.addRow(["الكود", "الكمبوند", "النوع", "بيع او ايجار", "السعر", "المساحة", "الغرف", "الحمامات", "تليفون المالك"]);
  for (let i = 1; i <= 300; i++) ws.addRow([`IMP-${i}`, "Hyde Park", "شقة", "بيع", `${2 + (i % 9)} مليون`, 100 + (i % 80), 1 + (i % 4), 1 + (i % 3), "01012345678"]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const imp = sessions[0];
  // The Office plan stops at 1,500 units (the limit itself is tested elsewhere): make room so the import can add 300.
  await h.pool.query("DELETE FROM listings WHERE id IN (SELECT id FROM listings WHERE agency_id = $1 LIMIT 600)", [imp.a.id]);
  const ti = Date.now();
  const reading = Promise.all(sessions.slice(1).map((s) => s.agent.get("/app/units").redirects(0)));
  const up = await imp.agent.post("/app/import/excel").field("_csrf", imp.csrf).attach("sheet", buf, { filename: "big.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  expect(up.status).toBe(303);
  const previewMs = Date.now() - ti;
  const id = up.headers.location.split("/").pop();
  const ta = Date.now();
  const applied = await imp.agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", imp.csrf).type("form").send(Array.from({ length: 300 }, (_, i) => `rows=${i + 2}`).join("&"));
  expect(applied.status).toBe(303);
  const reads = await reading;
  report.import_300_rows = { preview_ms: previewMs, apply_ms: Date.now() - ta, others_read_ok: reads.every((r) => r.status === 200) };
  const made = (await h.query("SELECT count(*)::int AS n FROM listings WHERE code LIKE 'IMP-%'"))[0].n;
  if (made < 250) console.log("IMPORT DEBUG " + JSON.stringify((await h.query("SELECT status, left(result::text, 300) AS r, left(payload::text, 300) AS p FROM web_imports ORDER BY created_at DESC LIMIT 1"))[0]));
  expect(made).toBeGreaterThan(250);

  console.log("LOAD REPORT " + JSON.stringify(report));
}, 900000);
