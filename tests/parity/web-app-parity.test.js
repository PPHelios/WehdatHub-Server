// tests/parity/web-app-parity.test.js — Every website page has an app twin (an API route the app uses), is app-only, or is web-only with a reason.
// Add a web page and this fails until the map says which it is; an "api:" entry must point at a real API route.
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const map = JSON.parse(fs.readFileSync(path.join(__dirname, "web-app-parity.json"), "utf8"));
const read = (dir, re) => {
  const out = new Set();
  for (const f of fs.readdirSync(path.join(root, dir)).filter((x) => x.endsWith(".js"))) {
    for (const m of fs.readFileSync(path.join(root, dir, f), "utf8").matchAll(re)) out.add(m[1]);
  }
  return out;
};
const webPages = read("web/routes", /web\.get\("([^"]*)"/g);
const apiRoutes = read("api", /api\.(?:get|post|put|patch|delete)\("([^"]*)"/g);

test("every website page is in the parity map", () => {
  const missing = [...webPages].filter((p) => !(p in map));
  expect(missing).toEqual([]);
});

test("the map has no pages that no longer exist", () => {
  expect(Object.keys(map).filter((p) => !webPages.has(p))).toEqual([]);
});

test("an api: twin points at a real API route, and web-only/app-only say why", () => {
  const bad = [];
  for (const [page, how] of Object.entries(map)) {
    if (how.startsWith("api:")) {
      if (!apiRoutes.has(how.slice(4))) bad.push(`${page} -> ${how}`);
    } else if (!/^(web-only|app-only): \S/.test(how)) bad.push(`${page}: ${how}`);
  }
  expect(bad).toEqual([]);
});
