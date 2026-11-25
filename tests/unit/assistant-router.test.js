// tests/unit/assistant-router.test.js — Pure deterministic classification before invoking AI.
"use strict";

const Router = require("../../domain/assistantRouter");

describe("domain/assistantRouter.classifyAssistantQuery", () => {
  test("respects explicit mode locks without ever mixing resale and primary", () => {
    expect(Router.classifyAssistantQuery({ text: "developer commissions", mode: "resale" }).route).toBe("unit_search");
    expect(Router.classifyAssistantQuery({ text: "apartment in Hyde Park", mode: "primary" }).route).toBe("primary");
    expect(Router.classifyAssistantQuery({ text: "total commissions", mode: "reports" }).route).toBe("crm_commissions");
    expect(Router.classifyAssistantQuery({ text: "anything vague", mode: "reports" }).route).toBe("crm_brief");
  });

  test("auto mode routes CRM/owner questions deterministically before unit/primary", () => {
    expect(Router.classifyAssistantQuery({ text: "who is not updating the app?", mode: "auto" }).route).toBe("crm_discipline");
    expect(Router.classifyAssistantQuery({ text: "عملاء مستنين أكتر من ساعة", mode: "auto" })).toMatchObject({ route: "crm_leads", queueHint: "waiting-over-1h" });
    expect(Router.classifyAssistantQuery({ text: "developer commissions overdue", mode: "auto" }).route).toBe("crm_commissions");
    expect(Router.classifyAssistantQuery({ text: "how is Broker One doing?", mode: "auto" })).toMatchObject({ route: "crm_broker", brokerQuery: "broker one" });
    expect(Router.classifyAssistantQuery({ text: "leases ending soon", mode: "auto" }).route).toBe("crm_leases");
    expect(Router.classifyAssistantQuery({ text: "facebook lead sources", mode: "auto" }).route).toBe("crm_sources");
    expect(Router.classifyAssistantQuery({ text: "3 bedroom apartment in Hyde Park under 9M", mode: "auto" }).route).toBe("unit_search");
    expect(Router.classifyAssistantQuery({ text: "when does Badya deliver?", mode: "auto" }).route).toBe("primary");
  });

  test("extracts Cairo time windows, broker/team activity, scheduled viewings, response time, win/loss, and facebook leads", () => {
    expect(Router.classifyAssistantQuery({ text: "what did Sara do today?", mode: "auto" })).toMatchObject({
      route: "crm_broker",
      brokerQuery: "sara",
      windowInfo: { key: "today" }
    });
    expect(Router.classifyAssistantQuery({ text: "how many viewings did Omar do this week?", mode: "auto" })).toMatchObject({
      route: "crm_broker",
      brokerQuery: "omar",
      windowInfo: { key: "this_week" }
    });
    expect(Router.classifyAssistantQuery({ text: "how did Khaled's team do this month?", mode: "auto" })).toMatchObject({
      route: "crm_team",
      teamQuery: "khaled",
      windowInfo: { key: "this_month" }
    });
    expect(Router.classifyAssistantQuery({ text: "how many viewings we have today?", mode: "auto" })).toMatchObject({
      route: "crm_viewings",
      windowInfo: { key: "today" }
    });
    expect(Router.classifyAssistantQuery({ text: "عندنا كام معاينة بكرة؟", mode: "auto" })).toMatchObject({
      route: "crm_viewings",
      windowInfo: { key: "tomorrow" }
    });
    expect(Router.classifyAssistantQuery({ text: "how many leads came from facebook?", mode: "auto" })).toMatchObject({
      route: "crm_sources",
      sourceFilter: "Facebook"
    });
    expect(Router.classifyAssistantQuery({ text: "what is the average response time per person?", mode: "auto" })).toMatchObject({
      route: "crm_response_time"
    });
    expect(Router.classifyAssistantQuery({ text: "أسباب الخسارة الشهر ده", mode: "auto" })).toMatchObject({
      route: "crm_win_loss",
      windowInfo: { key: "this_month" }
    });
    expect(Router.classifyAssistantQuery({ text: "how many calls did the team make today?", mode: "auto" })).toMatchObject({
      route: "crm_team",
      teamQuery: "",
      windowInfo: { key: "today" }
    });
    expect(Router.classifyAssistantQuery({ text: "how many viewings this week?", mode: "auto" })).not.toMatchObject({
      route: "crm_viewings"
    });
  });

  test("extractTimeWindow resolves strict Cairo [from, to) intervals, inclusive end dates, DST boundaries, and omitted year", () => {
    // Fixed Cairo clock: 2026-11-20T14:30:00Z = 2026-11-20 16:30 Cairo
    const now = new Date("2026-11-20T14:30:00Z");

    const novRange = Router.extractTimeWindow("deals from 1-15 Nov", now);
    expect(novRange.inclusiveEndCairoDate).toBe("2026-11-15");
    expect(novRange.from.toISOString()).toBe("2026-10-31T22:00:00.000Z"); // 2026-11-01 00:00 Cairo (UTC+2)
    expect(novRange.to.toISOString()).toBe("2026-11-15T22:00:00.000Z");   // 2026-11-16 00:00 Cairo (exclusive end)

    const novAr = Router.extractTimeWindow("صفقات من ١ لـ ١٥ نوفمبر", now);
    expect(novAr.from.getTime()).toBe(novRange.from.getTime());
    expect(novAr.to.getTime()).toBe(novRange.to.getTime());

    const threeDays = Router.extractTimeWindow("last 3 days", now);
    expect(threeDays.from.toISOString()).toBe("2026-11-17T22:00:00.000Z"); // Nov 18 00:00 Cairo
    expect(threeDays.to.toISOString()).toBe("2026-11-20T22:00:00.000Z");   // Nov 21 00:00 Cairo

    const twoWeeks = Router.extractTimeWindow("last 2 weeks", now);
    expect(twoWeeks.from.toISOString()).toBe("2026-11-06T22:00:00.000Z"); // 14 rolling days: Nov 7..20
    expect(twoWeeks.to.toISOString()).toBe("2026-11-20T22:00:00.000Z");

    // 2026-11-20 is a Friday -> completed Mon-Sun last week is Mon 2026-11-09 .. Mon 2026-11-16 00:00 Cairo
    const lastWeek = Router.extractTimeWindow("last week", now);
    expect(lastWeek.from.toISOString()).toBe("2026-11-08T22:00:00.000Z"); // Nov 9 00:00 Cairo
    expect(lastWeek.to.toISOString()).toBe("2026-11-15T22:00:00.000Z");   // Nov 16 00:00 Cairo

    const sinceYesterday = Router.extractTimeWindow("leads since yesterday", now);
    expect(sinceYesterday.from.toISOString()).toBe("2026-11-18T22:00:00.000Z"); // Nov 19 00:00 Cairo
    expect(sinceYesterday.to.getTime()).toBe(now.getTime());

    const hrs48 = Router.extractTimeWindow("last 48 hours", now);
    expect(hrs48.to.getTime() - hrs48.from.getTime()).toBe(48 * 3600 * 1000);

    // Omitted year when month is ahead of current Cairo month resolves to prior year.
    const febNow = new Date("2026-02-10T10:00:00Z");
    const priorNov = Router.extractTimeWindow("deals 1-15 Nov", febNow);
    expect(priorNov.inclusiveEndCairoDate).toBe("2025-11-15");

    // Cairo midnight + Egypt spring/autumn DST transition boundary:
    // Egypt spring forward 2026-04-24 00:00 UTC+2 -> 01:00 UTC+3 (23-hour Cairo day).
    const dstDay = new Date("2026-04-24T10:00:00Z");
    const dstToday = Router.extractTimeWindow("today", dstDay);
    expect(dstToday.from.toISOString()).toBe("2026-04-23T22:00:00.000Z"); // Apr 24 00:00 (UTC+2)
    expect(dstToday.to.toISOString()).toBe("2026-04-24T21:00:00.000Z");   // Apr 25 00:00 (UTC+3)

    // resolveInterval enforces 730-day cap & precedence over legacy days.
    expect(Router.resolveInterval({ from: "2024-01-01", to: "2026-11-20", days: 30 })).toEqual({ error: "range_too_large" });
    const explicit = Router.resolveInterval({ from: "2026-11-01", to: "2026-11-15", days: 7 });
    expect(explicit.from.toISOString()).toBe("2026-10-31T22:00:00.000Z");
    expect(explicit.to.toISOString()).toBe("2026-11-15T22:00:00.000Z");
  });
});
