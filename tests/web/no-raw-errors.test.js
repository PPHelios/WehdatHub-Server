// tests/web/no-raw-errors.test.js — Plan 12: no page shows a raw error code, "undefined" or "[object Object]" to a person,
// in Arabic or English, for a broker or a manager.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(120000);

let h;
beforeAll(async () => { h = await createHarness(); });
afterAll(closeHarness);

const PAGES = ["/app/", "/app/units", "/app/leads", "/app/search", "/app/settings", "/app/notifications", "/app/import", "/app/usage", "/app/more", "/app/team", "/app/dashboard", "/app/activity-log"];
const BAD = /undefined|NaN\b|\[object Object\]|Internal Server Error/;
const CODE = /\b(?:PLAN_QUOTA_EXCEEDED|[A-Z]{2,}(?:_[A-Z]{2,}){1,})\b/;

// The visible text only: scripts, styles and attributes are not shown to a person.
const visible = (t) => t.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ");

for (const who of ["admin", "broker"]) {
  for (const lang of ["ar", "en"]) {
    test(`${who} (${lang}): no page shows a raw code or a broken value`, async () => {
      const s = await signIn(h, who);
      await h.query("UPDATE brokers SET preferred_lang = $2 WHERE id = $1", [h.BROKERS[who].id, lang]);
      const problems = [];
      let opened = 0;
      for (const p of PAGES) {
        const r = await s.agent.get(p);
        if (r.status >= 500) { problems.push(`${p}: ${r.status}`); continue; }
        if (r.status !== 200) continue; // a page this role may not open
        opened += 1;
        const text = visible(r.text);
        const m = BAD.exec(text) || CODE.exec(text);
        if (m) problems.push(`${p}: ${m[0]}`);
      }
      expect(opened).toBeGreaterThanOrEqual(6);
      expect(problems).toEqual([]);
    });
  }
}
