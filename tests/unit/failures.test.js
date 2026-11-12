jest.mock("../../lib/db", () => ({ logOperation: jest.fn(() => Promise.resolve()) }));
jest.mock("../../lib/errorReports", () => ({ maskPhones: (t) => String(t).replace(/\d{10,}/g, "•••"), alertOwner: jest.fn(() => Promise.resolve(true)) }));
const { logOperation } = require("../../lib/db");
const { alertOwner } = require("../../lib/errorReports");
const Swallow = require("../../lib/swallow");
const Failures = require("../../services/failures");

beforeEach(() => { logOperation.mockClear(); alertOwner.mockClear(); jest.spyOn(console, "warn").mockImplementation(() => {}); });

test("a swallowed error is logged with its place, masked, and the fallback is returned", () => {
  const out = Swallow.logged({}, "unitForm.areas", [])(new Error("boom 01012345678"));
  expect(out).toEqual([]);
  expect(logOperation).toHaveBeenCalledWith({}, expect.objectContaining({ operation_type: "swallowed_error", status: "error", error_code: "unitForm.areas: boom •••" }));
});

test("daily summary: nothing to say sends nothing; rows are purged either way", async () => {
  const pool = { query: jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 3 }) };
  const out = await Failures.summaryJob().run({ pool, now: Date.now() });
  expect(alertOwner).not.toHaveBeenCalled();
  expect(out.counts).toEqual({ sent: 0, purged: 3 });
});

test("daily summary lists counts by reason and agency", async () => {
  const pool = { query: jest.fn().mockResolvedValueOnce({ rows: [{ agency: "NCH", reason: "http_404", n: 4 }, { agency: "NCH", reason: "writes_off", n: 1 }] }).mockResolvedValueOnce({ rowCount: 0 }) };
  const out = await Failures.summaryJob().run({ pool, now: Date.now() });
  expect(alertOwner.mock.calls[0][0]).toMatch(/failures, last 24 h: 5[\s\S]*4 × http_404 \(NCH\)/);
  expect(out.counts.sent).toBe(1);
});

test("list filters by type and passes the filters as parameters", async () => {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  await Failures.list(pool, { agency: "a1", offset: 50 });
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/operation_type = ANY\(\$1\)/);
  expect(params[0]).toEqual(Failures.TYPES);
  expect(params[1]).toBe("a1");
  expect(params[6]).toBe(50);
});
