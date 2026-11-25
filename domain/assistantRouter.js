// domain/assistantRouter.js — Pure, zero-DB deterministic query router & Cairo window parser for POST /api/v1/assistant/query.
// Evaluates CRM/owner metrics, team/broker activity, response times, viewings & unit signals before invoking AI.
"use strict";

const Stages = require("./leadStages");

const MODES = Object.freeze(["auto", "resale", "primary", "reports"]);
const DAY_MS = 24 * 3600 * 1000;

function normalize(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) & 15))
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[\u0640\u064b-\u065f]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Extracts a Cairo calendar window from natural EN/AR text, or null when unstated.
 */
function extractTimeWindow(raw, now = new Date()) {
  const q = normalize(raw);
  const cairoNow = Stages.toCairoLocal(now); // YYYY-MM-DDTHH:MM
  const dayStart = Stages.cairoDayAt(now, 0, 0);
  const tomorrowStart = Stages.cairoDayAt(now, 1, 0);
  const dayAfterStart = Stages.cairoDayAt(now, 2, 0);

  if (/\b(tomorrow)\b|بكره|غدا/.test(q)) {
    return { key: "tomorrow", since: tomorrowStart, until: dayAfterStart, labelEn: "Tomorrow", labelAr: "بكرة" };
  }
  if (/\b(today|this morning|so far)\b|النهارده|اليوم/.test(q)) {
    return { key: "today", since: dayStart, until: tomorrowStart, labelEn: "Today", labelAr: "النهارده" };
  }
  if (/\b(yesterday)\b|امبارح|امس/.test(q)) {
    return { key: "yesterday", since: Stages.cairoDayAt(now, -1, 0), until: dayStart, labelEn: "Yesterday", labelAr: "امبارح" };
  }
  if (/\b(this week|past 7|last 7|weekly)\b|الاسبوع ده|هذا الاسبوع|اخر 7 ايام|اسبوعيا/.test(q)) {
    return { key: "this_week", since: Stages.cairoDayAt(now, -6, 0), until: tomorrowStart, labelEn: "Last 7 days", labelAr: "آخر ٧ أيام" };
  }
  if (/\b(last week)\b|الاسبوع اللي فات|الاسبوع الماضي/.test(q)) {
    return { key: "last_week", since: Stages.cairoDayAt(now, -13, 0), until: Stages.cairoDayAt(now, -6, 0), labelEn: "Previous 7 days", labelAr: "الأسبوع اللي فات" };
  }
  if (/\b(last month)\b|الشهر اللي فات|الشهر الماضي/.test(q)) {
    const [y, m] = cairoNow.slice(0, 7).split("-").map(Number);
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const since = Stages.fromCairoLocal(`${py}-${String(pm).padStart(2, "0")}-01T00:00`);
    const until = Stages.fromCairoLocal(`${y}-${String(m).padStart(2, "0")}-01T00:00`);
    return { key: "last_month", since, until, labelEn: "Last month", labelAr: "الشهر اللي فات" };
  }
  if (/\b(this month)\b|الشهر ده|هذا الشهر/.test(q)) {
    const ym = cairoNow.slice(0, 7);
    const [y, m] = ym.split("-").map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return {
      key: "this_month",
      since: Stages.fromCairoLocal(`${ym}-01T00:00`),
      until: Stages.fromCairoLocal(`${ny}-${String(nm).padStart(2, "0")}-01T00:00`),
      labelEn: "This month",
      labelAr: "الشهر ده"
    };
  }
  return null;
}

