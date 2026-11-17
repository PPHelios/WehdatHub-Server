// tests/unit/deal-status-rules.test.js — QA round 2 (item 31): a deal moves forward; going back is for managers, with a
// confirmation, and is audited.
"use strict";

const Deals = require("../../services/deals");

const broker = { role: "broker" };
const manager = { role: "manager" };

test("anyone who may edit the deal moves it forward and cancels it before it is paid", () => {
  for (const [from, to] of [["pending", "signed"], ["pending", "paid"], ["signed", "paid"], ["pending", "cancelled"], ["signed", "cancelled"]]) {
    expect([from, to, Deals.statusMoveError(broker, from, to)]).toEqual([from, to, null]);
  }
  expect(Deals.statusMoveError(broker, "signed", "signed")).toBe(null);
});

test("a broker cannot move a deal back, reopen a cancelled one, or cancel a paid one", () => {
  for (const [from, to] of [["paid", "pending"], ["paid", "signed"], ["signed", "pending"], ["cancelled", "pending"], ["cancelled", "signed"], ["paid", "cancelled"]]) {
    expect([from, to, Deals.statusMoveError(broker, from, to)]).toEqual([from, to, "status_backwards"]);
  }
});

test("a manager can go back only after a confirmation", () => {
  expect(Deals.statusMoveError(manager, "paid", "pending")).toBe("confirm_reopen");
  expect(Deals.statusMoveError(manager, "paid", "pending", { confirm: true })).toBe(null);
  expect(Deals.statusMoveError(manager, "cancelled", "pending", { confirm: true })).toBe(null);
  expect(Deals.statusMoveError(manager, "pending", "signed")).toBe(null);
});

test("the choices offered: a broker sees the current status and the allowed moves only", () => {
  expect(Deals.allowedStatuses(broker, "pending")).toEqual(["pending", "signed", "paid", "cancelled"]);
  expect(Deals.allowedStatuses(broker, "signed")).toEqual(["signed", "paid", "cancelled"]);
  expect(Deals.allowedStatuses(broker, "paid")).toEqual(["paid"]);
  expect(Deals.allowedStatuses(broker, "cancelled")).toEqual(["cancelled"]);
  expect(Deals.allowedStatuses(manager, "paid")).toEqual(["pending", "signed", "paid", "cancelled"]);
});
