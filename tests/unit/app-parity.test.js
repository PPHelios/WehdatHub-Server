// tests/unit/app-parity.test.js — Every website route file has an app twin or a reason to stay web-only (docs/app-parity.json).
"use strict";

const fs = require("fs");
const path = require("path");

const list = JSON.parse(fs.readFileSync(path.join(__dirname, "../../docs/app-parity.json"), "utf8"));
const files = fs.readdirSync(path.join(__dirname, "../../web/routes")).filter((f) => f.endsWith(".js"));

test("every web route file is in the parity list", () => {
  expect(files.filter((f) => !list[f])).toEqual([]);
});

test("no entry names a missing file, and each says app or web", () => {
  const bad = Object.keys(list).filter((k) => !k.startsWith("_") && (!files.includes(k) || !(list[k].app || list[k].web)));
  expect(bad).toEqual([]);
});
