// domain/assistantSuggestions.js — Pure follow-up chips for the in-app assistant. Rules only, no AI.
// Every `q` must be a question domain/assistantRouter already routes (tests/unit/assistant-suggestions.test.js proves it).
"use strict";

// id -> [labelAr, qAr, labelEn, qEn, flags]. flags: t = needs a team (manager/team lead, not solo), d = data entry may use it.
const POOL = {
  cheapest: ["الأرخص الأول", "شقق الأرخص الأول", "Cheapest first", "apartments cheapest first", "d"],
  units: ["شقق ٣ غرف في التجمع", "شقة ٣ غرف في التجمع", "3-bed in New Cairo", "3 bedroom apartment in New Cairo", "d"],
  villa: ["فيلا في الساحل", "فيلا في الساحل", "Villas on the coast", "villa in north coast", "d"],
  nophoto: ["وحدات من غير صور", "وحدات من غير صور", "Units without photos", "units without photos", "d"],
  count: ["كام شقة متاحة؟", "كام شقة متاحة", "How many apartments?", "how many apartments", ""],
  projects: ["شوف المشاريع الجديدة", "مشاريع جديدة", "See new projects", "new projects", ""],
  brief: ["ملخص النهارده", "ملخص النهارده", "Today's summary", "today's summary", ""],
  waiting: ["عملاء مستنين أكتر من ساعة", "عملاء مستنين أكتر من ساعة", "Leads waiting 1h+", "leads waiting over 1h", ""],
  overdue: ["متابعات متأخرة", "متابعات متأخرة", "Overdue follow-ups", "overdue follow-ups", ""],
  unassigned: ["عملاء من غير وسيط", "عملاء من غير وسيط", "Unassigned leads", "unassigned leads", "t"],
  viewings: ["معاينات النهارده", "معاينات النهارده", "Viewings today", "viewings today", ""],
  stuck: ["عملاء من غير خطوة جاية", "عملاء من غير خطوة جاية", "No next step", "leads with no next step", "t"],
  slowest: ["مين أبطأ بروكر؟", "مين أبطأ واحد بيرد", "Slowest broker?", "slowest response time", "t"],
  discipline: ["مين مش بيحدّث؟", "مين مش بيحدث", "Who isn't updating?", "who is not updating", "t"],
  deals: ["صفقات الشهر ده", "صفقات الشهر ده", "Deals this month", "deals this month", ""],
  lastMonth: ["قارن بالشهر اللي فات", "صفقات الشهر اللي فات", "Compare with last month", "deals last month", ""],
  sources: ["أحسن مصدر للعملاء", "أحسن مصدر للعملاء", "Best lead source", "best lead source", ""],
  winloss: ["ليه بنخسر؟", "ليه بنخسر الصفقات", "Why do we lose?", "win rate", ""],
  commissions: ["العمولات", "عمولات المطورين", "Commissions", "developer commissions", ""],
  leases: ["إيجارات هتخلص", "ايجارات هتخلص", "Leases ending", "leases ending soon", ""]
};

// Next steps per answered intent, best first. Defaults per role fill the rest up to 3.
const NEXT = {
  unit_search: ["cheapest", "projects", "count"],
  inventory_count: ["units", "cheapest", "projects"],
  primary: ["units", "count", "villa"],
  crm_leads: ["overdue", "unassigned", "viewings"],
  crm_opened_no_followup: ["waiting", "overdue", "viewings"],
  crm_approaching_sla: ["waiting", "unassigned", "slowest"],
  crm_stuck_brokers: ["slowest", "discipline", "waiting"],
  crm_response_time: ["lastMonth", "stuck", "waiting"],
  crm_discipline: ["slowest", "stuck", "waiting"],
  crm_broker: ["lastMonth", "slowest", "deals"],
  crm_team: ["lastMonth", "slowest", "deals"],
  crm_brief: ["waiting", "deals", "sources"],
  crm_deals: ["lastMonth", "commissions", "winloss"],
  crm_commissions: ["deals", "lastMonth", "winloss"],
  crm_win_loss: ["sources", "lastMonth", "deals"],
  crm_sources: ["winloss", "deals", "lastMonth"],
  crm_leases: ["brief", "deals", "viewings"],
  crm_viewings: ["waiting", "overdue", "brief"]
};
const DEFAULTS = {
  manager: ["brief", "waiting", "units", "deals"],
  team_lead: ["brief", "waiting", "units", "viewings"],
  broker: ["brief", "waiting", "units", "viewings"],
  data_entry: ["nophoto", "units", "villa", "cheapest"]
};
const ROLES = ["owner", "manager", "team_lead", "broker", "data_entry"];

/** kind "none" = a unit search with no results: offer wider paths first. */
function suggestionsFor({ intent, kind, role, lang, solo, context } = {}) {
  const en = lang === "en";
  const r = role === "owner" ? "manager" : DEFAULTS[role] ? role : "broker";
  const de = r === "data_entry";
  const base = kind === "none" ? ["projects", "count", "villa"] : NEXT[intent] || [];
  const out = [];
  for (const id of [...base, ...DEFAULTS[r]]) {
    const [la, qa, le, qe, flags] = POOL[id];
    if (out.some((s) => s.id === id) || (de && !flags.includes("d")) || (solo && flags.includes("t"))) continue;
    let q = en ? qe : qa;
    const orig = String(context?.originalQuery || "").trim();
    if (id === "cheapest" && orig) q = `${orig} ${en ? "cheapest first" : "الأرخص الأول"}`;
    out.push({ id, label: en ? le : la, q });
    if (out.length === 3) break;
  }
  return out.map(({ label, q }) => ({ label, q }));
}

module.exports = { suggestionsFor, ROLES, NEXT, POOL };
