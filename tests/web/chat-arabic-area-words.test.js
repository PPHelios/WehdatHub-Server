// W18: area written in Arabic words ("مساحة مية وخمسين متر") is read like digits.
"use strict";
const fs = require("fs");
const path = require("path");
const { parsePost } = require("../../domain/chatListing");

const posts = fs.readFileSync(path.join(__dirname, "../fixtures/chat-arabic-area-words.txt"), "utf8")
  .split("\n").filter(Boolean).map((l) => l.replace(/^\[[^\]]+\]\s[^:]+:\s/, ""));
const area = (t) => parsePost(t).cells.area_value;

test("fixture posts give 150, 95, 1100, 150", () => {
  expect(posts.map(area)).toEqual(["150", "95", "1100", "150"]);
});

test.each([
  ["المساحة مية وخمسين", "150"], ["مساحة ماية وخمسين متر", "150"], ["مساحة مئة وخمسين متر", "150"],
  ["مساحة ميتين متر", "200"], ["مساحة تلتمية وخمسين متر", "350"], ["مساحة الفين متر", "2000"],
  ["150 متر", "150"], ["مساحة 150 متر", "150"],
])("%s -> %s", (t, n) => expect(area("شقة للبيع " + t + " سعر 3,000,000"))
  .toBe(n));
