"use strict";

const Router = require("../../domain/assistantRouter");

describe("assistantRouter Egyptian Arabic & English phrase coverage", () => {
  const cases = [
    // Unassigned leads
    ["Unassigned leads", "crm_leads", "unassigned"],
    ["without broker", "crm_leads", "unassigned"],
    ["no broker", "crm_leads", "unassigned"],
    ["not assigned", "crm_leads", "unassigned"],
    ["عملاء من غير وسيط", "crm_leads", "unassigned"],
    ["عملاء بدون وسيط", "crm_leads", "unassigned"],
    ["ملهمش وسيط", "crm_leads", "unassigned"],
    ["لسه متوزعوش", "crm_leads", "unassigned"],
    ["محدش استلمهم", "crm_leads", "unassigned"],
    ["مش متسلم", "crm_leads", "unassigned"],
    ["بدون سيلز", "crm_leads", "unassigned"],

    // Waiting > 1h / delayed first contact
    ["Leads waiting over 1h", "crm_leads", "waiting-over-1h"],
    ["late first contact", "crm_leads", "waiting-over-1h"],
    ["delayed first contact", "crm_leads", "waiting-over-1h"],
    ["waiting to be called", "crm_leads", "waiting-over-1h"],
    ["عملاء مستنين أكتر من ساعة", "crm_leads", "waiting-over-1h"],
    ["تأخر أول تواصل", "crm_leads", "waiting-over-1h"],
    ["بقالهم اكتر من ساعه", "crm_leads", "waiting-over-1h"],
    ["محدش رد عليهم", "crm_leads", "waiting-over-1h"],
    ["مستنيين تواصل", "crm_leads", "waiting-over-1h"],

    // Overdue follow-ups
    ["Overdue follow-ups", "crm_leads", "overdue"],
    ["missed follow ups", "crm_leads", "overdue"],
    ["late follow-ups", "crm_leads", "overdue"],
    ["متابعات متأخرة", "crm_leads", "overdue"],
    ["متابعات فايتة", "crm_leads", "overdue"],
    ["عملاء عدى ميعادهم", "crm_leads", "overdue"],
    ["مين متاخر في المتابعه", "crm_leads", "overdue"],

    // Uncontacted leads
    ["Uncontacted leads", "crm_leads", "uncontacted"],
    ["never contacted", "crm_leads", "uncontacted"],
    ["nobody called", "crm_leads", "uncontacted"],
    ["محدش كلمهم", "crm_leads", "uncontacted"],
    ["لسه متكلموش", "crm_leads", "uncontacted"],
    ["محدش اتصل بيهم", "crm_leads", "uncontacted"],

    // Approaching SLA & opened links
    ["Approaching SLA", "crm_approaching_sla", null],
    ["almost overdue", "crm_approaching_sla", null],
    ["العملاء اللي قربوا يكسروا وقت الرد", "crm_approaching_sla", null],
    ["قربوا يعدوا", "crm_approaching_sla", null],
    ["Opened offer link without follow-up", "crm_opened_no_followup", null],
    ["اللي فتحوا اللينك ومفيش متابعة", "crm_opened_no_followup", null],
    ["شافوا العرض ومحدش تابع", "crm_opened_no_followup", null],

    // Scheduled viewings / showings
    ["Who has showing today?", "crm_viewings", null],
    ["Who has showing next week?", "crm_viewings", null],
    ["Who has showing last week?", "crm_viewings", null],
    ["Viewings today", "crm_viewings", null],
    ["Viewings tomorrow", "crm_viewings", null],
    ["معاينات النهارده", "crm_viewings", null],
    ["معاينات بكرة", "crm_viewings", null],
    ["مين عنده معاينة النهارده", "crm_viewings", null],
    ["جدول المعاينات", "crm_viewings", null],

    // Broker-specific queries
    ["How is Sara doing this week?", "crm_broker", null],
    ["How many showings does khaled has?", "crm_broker", null],
    ["What did Sara do today?", "crm_broker", null],
    ["تقييم سارة", "crm_broker", null],
    ["سارة عملت ايه", "crm_broker", null],
    ["أخبار سارة", "crm_broker", null],
    ["سارة قفلت كام", "crm_broker", null],
    ["خالد عنده كام معاينة", "crm_broker", null],

    // Team queries
    ["Omar's team this month", "crm_team", null],
    ["شغل فريق عمر", "crm_team", null],
    ["تيم عمر", "crm_team", null],

    // Discipline / silent / not responding
    ["Silent brokers", "crm_discipline", null],
    ["inactive brokers", "crm_discipline", null],
    ["who isn't updating?", "crm_discipline", null],
    ["الوسطاء اللي مش بيردوا", "crm_discipline", null],
    ["البروكرز اللي مش بيردوا", "crm_discipline", null],
    ["مين مش بيرد", "crm_discipline", null],
    ["مين مش بيتابع", "crm_discipline", null],
    ["مبيردوش", "crm_discipline", null],
    ["مبيحدثوش", "crm_discipline", null],
    ["مين مش بيحدث", "crm_discipline", null],

    // Response time & no next step
    ["Average response time", "crm_response_time", null],
    ["speed to lead", "crm_response_time", null],
    ["متوسط وقت الرد", "crm_response_time", null],
    ["سرعة الرد", "crm_response_time", null],
    ["بنرد في قد ايه", "crm_response_time", null],
    ["أسرع رد", "crm_response_time", null],
    ["أبطأ رد", "crm_response_time", null],
    ["Brokers with no next step", "crm_stuck_brokers", null],
    ["الوسطاء اللي عندهم عملاء بدون خطوة جاية", "crm_stuck_brokers", null],
    ["عملاء من غير خطوة", "crm_stuck_brokers", null],

    // Agency brief, deals, commissions, sources, win/loss, leases
    ["Agency brief", "crm_brief", null],
    ["how are we doing?", "crm_brief", null],
    ["ملخص الشركة", "crm_brief", null],
    ["حالة الشركة", "crm_brief", null],
    ["الوضع ايه", "crm_brief", null],
    ["Resale deals this month", "crm_deals", null],
    ["Primary deals", "crm_deals", null],
    ["صفقات الريسيل", "crm_deals", null],
    ["صفقات برايمري", "crm_deals", null],
    ["Developer commissions due", "crm_commissions", null],
    ["عمولات المطورين", "crm_commissions", null],
    ["Lead sources performance", "crm_sources", null],
    ["فيسبوك", "crm_sources", null],
    ["أحسن مصدر", "crm_sources", null],
    ["العملاء جايين منين", "crm_sources", null],
    ["Win / loss reasons", "crm_win_loss", null],
    ["أسباب الخسارة", "crm_win_loss", null],
    ["ليه بنخسر", "crm_win_loss", null],
    ["Leases ending soon", "crm_leases", null],
    ["عقود إيجار قربت تخلص", "crm_leases", null],

    // Unit search & Primary (must stay distinct)
    ["3 bedroom apartment in New Cairo under 9M", "unit_search", null],
    ["شقة 3 غرف في التجمع تحت 9 مليون", "unit_search", null],
    ["فيلا للبيع في زايد", "unit_search", null],
    ["Primary apartments in New Cairo", "primary", null],
    ["برايمري شقة في التجمع", "primary", null],

    // Unrecognized questions must clarify (never jump to Primary or unit search)
    ["Who won the match?", "clarify", null],
    ["What is the weather?", "clarify", null],
    ["مين كسب الماتش؟", "clarify", null],
    ["ليه الدنيا حر؟", "clarify", null]
  ];

  test.each(cases)("%s -> %s", (text, expectedRoute, expectedQueue) => {
    const res = Router.classifyAssistantQuery({ text, mode: "auto" });
    expect(res.route).toBe(expectedRoute);
    if (expectedQueue) expect(res.queueHint).toBe(expectedQueue);
  });
});
