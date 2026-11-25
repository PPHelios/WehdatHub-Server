// tests/unit/assistant-routing-pairs.test.js — Paired EN/AR routing & capability contract tests for Wave 2.
"use strict";

const Router = require("../../domain/assistantRouter");

describe("Wave 2 paired EN/AR routing and extraction contracts", () => {
  const fixedNow = new Date("2026-11-25T10:00:00Z");

  test.each([
    ["Resale with remaining installments (EN)", "resale in madinaty with remaining installments", "auto", { route: "unit_search", job: "find_units", market: "resale" }],
    ["Resale with remaining installments (AR)", "ريسيل في مدينتي عليه أقساط متبقية", "auto", { route: "unit_search", job: "find_units", market: "resale" }],
    ["Primary payment plan / delivery (EN)", "what are the payment plans and delivery for Project X?", "auto", { route: "primary", job: "project_info", market: "primary" }],
    ["Primary payment plan / delivery (AR)", "إيه أنظمة السداد والاستلام في مشروع X؟", "auto", { route: "primary", job: "project_info", market: "primary" }],
  ])("%s", (_label, text, mode, expected) => {
    expect(Router.classifyAssistantQuery({ text, mode })).toMatchObject(expected);
  });

  test.each([
    ["Inventory count (EN)", "how many apartments do we have in Zayed?", "auto", { route: "inventory_count", job: "inventory_count" }],
    ["Inventory count (AR)", "كام شقة متاحة عندنا في زايد؟", "auto", { route: "inventory_count", job: "inventory_count" }],
    ["Deals closed by Sara + resale + Fifth Settlement + last week (EN)", "resale deals closed by Sara in Fifth Settlement last week", "auto", { route: "crm_deals", job: "deals_report", market: "resale", brokerRole: "closer", windowInfo: { key: "last_week" } }],
    ["Deals closed by Sara + resale + Fifth Settlement + last week (AR)", "صفقات الريسيل اللي قفلتها سارة في التجمع الخامس الأسبوع اللي فات", "auto", { route: "crm_deals", job: "deals_report", market: "resale", brokerRole: "closer", windowInfo: { key: "last_week" } }],
    ["Overdue developer commissions (EN)", "overdue developer commissions", "auto", { route: "crm_commissions" }],
    ["Overdue developer commissions (AR)", "عمولات المطورين المتأخرة", "auto", { route: "crm_commissions" }],
  ])("%s", (_label, text, mode, expected) => {
    expect(Router.classifyAssistantQuery({ text, mode })).toMatchObject(expected);
  });

  test.each([
    ["Explicit exclusion resale only (EN)", "apartments in Madinaty no primary, resale only", "auto", { route: "unit_search", market: "resale", exclusions: ["primary"] }],
    ["Explicit exclusion resale only (AR)", "شقة في مدينتي مفيش برايمري، ريسيل بس", "auto", { route: "unit_search", market: "resale", exclusions: ["primary"] }],
    ["Ambiguous down payment clarify (EN)", "apartments in Zayed with 1M down payment", "auto", { route: "clarify", clarifyKind: "market_choice" }],
    ["Ambiguous down payment clarify (AR)", "شقق في زايد بمقدم مليون", "auto", { route: "clarify", clarifyKind: "market_choice" }],
    ["Primary mode + CRM overdue leads clarify (EN)", "overdue leads", "primary", { route: "clarify", clarifyKind: "switch_mode_reports" }],
    ["Primary mode + CRM overdue leads clarify (AR)", "العملاء المتأخرين", "primary", { route: "clarify", clarifyKind: "switch_mode_reports" }],
  ])("%s", (_label, text, mode, expected) => {
    expect(Router.classifyAssistantQuery({ text, mode })).toMatchObject(expected);
  });

  test("since yesterday EN/AR waiting queues resolve strict Cairo midnight bounds", () => {
    const enWin = Router.extractTimeWindow("leads waiting since yesterday", fixedNow);
    const arWin = Router.extractTimeWindow("العملاء اللي مستنيين من امبارح", fixedNow);
    expect(enWin).toMatchObject({ key: "since_yesterday" });
    expect(arWin).toMatchObject({ key: "since_yesterday" });
    expect(enWin.from.toISOString()).toBe(arWin.from.toISOString());
    expect(enWin.to.toISOString()).toBe(arWin.to.toISOString());
    expect(Router.classifyAssistantQuery({ text: "leads waiting over 1h since yesterday", mode: "auto" })).toMatchObject({ route: "crm_leads", queueHint: "waiting-over-1h" });
    expect(Router.classifyAssistantQuery({ text: "العملاء اللي مستنيين اكتر من ساعة من امبارح", mode: "auto" })).toMatchObject({ route: "crm_leads", queueHint: "waiting-over-1h" });
  });
});