const SOURCE_ALIASES = [
  ["Facebook", /\b(facebook|fb|meta)\b|فيسبوك|فيس بوك|ميتا/],
  ["Instagram", /\b(instagram|ig|insta)\b|انستجرام|انستا/],
  ["WhatsApp", /\b(whatsapp|wa)\b|واتساب/],
  ["TikTok", /\btiktok\b|تيك توك/],
  ["Google", /\bgoogle\b|جوجل/],
  ["OLX-Dubizzle", /\b(olx|dubizzle)\b|اوليكس|دوبيزل/],
  ["Property Finder", /\bproperty finder\b|بروبرتي فايندر/],
  ["Bayut", /\bbayut\b|بيوت/],
  ["Nawy", /\bnawy\b|نوي/],
  ["Referral", /\breferral\b|ترشيح/],
  ["Walk-in", /\bwalk[- ]?in\b|زياره المكتب/],
  ["Unit link", /\bunit link\b|لينك وحده/]
];

function extractSourceFilter(q) {
  for (const [canonical, re] of SOURCE_ALIASES) {
    if (re.test(q)) return canonical;
  }
  return null;
}

function stripWindowWords(raw) {
  return String(raw || "")
    .replace(/\b(today|tomorrow|yesterday|this week|last week|this month|last month|this morning|so far|past 7 days|last 7 days|weekly)\b/gi, "")
    .replace(/النهارده|اليوم|بكره|غدا|امبارح|امس|الاسبوع ده|هذا الاسبوع|الاسبوع اللي فات|الاسبوع الماضي|الشهر ده|هذا الشهر|الشهر اللي فات|الشهر الماضي|اخر 7 ايام|اسبوعيا/g, "")
    .replace(/\b(in|on|during|for|في|خلال)\s*$/i, "")
    .replace(/[؟?!.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const DISCIPLINE_RE = /\b(silent|discipline|updating|not updating|update rate|no updates|ghost)\b|مش بيحدث|تحديث التطبيق|الالتزام بالتحديث|مين مش شغال|مفيش تحديث/;
const COMMISSIONS_RE = /\b(commissions?|claimable|developer commission|collected)\b|عمولات|العموله|عموله المطور|مستحقه/;
const WAITING_RE = /waiting.*(?:1\s*h|hour)|over (?:an |1 )?hour|delayed first|مستن(?:ي|يين).*ساعه|اكتر من ساعه|تاخر اول تواصل/;
const UNASSIGNED_RE = /\bunassigned\b|without (?:a )?(?:broker|agent)|من غير وسيط|مش متوزع/;
const OVERDUE_RE = /\boverdue\b|متابعات متاخره|المتابعات اللي اتاخرت/;
const UNCONTACTED_RE = /\buncontacted\b|not contacted|محدش كلم/;
const RESPONSE_TIME_RE = /\b(response time|first response|reply time|avg response|average response|median response|fastest|slowest)\b|وقت الرد|متوسط الرد|اول رد|اسرع رد/;
const WIN_LOSS_RE = /\b(win ?loss|win rate|lost reasons?|why.*los(?:ing|t))\b|اسباب الخسار|معدل القفل|الخساير/;
const SOURCES_RE = /\b(sources?|facebook|fb|meta|instagram|tiktok|bayut|dubizzle|olx|property finder|nawy|marketing|ad spend|cpl|cpd|campaigns?)\b|مصادر|فيسبوك|فيس بوك|انستجرام|تسويق|اعلانات/;
const LEASES_RE = /\b(leases?|expiring|rent ending)\b|عقود الايجار|ايجارات قربت تخلص|ايجارات/;
const BRIEF_RE = /\b(dashboard|executive brief|agency brief|my stats|my summary|my performance|my activity|summary|overview|performance|stuck|activity)\b|ملخص(?:ي)?|احصائياتي|ادائي|شغلي|تقرير|لوحه الشركه|اداء الشركه/;

// Viewings scheduled today / tomorrow at agency/team level (not past broker activity query).
const SCHEDULED_VIEWINGS_RE = /\b(?:how many |what |list |any )?viewings? (?:do we have|are scheduled|we have|planned)? ?(?:today|tomorrow)?\b|عندنا كام معاين|معاينات (?:النهارده|بكره)/;

// Broker & team activity queries: "what did sara do today", "how many viewings did omar do this week", "calls by ali", "omar's team this week"
const TEAM_POSSESSIVE_RE = /^(?:what did |how did |how many (?:viewings?|calls?|updates?|leads?|deals?) did )?(.+?)(?:'s|’s)?\s+team(?:\s+do|\s+make|\s+close|\s+log)?(?:\s+(.+))?$/;
const TEAM_AR_RE = /^(?:شغل|اداء|تقييم|معاينات|مكالمات|تحديثات)?\s*فريق\s+(.+?)(?:\s+عمل ايه)?$/;
const BROKER_ACTIVITY_RE = /^(?:what did|how did|how many (?:viewings?|calls?|updates?|leads?|deals?) did|viewings? (?:by|for|of)|calls? (?:by|for|of)|updates? (?:by|for|of)|stats for|check on|how is|performance of|scorecard for|status of)\s+(.+?)(?:\s+(?:do|doing|make|have|get|log|close|completed))?$/;
const BROKER_ACTIVITY_AR_RE = /^(?:ايه اخبار|اداء|تقييم|شغل|معاينات|مكالمات|تحديثات)\s+(.+?)$/;
const BROKER_WORK_AR_RE = /^(.+?)\s+(?:عمل|سجل|كلم|حدث)\s+ايه/;
const AGENCY_DO_RE = /\b(?:what did (?:the )?(?:agency|we|everyone|team) do|how many (?:viewings?|calls?|updates?|leads?|deals?) (?:did )?(?:the )?(?:agency|we)|(?:agency|team) activity)\b|الشركه عملت ايه|عملنا ايه|كام (?:مكالمه|معاينه|تحديث|صفقه)/;

const PRIMARY_RE = /\b(primary|off[- ]plan|developer|payment plan|installments?|delivery|deliver|handover)\b|برايمري|برايمرى|اولي|مطور|انظمه سداد|تسهيلات|استلام|توصيل/;
const UNIT_RE = /\b(apartment|villa|townhouse|twin|duplex|penthouse|studio|chalet|resale|rent|sale|sqm|m2|bedroom|beds?|bath)\b|شقه|شقق|فيلا|دوبلكس|ستوديو|ريسيل|غرف|متر|مليون|تجمع|زايد|اكتوبر|مدينتي|رحاب|مراسي/;
const UNIT_CODE_RE = /\b[a-z]{1,4}-?\d{2,}\b/i;

function isGenericAgencySubject(s) {
  return /^(?:we|the|my|our|this|the agency|agency|our agency|us|everyone|everybody|company|all|الشركه|احنا|الفريق|فريقي|الكل|كلنا)$/i.test(stripWindowWords(s));
}

function crmRoute(q, raw, now = new Date()) {
  const windowInfo = extractTimeWindow(q, now);

  if (DISCIPLINE_RE.test(q)) return { route: "crm_discipline", windowInfo };
  if (COMMISSIONS_RE.test(q)) return { route: "crm_commissions", windowInfo };
  if (WAITING_RE.test(q)) return { route: "crm_leads", queueHint: "waiting-over-1h", windowInfo };
  if (UNASSIGNED_RE.test(q)) return { route: "crm_leads", queueHint: "unassigned", windowInfo };
  if (OVERDUE_RE.test(q)) return { route: "crm_leads", queueHint: "overdue", windowInfo };
  if (UNCONTACTED_RE.test(q)) return { route: "crm_leads", queueHint: "uncontacted", windowInfo };
  if (RESPONSE_TIME_RE.test(q)) return { route: "crm_response_time", windowInfo };
  if (WIN_LOSS_RE.test(q)) return { route: "crm_win_loss", windowInfo };
  if (SOURCES_RE.test(q)) return { route: "crm_sources", sourceFilter: extractSourceFilter(q), windowInfo };
  if (LEASES_RE.test(q)) return { route: "crm_leases", windowInfo };

  // Strip time words before extracting broker or team subject so "what did Sara do today" -> "Sara".
  const stripped = stripWindowWords(q);

  const teamEn = TEAM_POSSESSIVE_RE.exec(stripped);
  if (teamEn) {
    const subj = stripWindowWords(teamEn[1]);
    return { route: "crm_team", teamQuery: isGenericAgencySubject(subj) ? "" : subj, windowInfo };
  }
  const teamAr = TEAM_AR_RE.exec(stripped);
  if (teamAr) {
    const subj = stripWindowWords(teamAr[1]);
    return { route: "crm_team", teamQuery: isGenericAgencySubject(subj) ? "" : subj, windowInfo };
  }

  // Scheduled viewings today / tomorrow (only when NOT naming a specific broker and not a past-week activity summary).
  const isTodayOrTomorrow = windowInfo?.key === "today" || windowInfo?.key === "tomorrow";
  if (/\bviewings?\b|معاين/.test(q) && !/\bdid\b|\bby\b|عملها|عملت/.test(q) && (isTodayOrTomorrow || (!windowInfo && SCHEDULED_VIEWINGS_RE.test(q)))) {
    return { route: "crm_viewings", windowInfo: windowInfo || extractTimeWindow("today", now) };
  }

  const brokerEn = BROKER_ACTIVITY_RE.exec(stripped);
  if (brokerEn) {
    const subj = stripWindowWords(brokerEn[1]).replace(/\s+(?:do|doing|make|have|get|log|close|completed)$/i, "").trim();
    if (!subj || isGenericAgencySubject(subj)) return { route: "crm_brief", windowInfo };
    return { route: "crm_broker", brokerQuery: subj, windowInfo };
  }
  const brokerArWork = BROKER_WORK_AR_RE.exec(stripped);
  if (brokerArWork) {
    const subj = stripWindowWords(brokerArWork[1]);
    if (!subj || isGenericAgencySubject(subj)) return { route: "crm_brief", windowInfo };
    return { route: "crm_broker", brokerQuery: subj, windowInfo };
  }
  const brokerAr = BROKER_ACTIVITY_AR_RE.exec(stripped);
  if (brokerAr) {
    const subj = stripWindowWords(brokerAr[1]);
    if (!subj || isGenericAgencySubject(subj)) return { route: "crm_brief", windowInfo };
    return { route: "crm_broker", brokerQuery: subj, windowInfo };
  }

  if (AGENCY_DO_RE.test(q)) return { route: "crm_brief", windowInfo: windowInfo || extractTimeWindow("today", now) };
  if (BRIEF_RE.test(q)) return { route: "crm_brief", windowInfo };
  return null;
}

/**
 * Classifies one assistant query into an execution route.
 * Explicit modes (`resale`, `primary`, `reports`) lock routing strictly without cross-contamination.
 */
function classifyAssistantQuery({ text = "", mode = "auto", now = new Date() } = {}) {
  const safeMode = MODES.includes(mode) ? mode : "auto";
  const q = normalize(text);
  if (!q) return { route: "clarify" };

  if (safeMode === "resale") return { route: "unit_search" };
  if (safeMode === "primary") return { route: "primary" };
  if (safeMode === "reports") return crmRoute(q, text, now) || { route: "crm_brief", windowInfo: extractTimeWindow(q, now) };

  const crm = crmRoute(q, text, now);
  if (crm) return crm;

  if (PRIMARY_RE.test(q) && !/\bresale\b|ريسيل/.test(q)) return { route: "primary" };
  if (UNIT_RE.test(q) || UNIT_CODE_RE.test(q)) return { route: "unit_search" };
  if (/^(?:who|why|when|where|what|how|امتى|كام|ليه|ايه|مين)\b/.test(q)) return { route: "primary" };
  return { route: "unit_search" };
}

module.exports = { MODES, DAY_MS, normalize, extractTimeWindow, extractSourceFilter, classifyAssistantQuery };
