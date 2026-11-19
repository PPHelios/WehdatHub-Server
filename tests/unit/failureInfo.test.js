"use strict";
const { describe: info, SEVERITIES } = require("../../lib/failureInfo");

test("severity by code", () => {
  expect(info("app_failed", "http_500").severity).toBe("high");
  expect(info("swallowed_error", "x: boom").severity).toBe("high");
  expect(info("web_failed", "http_400").severity).toBe("medium");
  expect(info("web_failed", "http_403").severity).toBe("low");
  expect(info("unit_write_refused", "price").severity).toBe("low");
  expect(SEVERITIES).toEqual(["high", "medium", "low"]);
});

test("every known code has plain words in both languages", () => {
  for (const c of [400, 401, 402, 403, 404, 409, 413, 422, 429, 500]) {
    const d = info("web_failed", `http_${c}`);
    expect(d.ar.length).toBeGreaterThan(5);
    expect(d.en.length).toBeGreaterThan(5);
  }
});
