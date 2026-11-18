// tests/unit/api-error-words.test.js — Every error code the app API answers with by name has a sentence in Arabic and English
// (lib/errorText.js), so the app shows words, never a raw code (QA round 3, step 1). api/index.js adds the sentence as `message`.
"use strict";

const fs = require("fs");
const path = require("path");
const ErrorText = require("../../lib/errorText");

test("every error code written in api/*.js has words in both languages", () => {
  const dir = path.join(__dirname, "../../api");
  const codes = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const s = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of s.matchAll(/error:\s*"([a-z][a-z_]+)"/g)) codes.add(m[1]);
    for (const m of s.matchAll(/fail\(res,\s*"([a-z_]+)"/g)) codes.add(m[1]);
  }
  expect(codes.size).toBeGreaterThan(30);
  const missing = [...codes].filter((c) => !ErrorText.of(c, "ar") || !ErrorText.of(c, "en")).sort();
  expect(missing).toEqual([]);
});

test("no sentence is empty or shows a code", () => {
  for (const c of ErrorText.CODES) {
    for (const lang of ["ar", "en"]) {
      const t = ErrorText.of(c, lang);
      expect(t.trim().length).toBeGreaterThan(3);
      expect(t).not.toMatch(/[a-z]+_[a-z]+/);
    }
  }
});
