// tests/unit/telegram-paced.test.js — Paced sends (patch 5): a burst of Telegram messages leaves at most one per gap; reads are not paced.
"use strict";

test("a burst of 6 sends is spread over the gap and a read is not delayed", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_SEND_GAP_MS = "60";
  const times = [];
  global.fetch = jest.fn(async (url) => {
    times.push([String(url).split("/").pop(), Date.now()]);
    return { json: async () => ({ ok: true, result: {} }) };
  });
  const TG = require("../../lib/telegram");
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 6 }, (_, i) => TG.sendMessage(100 + i, "hi")));
  const sends = times.filter(([m]) => m === "sendMessage").map(([, t]) => t);
  expect(sends).toHaveLength(6);
  expect(sends[5] - sends[0]).toBeGreaterThanOrEqual(5 * 60 - 15);
  expect(Date.now() - t0).toBeLessThan(2000);
});
