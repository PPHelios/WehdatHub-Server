"use strict";

// While the test number views another agency, only Ask may be sent as a write-method request, and it runs read-only.
const TR = require("../../lib/testRole");
const ViewGuard = require("../../lib/viewGuard");

describe("view-mode Ask", () => {
  test("Ask is the one POST allowed while viewing another agency", () => {
    expect(TR.viewPostAllowed("POST", "/ask")).toBe(true);
  });

  test("other write requests stay refused while viewing", () => {
    expect(TR.viewPostAllowed("POST", "/searches")).toBe(false);
    expect(TR.viewPostAllowed("POST", "/units")).toBe(false);
    expect(TR.viewPostAllowed("POST", "/ask/info")).toBe(false);
    expect(TR.viewPostAllowed("DELETE", "/ask")).toBe(false);
  });

  test("inside a view-mode request, a write statement is refused by the read-only guard", async () => {
    const pool = { query: async () => ({ rows: [] }), connect: async () => ({}) };
    ViewGuard.guardPool(pool);
    await expect(ViewGuard.runReadOnly(() => pool.query("INSERT INTO assistant_questions (x) VALUES (1)"))).rejects.toThrow("Read only while viewing another agency");
    await expect(ViewGuard.runReadOnly(() => pool.query("SELECT 1"))).resolves.toBeDefined();
  });
});
