// tests/unit/slow-requests.test.js — Slow-request log (patch 5): slow pages are stored once a minute per route; fast ones are not.
"use strict";

const Slow = require("../../lib/slowRequests");

function run(ms, route = "/x") {
  const pool = { query: jest.fn(() => Promise.resolve({ rows: [] })) };
  let onFinish;
  const res = { statusCode: 200, on: (_e, fn) => (onFinish = fn) };
  const t = jest.spyOn(process.hrtime, "bigint").mockReturnValueOnce(0n).mockReturnValueOnce(BigInt(ms) * 1000000n);
  Slow.middleware(pool)({ method: "GET", baseUrl: "/app", path: route, session: {} }, res, () => {});
  onFinish();
  t.mockRestore();
  return pool.query;
}

test("a slow page is stored once a minute and a fast one is not", () => {
  expect(run(500, "/fast")).not.toHaveBeenCalled();
  expect(run(3000, "/slow")).toHaveBeenCalledTimes(1);
  expect(run(3000, "/slow")).not.toHaveBeenCalled();
});
