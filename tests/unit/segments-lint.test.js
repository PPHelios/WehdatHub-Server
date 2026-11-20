// tests/unit/segments-lint.test.js — the tier and the solo test live in domain/segments.js and lib/workspace.js only.
// A new `plan.id` or `isSolo(` anywhere else fails here: ask allows(ws, feature) instead (domain/segments.js).
// LEGACY lists the uses that existed before the segments work (file → how many); lower it when one is removed.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const DIRS = ["api", "domain", "lib", "routes", "services", "web"];
const OWN = new Set(["domain/segments.js", "lib/workspace.js"]);
const PATTERN = /\bplan\.id\b|\bisSolo\(/g;
const LEGACY = {
  "lib/credits.js": 1, // the isSolo() definition, now backed by lib/workspace.js
  "lib/dispatcher.js": 2, // bot credit hints: Credits.isSolo
  "lib/registry.js": 1, // login ceiling line: Credits.isSolo
  "services/billing.js": 2, // plan id passed to Credits.poolFor (billing, not segments)
  "services/billingNotices.js": 1, // dedupe key
  "services/catalogue.js": 1, // project plan (floor plan), unrelated
  "services/catalogueUpdates.js": 1 // project plan (floor plan), unrelated
};

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".js")) yield p;
  }
}

test("no new plan.id / isSolo( outside the segments files", () => {
  const found = {};
  for (const d of DIRS) {
    for (const f of walk(path.join(ROOT, d))) {
      const rel = path.relative(ROOT, f).split(path.sep).join("/");
      if (OWN.has(rel)) continue;
      const n = (fs.readFileSync(f, "utf8").match(PATTERN) || []).length;
      if (n) found[rel] = n;
    }
  }
  const over = Object.entries(found).filter(([f, n]) => n > (LEGACY[f] || 0));
  expect(over).toEqual([]);
});
