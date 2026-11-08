// tests/unit/place-names-alert.test.js — A new compound name notifies the CRM owner accounts only, never the shared alert chat.
"use strict";

jest.mock("../../services/systemAlerts", () => ({ recipients: jest.fn(async () => [{ id: "owner-1", agency_id: "agency-x" }]) }));
jest.mock("../../lib/notifications", () => ({ notifyBroker: jest.fn(async () => ({ id: 1 })) }));
jest.mock("../../lib/errorReports", () => ({ alertOwner: jest.fn(async () => true) }));

const LIB = require("../../lib/placeNames");
const Notifications = require("../../lib/notifications");
const ErrorReports = require("../../lib/errorReports");

function fakePool() {
  const rows = new Map();
  return {
    query: async (sql, params) => {
      if (/INSERT INTO place_names/.test(sql)) {
        const [key, name] = params;
        if (rows.has(key)) return { rows: [{ status: "pending", times_seen: 2, inserted: false }] };
        rows.set(key, { name });
        return { rows: [{ status: "pending", times_seen: 1, inserted: true }] };
      }
      return { rows: [] };
    }
  };
}

test("a new name notifies the CRM owner once, not the shared Telegram alert chat", async () => {
  const pool = fakePool();
  expect((await LIB.noteUnknown(pool, "Mountain")).status).toBe("new");
  await LIB.noteUnknown(pool, "Mountain");
  expect(Notifications.notifyBroker).toHaveBeenCalledTimes(1);
  const [, owner, opts] = Notifications.notifyBroker.mock.calls[0];
  expect(owner).toEqual({ id: "owner-1", agency_id: "agency-x" });
  expect(opts).toMatchObject({ kind: "system_alert", dedupeKey: "place-name:mountain", url: "/app/owner#place-names" });
  expect(ErrorReports.alertOwner).not.toHaveBeenCalled();
});
