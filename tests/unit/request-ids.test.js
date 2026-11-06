// tests/unit/request-ids.test.js — One-time request IDs (patch 3): a repeat of the same ID is answered without running the action again.
"use strict";

const fs = require("fs");
const path = require("path");
const RequestIds = require("../../lib/requestIds");

beforeEach(() => RequestIds.reset());

const call = (headers = {}, body = {}, method = "POST") => {
  const req = { method, body, session: { broker: { id: "b1" } }, get: (h) => headers[h.toLowerCase()] };
  const res = { status: jest.fn(() => res), set: jest.fn(() => res), end: jest.fn(), redirect: jest.fn() };
  const next = jest.fn();
  RequestIds.middleware(req, res, next);
  return { res, next };
};

test("the first request with an ID runs and a repeat does not", () => {
  expect(call({}, { _rid: "abcdef123456" }).next).toHaveBeenCalled();
  const again = call({ referer: "http://x/app/units/new?step=2" }, { _rid: "abcdef123456" });
  expect(again.next).not.toHaveBeenCalled();
  expect(again.res.redirect).toHaveBeenCalledWith(303, "/app/units/new?step=2");
});

test("a repeated htmx request is answered with nothing to swap", () => {
  call({ "x-request-id": "htmxid123456" });
  const again = call({ "x-request-id": "htmxid123456", "hx-request": "true" });
  expect(again.next).not.toHaveBeenCalled();
  expect(again.res.status).toHaveBeenCalledWith(204);
});

test("requests without an ID, reads and other people's IDs are untouched", () => {
  expect(call({}, {}).next).toHaveBeenCalled();
  expect(call({}, {}).next).toHaveBeenCalled();
  expect(call({}, { _rid: "abcdef123456" }, "GET").next).toHaveBeenCalled();
  expect(call({}, { _rid: "abcdef123456" }, "GET").next).toHaveBeenCalled();
  expect(RequestIds.repeated("b1", "sameid123456")).toBe(false);
  expect(RequestIds.repeated("b2", "sameid123456")).toBe(false);
  expect(RequestIds.repeated("b1", "sameid123456")).toBe(true);
});

test("an ID is usable again after two minutes", () => {
  const t = Date.now();
  expect(RequestIds.repeated("b1", "laterid12345", t)).toBe(false);
  expect(RequestIds.repeated("b1", "laterid12345", t + RequestIds.TTL_MS + 1000)).toBe(false);
});

test("delete and discard forms ask first, and busy buttons get a spinner in htmx requests", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, "../..", f), "utf8");
  expect(read("web/routes/search.js")).toMatch(/searches\/\$\{s\.id\}\/delete"[^>]*data-confirm/);
  expect(read("web/routes/settings.js")).toMatch(/logo\/remove"[^>]*data-confirm/);
  expect(read("web/routes/priceSheets.js")).toMatch(/sheets\/\$\{sheet\.id\}\/discard"[^>]*data-confirm/);
  expect(read("web/static/app.css")).toMatch(/button\.htmx-request::after/);
  expect(read("web/static/app.js")).toMatch(/X-Request-Id/);
});
