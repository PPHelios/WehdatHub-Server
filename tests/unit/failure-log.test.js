const { middleware, routeShape } = require("../../lib/failureLog");
jest.mock("../../lib/db", () => ({ logOperation: jest.fn(() => Promise.resolve()) }));
const { logOperation } = require("../../lib/db");

function run(status, { path = "/units/NH-V12/edit", traced = false, broker = { id: "b1", agency_id: "a1", role: "broker" } } = {}) {
  let done;
  const res = { statusCode: status, locals: { failureTraced: traced }, on: (_e, f) => (done = f) };
  const req = { path, baseUrl: "", method: "GET", session: broker ? { broker } : null, get: () => undefined };
  middleware({})(req, res, () => {});
  done();
}

beforeEach(() => logOperation.mockClear());

test("masks codes and ids in the route", () => {
  expect(routeShape("/units/NH-V12/edit")).toBe("/units/:code/edit");
  expect(routeShape("/leads/0b1c2d3e-0000-4000-8000-000000000000")).toBe("/leads/:id");
});
test("4xx is logged with status and route", () => {
  run(404);
  expect(logOperation).toHaveBeenCalledWith({}, expect.objectContaining({ operation_type: "web_failed", error_code: "http_404", status: "error" }));
});
test("2xx, already-traced and signed-out requests are not logged", () => {
  run(200); run(404, { traced: true }); run(403, { broker: null });
  expect(logOperation).not.toHaveBeenCalled();
});
