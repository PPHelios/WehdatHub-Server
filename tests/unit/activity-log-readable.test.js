// tests/unit/activity-log-readable.test.js — The activity log reads as plain sentences: an icon per action, days grouped,
// and the AI-limit and unit-rights changes described in words.
"use strict";

const ActivityLog = require("../../services/activityLog");

test("an icon per kind of action", () => {
  expect(ActivityLog.iconOf("team_role_change")).toBe("👥");
  expect(ActivityLog.iconOf("command_inventory_export")).toBe("⬇️");
  expect(ActivityLog.iconOf("secret_details_request")).toBe("🔒");
  expect(ActivityLog.iconOf("ai_usage_settings")).toBe("🤖");
  expect(ActivityLog.iconOf("web login failed")).toBe("❌");
  expect(ActivityLog.iconOf("something_new")).toBe("📝");
});

test("rows are grouped by Cairo day, newest first", () => {
  const rows = [
    { id: 3, created_at: "2026-11-16T10:00:00Z" },
    { id: 2, created_at: "2026-11-16T08:00:00Z" },
    { id: 1, created_at: "2026-11-15T21:30:00Z" } // 23:30 Cairo, still the 15th
  ];
  const g = ActivityLog.groupByDay(rows);
  expect(g.map((x) => [x.day, x.rows.length])).toEqual([["2026-11-16", 2], ["2026-11-15", 1]]);
});

test("limit and rights changes are plain sentences, and an unknown action is readable", () => {
  const d = (operation_type, metadata) => ActivityLog.describe({ operation_type, metadata }, "en");
  expect(d("ai_usage_settings", { mode: "per_user" })).toBe("Changed the AI limits: a limit per person");
  expect(d("manager_can_edit_ai_settings", { allowed: true })).toBe("Let managers change the AI limits");
  expect(d("brokers_edit_units", { allowed: false })).toBe("Stopped brokers adding and editing units");
  expect(d("web some_thing", {})).toBe("some thing");
});

test("QA round 2 (item 41): raw audit action names read as plain sentences in both languages", () => {
  const d = (a, lang = "en") => ActivityLog.describe({ operation_type: a, metadata: {} }, lang);
  expect(d("web POST /team/invite")).toBe("Added a team member");
  expect(d("web POST /team/invite", "ar")).toBe("ضاف عضو للفريق");
  expect(d("web POST /settings")).toBe("Changed settings");
  expect(d("web POST /owner/map/alias")).toBe("Changed the places list");
  expect(d("web_login_telegram")).toBe("Signed in to the website from Telegram");
  expect(d("web_login_code failed")).toBe("Signed in to the website with a code (failed)");
  expect(d("api_login_code_request")).toBe("Asked for an app sign-in code");
  // A path nobody described yet still reads as a sentence, not as a raw route.
  expect(d("web POST /something/new")).toBe("Made a change: /something/new");
  expect(d("web POST /something/new")).not.toMatch(/^web POST/);
});
