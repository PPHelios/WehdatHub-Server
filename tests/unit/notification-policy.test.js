// tests/unit/notification-policy.test.js — The agency's notification policy: a locked setting is forced for everyone, an
// unlocked one is the team's default that a person may change, the owner's lock beats a manager's, urgent kinds are always
// on and immediate, and batches go out on the hour or at 9 Cairo.
"use strict";

const P = require("../../lib/notificationPolicy");

const broker = { role: "broker" };
const manager = { role: "manager" };
const owner = { role: "owner" };

describe("resolve: who decides", () => {
  test("no policy: the person's own choice applies, else immediate and on", () => {
    expect(P.resolve({}, {}, "match")).toMatchObject({ enabled: true, frequency: "immediate", channel: null, locked: null });
    expect(P.resolve({}, { channel: "web", frequency: "hourly", on: false }, "match")).toMatchObject({ enabled: false, channel: "web", frequency: "hourly" });
  });

  test("an unlocked team default is used until the person chooses", () => {
    const policy = { match: { channel: "telegram", frequency: "daily" } };
    expect(P.resolve(policy, {}, "match")).toMatchObject({ channel: "telegram", frequency: "daily", locked: null });
    expect(P.resolve(policy, { channel: "web", frequency: "hourly" }, "match")).toMatchObject({ channel: "web", frequency: "hourly" });
  });

  test("a locked setting is forced: the person's own choice does not change it", () => {
    const policy = { match: { channel: "web", lock: "manager" } };
    const r = P.resolve(policy, { channel: "whatsapp" }, "match");
    expect(r).toMatchObject({ channel: "web", locked: "manager" });
    expect(r.lockedFields).toEqual(["channel"]);
  });

  test("urgent kinds are always on and immediate, even if the policy says otherwise", () => {
    const policy = { assignment: { on: false, frequency: "daily", channel: "web" } };
    expect(P.resolve(policy, { on: false, frequency: "daily" }, "assignment")).toMatchObject({ enabled: true, frequency: "immediate", channel: "web" });
    expect(P.isUrgent("hot_client")).toBe(true);
    expect(P.isUrgent("match")).toBe(false);
  });
});

describe("merge: who may save what", () => {
  test("a manager cannot change what the owner locked; the owner can", () => {
    const current = { match: { channel: "web", lock: "owner" } };
    expect(P.merge(current, manager, { match: { channel: "telegram" } })).toEqual({ error: "owner_locked", kind: "match" });
    expect(P.merge(current, owner, { match: { channel: "telegram", lock: "owner" } }).policy.match).toEqual({ channel: "telegram", lock: "owner" });
  });

  test("a manager may lock or set what the owner has not locked", () => {
    const r = P.merge({}, manager, { share_opened: { frequency: "hourly", lock: "manager" } });
    expect(r.policy.share_opened).toEqual({ frequency: "hourly", lock: "manager" });
  });

  test("urgent kinds cannot be switched off or batched by the policy", () => {
    const r = P.merge({}, owner, { follow_up: { on: false, frequency: "hourly", channel: "web" } });
    expect(r.policy.follow_up).toEqual({ channel: "web" });
  });

  test("an unknown kind is refused; a null change clears the entry", () => {
    expect(P.merge({}, owner, { nonsense: { on: false } })).toEqual({ error: "kind" });
    expect(P.merge({ match: { on: false } }, owner, { match: null }).policy).toEqual({});
  });
});

describe("batch times", () => {
  test("hourly: the next full hour", () => {
    const now = new Date("2026-11-05T10:20:00Z");
    expect(P.nextBatchAt("hourly", now).toISOString()).toBe("2026-11-05T11:00:00.000Z");
  });

  test("daily: 09:00 Cairo, today if it is still early, else tomorrow", () => {
    expect(P.nextBatchAt("daily", new Date("2026-11-05T06:00:00Z")).toISOString()).toBe("2026-11-05T07:00:00.000Z"); // 09:00 Cairo
    expect(P.nextBatchAt("daily", new Date("2026-11-05T12:00:00Z")).toISOString()).toBe("2026-11-06T07:00:00.000Z");
  });
});
