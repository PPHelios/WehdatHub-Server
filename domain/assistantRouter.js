// domain/assistantRouter.js — Pure, zero-DB deterministic query router & Cairo window parser for POST /api/v1/assistant/query.
// Evaluates CRM/owner metrics, team/broker activity, response times, viewings & unit signals before invoking AI.
"use strict";

const Stages = require("./leadStages");
const Phone = require("./phone");

const MODES = Object.freeze(["auto", "resale", "primary", "reports"]);
const DAY_MS = 24 * 3600 * 1000;
const MAX_RANGE_DAYS = 730;

const MONTHS = new Map([
  ["jan", 1], ["january", 1], ["يناير", 1],
  ["feb", 2], ["february", 2], ["فبراير", 2],
  ["mar", 3], ["march", 3], ["مارس", 3],
  ["apr", 4], ["april", 4], ["ابريل", 4],
  ["may", 5], ["مايو", 5],
  ["jun", 6], ["june", 6], ["يونيو", 6], ["يونيه", 6],
  ["jul", 7], ["july", 7], ["يوليو", 7], ["يوليه", 7],
  ["aug", 8], ["august", 8], ["اغسطس", 8],
  ["sep", 9], ["sept", 9], ["september", 9], ["سبتمبر", 9],
  ["oct", 10], ["october", 10], ["اكتوبر", 10],
  ["nov", 11], ["november", 11], ["نوفمبر", 11],
  ["dec", 12], ["december", 12], ["ديسمبر", 12]
]);
const MONTH_PATTERN = [...MONTHS.keys()].sort((a, b) => b.length - a.length).join("|");
const pad2 = (n) => String(n).padStart(2, "0");

function addCairoDaysYmd(ymd, deltaDays) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

function cairoMidnight(ymd) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const check = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== ymd) return null;
  let at = Stages.fromCairoLocal(`${ymd}T00:00`);
  if (!at) return null;
  // On Egypt's spring-forward midnight (00:00 -> 01:00), step forward to the first instant of Cairo day `ymd`.
  while (Stages.toCairoLocal(at).slice(0, 10) < ymd) {
    at = new Date(at.getTime() + 30 * 60 * 1000);
  }
  // On autumn fall-back, step back if an earlier UTC instant is already on Cairo day `ymd`.
  while (Stages.toCairoLocal(new Date(at.getTime() - 30 * 60 * 1000)).slice(0, 10) === ymd) {
    at = new Date(at.getTime() - 30 * 60 * 1000);
  }
  return Stages.toCairoLocal(at).slice(0, 10) === ymd ? at : null;
}

function cairoWeekdayMon0(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function makeWindow({ key, from, to, kind = "calendar", inclusiveEndCairoDate = null, labelEn, labelAr }) {
  return { key, from, to, since: from, until: to, kind, inclusiveEndCairoDate, labelEn, labelAr };
}

function resolveRangeFromYmds(key, startYmd, endInclusiveYmd, labelEn, labelAr, kind = "range") {
  const from = cairoMidnight(startYmd);
  const to = cairoMidnight(addCairoDaysYmd(endInclusiveYmd, 1));
  if (!from || !to || from >= to || (to.getTime() - from.getTime()) / DAY_MS > MAX_RANGE_DAYS) return null;
  return makeWindow({ key, from, to, kind, inclusiveEndCairoDate: endInclusiveYmd, labelEn, labelAr });
}

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
 * Extracts a strict Cairo [from, to) calendar interval from natural EN/AR text, or null when unstated.
 */
function extractTimeWindow(raw, now = new Date()) {
  const q = normalize(raw);
  const todayYmd = Stages.cairoDay(now);
  const todayStart = cairoMidnight(todayYmd);
  const tomorrowYmd = addCairoDaysYmd(todayYmd, 1);
  const tomorrowStart = cairoMidnight(tomorrowYmd);
  const [curY, curM] = todayYmd.split("-").map(Number);

  // 1. Explicit ISO range: 2026-11-01 to 2026-11-15 / من 2026-11-01 لـ 2026-11-15
  const isoRange = q.match(/\b(\d{4}-\d{2}-\d{2})\s*(?:-|–|—|to|through|لـ|ل|الي|حتي)\s*(\d{4}-\d{2}-\d{2})\b/);
  if (isoRange) {
    return resolveRangeFromYmds("custom_range", isoRange[1], isoRange[2], `${isoRange[1]} – ${isoRange[2]}`, `${isoRange[1]} – ${isoRange[2]}`);
  }

  // 2. Inclusive named-month day range: "1-15 Nov [2026]" / "من ١ لـ ١٥ نوفمبر" / "Nov 1-15"
  const dayFirst = q.match(new RegExp(`(?:^|\\s)(?:من\\s+)?(\\d{1,2})\\s*(?:-|–|—|to|through|لـ|ل|الي|حتي)\\s*(\\d{1,2})\\s+(${MONTH_PATTERN})(?:\\s+(\\d{4}))?(?=\\s|$|[؟?!.,])`));
  if (dayFirst) {
    const d1 = Number(dayFirst[1]);
    const d2 = Number(dayFirst[2]);
    const mNum = MONTHS.get(dayFirst[3]);
    let year = dayFirst[4] ? Number(dayFirst[4]) : curY;
    if (!dayFirst[4] && mNum > curM) year = curY - 1;
    const sYmd = `${year}-${pad2(mNum)}-${pad2(d1)}`;
    const eYmd = `${year}-${pad2(mNum)}-${pad2(d2)}`;
    return resolveRangeFromYmds("custom_range", sYmd, eYmd, `${sYmd} – ${eYmd}`, `${sYmd} – ${eYmd}`);
  }

  const monFirst = q.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})\\s*(?:-|–|—|to|through)\\s*(?:(${MONTH_PATTERN})\\s+)?(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?\\b`));
  if (monFirst) {
    const m1 = MONTHS.get(monFirst[1]);
    const d1 = Number(monFirst[2]);
    const m2 = monFirst[3] ? MONTHS.get(monFirst[3]) : m1;
    const d2 = Number(monFirst[4]);
    let endYear = monFirst[5] ? Number(monFirst[5]) : curY;
    if (!monFirst[5] && m2 > curM) endYear = curY - 1;
    const startYear = m1 > m2 ? endYear - 1 : endYear;
    const sYmd = `${startYear}-${pad2(m1)}-${pad2(d1)}`;
    const eYmd = `${endYear}-${pad2(m2)}-${pad2(d2)}`;
    return resolveRangeFromYmds("custom_range", sYmd, eYmd, `${sYmd} – ${eYmd}`, `${sYmd} – ${eYmd}`);
  }

  // 3. Open-anchor windows: "since yesterday", "من امبارح", "since today", "since 2026-11-10"
  if (/\b(?:since|from)\s+yesterday\b|من\s+(?:امبارح|امس)/.test(q)) {
    const yestYmd = addCairoDaysYmd(todayYmd, -1);
    return makeWindow({ key: "since_yesterday", from: cairoMidnight(yestYmd), to: now, kind: "open_end", inclusiveEndCairoDate: todayYmd, labelEn: "Since yesterday", labelAr: "من امبارح" });
  }
  if (/\b(?:since|from)\s+today\b|من\s+(?:النهارده|اليوم)/.test(q)) {
    return makeWindow({ key: "since_today", from: todayStart, to: now, kind: "open_end", inclusiveEndCairoDate: todayYmd, labelEn: "Since today", labelAr: "من النهارده" });
  }
  const sinceIso = q.match(/(?:\b(?:since|from)\s+|من\s+)(\d{4}-\d{2}-\d{2})\b/);
  if (sinceIso) {
    const start = cairoMidnight(sinceIso[1]);
    if (start && start < now && (now.getTime() - start.getTime()) / DAY_MS <= MAX_RANGE_DAYS) {
      return makeWindow({ key: "since_date", from: start, to: now, kind: "open_end", inclusiveEndCairoDate: todayYmd, labelEn: `Since ${sinceIso[1]}`, labelAr: `من ${sinceIso[1]}` });
    }
  }

  // 4. Rolling N hours / weeks / days
  const hrsMatch = q.match(/(?:\b(?:last|past)\s+(\d+)\s*h(?:ours?|rs?)?\b|(?:اخر|خلال)\s+(\d+)\s*(?:ساعه|ساعات))/);
  if (hrsMatch) {
    const n = Math.min(24 * MAX_RANGE_DAYS, Math.max(1, Number(hrsMatch[1] || hrsMatch[2])));
    return makeWindow({ key: `last_${n}h`, from: new Date(now.getTime() - n * 3600 * 1000), to: now, kind: "rolling", labelEn: `Last ${n} hours`, labelAr: `آخر ${n} ساعة` });
  }

  if (/\b(?:last|past)\s+2\s+weeks?\b|(?:اخر\s+اسبوعين|اسبوعين)/.test(q)) {
    const startYmd = addCairoDaysYmd(todayYmd, -13);
    return resolveRangeFromYmds("last_14d", startYmd, todayYmd, "Last 14 days", "آخر ١٤ يوم", "rolling");
  }
  const weeksMatch = q.match(/(?:\b(?:last|past)\s+(\d+)\s+weeks?\b|(?:اخر)\s+(\d+)\s*(?:اسبوع|اسابيع))/);
  if (weeksMatch) {
    const w = Math.min(104, Math.max(1, Number(weeksMatch[1] || weeksMatch[2])));
    const startYmd = addCairoDaysYmd(todayYmd, -(w * 7 - 1));
    return resolveRangeFromYmds(`last_${w * 7}d`, startYmd, todayYmd, `Last ${w} weeks`, `آخر ${w} أسابيع`, "rolling");
  }

  const daysMatch = q.match(/(?:\b(?:last|past)\s+(\d+)\s+days?\b|(?:اخر)\s+(\d+)\s*(?:يوم|ايام))/);
  if (daysMatch) {
    const d = Math.min(MAX_RANGE_DAYS, Math.max(1, Number(daysMatch[1] || daysMatch[2])));
    const startYmd = addCairoDaysYmd(todayYmd, -(d - 1));
    return resolveRangeFromYmds(`last_${d}d`, startYmd, todayYmd, d === 7 ? "Last 7 days" : `Last ${d} days`, `آخر ${d} أيام`, "rolling");
  }

  // 5. Calendar named presets (check multi-word week/month phrases before single-day words; keep Arabic امس word-bounded so it never matches الخامس).
  if (/\b(next week)\b|الاسبوع الجاي|الاسبوع القادم/.test(q)) {
    return resolveRangeFromYmds("next_week", todayYmd, addCairoDaysYmd(todayYmd, 7), "Next 7 days", "الأسبوع الجاي", "calendar");
  }
  if (/\b(this week|weekly)\b|الاسبوع ده|هذا الاسبوع|اسبوعيا/.test(q)) {
    const thisMonYmd = addCairoDaysYmd(todayYmd, -cairoWeekdayMon0(todayYmd));
    return resolveRangeFromYmds("this_week", thisMonYmd, todayYmd, "This week", "الأسبوع ده", "calendar");
  }
  if (/\b(last week)\b|الاسبوع اللي فات|الاسبوع الماضي/.test(q)) {
    const thisMonYmd = addCairoDaysYmd(todayYmd, -cairoWeekdayMon0(todayYmd));
    const prevMonYmd = addCairoDaysYmd(thisMonYmd, -7);
    const prevSunYmd = addCairoDaysYmd(thisMonYmd, -1);
    return resolveRangeFromYmds("last_week", prevMonYmd, prevSunYmd, "Last week", "الأسبوع اللي فات", "calendar");
  }
  if (/\b(last month)\b|الشهر اللي فات|الشهر الماضي/.test(q)) {
    const py = curM === 1 ? curY - 1 : curY;
    const pm = curM === 1 ? 12 : curM - 1;
    const thisMonth01 = `${curY}-${pad2(curM)}-01`;
    const prevMonth01 = `${py}-${pad2(pm)}-01`;
    return resolveRangeFromYmds("last_month", prevMonth01, addCairoDaysYmd(thisMonth01, -1), "Last month", "الشهر اللي فات", "calendar");
  }
  if (/\b(this month)\b|الشهر ده|هذا الشهر/.test(q)) {
    const ny = curM === 12 ? curY + 1 : curY;
    const nm = curM === 12 ? 1 : curM + 1;
    const thisMonth01 = `${curY}-${pad2(curM)}-01`;
    const nextMonth01 = `${ny}-${pad2(nm)}-01`;
    return resolveRangeFromYmds("this_month", thisMonth01, addCairoDaysYmd(nextMonth01, -1), "This month", "الشهر ده", "calendar");
  }
  if (/\b(tomorrow)\b|(?:^|\s)(?:بكره|غدا)(?=\s|[؟?!.,]|$)/.test(q)) {
    return makeWindow({ key: "tomorrow", from: tomorrowStart, to: cairoMidnight(addCairoDaysYmd(todayYmd, 2)), inclusiveEndCairoDate: tomorrowYmd, labelEn: "Tomorrow", labelAr: "بكرة" });
  }
  if (/\b(today|this morning|so far)\b|(?:^|\s)(?:النهارده|اليوم)(?=\s|[؟?!.,]|$)/.test(q)) {
    return makeWindow({ key: "today", from: todayStart, to: tomorrowStart, inclusiveEndCairoDate: todayYmd, labelEn: "Today", labelAr: "النهارده" });
  }
  if (/\b(yesterday)\b|(?:^|\s)(?:امبارح|امس)(?=\s|[؟?!.,]|$)/.test(q)) {
    const yestYmd = addCairoDaysYmd(todayYmd, -1);
    return makeWindow({ key: "yesterday", from: cairoMidnight(yestYmd), to: todayStart, inclusiveEndCairoDate: yestYmd, labelEn: "Yesterday", labelAr: "امبارح" });
  }
  return null;
}

/**
 * Validates explicit API [from, to) bounds or resolves fallback N Cairo calendar days.
 * Explicit `from` / `to` always take precedence over legacy `days` / `period`. Date-only `to` is inclusive.
 */
function resolveInterval({ from = null, to = null, days = 30, now = new Date(), maxDays = MAX_RANGE_DAYS } = {}) {
  const todayYmd = Stages.cairoDay(now);
  if (from || to) {
    const parseBound = (v, isEnd) => {
      const s = String(v || "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return cairoMidnight(isEnd ? addCairoDaysYmd(s, 1) : s);
      }
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const fromDt = from ? parseBound(from, false) : cairoMidnight(addCairoDaysYmd(todayYmd, -Math.max(1, Number(days) || 30) + 1));
    const toDt = to ? parseBound(to, true) : cairoMidnight(addCairoDaysYmd(todayYmd, 1));
    if (!fromDt || !toDt || fromDt >= toDt) return { error: "invalid_range" };
    if ((toDt.getTime() - fromDt.getTime()) / DAY_MS > maxDays) return { error: "range_too_large" };
    return { from: fromDt, to: toDt, since: fromDt, until: toDt, kind: "explicit" };
  }
  const n = Math.min(maxDays, Math.max(1, Number(days) || 30));
  const fromDt = cairoMidnight(addCairoDaysYmd(todayYmd, -(n - 1)));
  const toDt = cairoMidnight(addCairoDaysYmd(todayYmd, 1));
  return { from: fromDt, to: toDt, since: fromDt, until: toDt, kind: "days" };
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
    .replace(new RegExp(`(?:من\\s+)?\\d{1,2}\\s*(?:-|–|—|to|through|لـ|ل|الي|حتي)\\s*\\d{1,2}\\s+(?:${MONTH_PATTERN})(?:\\s+\\d{4})?`, "gi"), "")
    .replace(new RegExp(`\\b(?:${MONTH_PATTERN})\\s+\\d{1,2}\\s*(?:-|–|—|to|through)\\s*(?:(?:${MONTH_PATTERN})\\s+)?\\d{1,2}(?:\\s*,?\\s*\\d{4})?\\b`, "gi"), "")
    .replace(/\b\d{4}-\d{2}-\d{2}\s*(?:-|–|—|to|through|لـ|ل|الي|حتي)\s*\d{4}-\d{2}-\d{2}\b/gi, "")
    .replace(/\b(?:since|from)\s+(?:yesterday|today|\d{4}-\d{2}-\d{2})\b|من\s+(?:امبارح|امس|النهارده|اليوم|\d{4}-\d{2}-\d{2})/gi, "")
    .replace(/\b(?:last|past)\s+\d+\s+(?:h(?:ours?|rs?)?|days?|weeks?)\b|(?:اخر|خلال)\s+\d+\s*(?:ساعه|ساعات|يوم|ايام|اسبوع|اسابيع|اسبوعين)/gi, "")
    .replace(/\b(today|tomorrow|yesterday|this week|last week|last 2 weeks|this month|last month|this morning|so far|past 7 days|last 7 days|weekly)\b/gi, "")
    .replace(/الاسبوع ده|هذا الاسبوع|الاسبوع اللي فات|الاسبوع الماضي|اخر اسبوعين|اسبوعين|الشهر ده|هذا الشهر|الشهر اللي فات|الشهر الماضي|اخر 7 ايام|اسبوعيا/g, "")
    .replace(/(?:^|\s)(?:النهارده|اليوم|بكره|غدا|امبارح|امس)(?=\s|[؟?!.,]|$)/g, "")
    .replace(/\b(in|on|during|for|في|خلال)\s*$/i, "")
    .replace(/[؟?!.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const DISCIPLINE_RE = /\b(silent|discipline|updating|not updating|update rate|no updates|ghost|inactive brokers?|quiet brokers?|who isn'?t updating|who is not updating)\b|مش بيحدث|مبيحدثش|مبيحدثوش|تحديث التطبيق|الالتزام بالتحديث|التزام الفريق|تحديثات الوسطاء|(?:الوسطاء|البروكرز) (?:اللي مش بيردوا|الصامتين)|اللي مش بيردوا|مش بيردوا|مبيردوش|مش بيتابعوا|مبيتابعوش|مين مش (?:شغال|بيرد|بيتابع)|مين ساحب|مين نايم|مفيش تحديث/;
const COMMISSIONS_RE = /\b(commissions?|claimable|developer commission|collected|pending commissions?)\b|عمولات|العموله|عمولاتي|عموله المطور|مستحقات المطورين|فلوس المطورين|مستحقه/;
const WAITING_RE = /waiting.*(?:1\s*h|hour|contact|called)|over (?:an |1 )?hour|delayed (?:first|reply)|late first contact|no first contact|haven'?t been called|waiting\s*(?:for\s*)?(?:a\s*)?reply|مستن(?:ي|يين).*(?:ساعه|تواصل|حد يكلمهم)|مستن(?:ي|يين)\s*رد|اكتر من ساعه|عدي ساعه|تاخر اول تواصل|تاخير اول تواصل|ات[اأ]خر(?:وا)? في اول تواصل|ات[اأ]خرنا عليهم|محدش رد عليهم/;
const UNASSIGNED_RE = /\bunassigned\b|\bunallocated\b|not assigned|no broker|without (?:a )?(?:broker|agent|owner)|need(?:s)? (?:a )?broker|(?:من غير|بدون) (?:وسيط|بروكر|سيلز|حد)|مش متوزع|لسه متوزعوش|مش متسلم|لسه متسلموش|مفيش حد مسكهم|محدش استلمهم|محدش مسكهم|ملهمش (?:وسيط|بروكر)/;
const OVERDUE_RE = /\boverdue\b|(?:missed|late|pending) follow[ -]?ups?|(?:عملاء|العملاء|متابعات|المتابعات)\s*(?:ال)?متاخر(?:ين|ه)|متابعات (?:متاخره|فايته|عدت)|المتابعات اللي اتاخرت|عملاء عد[ىي] ميعادهم|مين متاخر في المتابعه/;
const UNCONTACTED_RE = /\buncontacted\b|not contacted|never contacted|no contact yet|not called yet|nobody called|haven'?t called|محدش كلم|لسه متكلموش|لسه محدش تواصل|محدش اتصل بيهم|لسه مفيش مكالمه/;
const OPENED_NO_FU_RE = /(?:offer\s*links?|links?).*(?:opened|clicked|viewed).*(?:without|no)\s*follow|(?:opened|clicked|viewed)\s*(?:offer\s*)?links?.*(?:without|no)\s*follow|فتح(?:وا)?\s*(?:ال)?(?:لينك|الرابط|العرض).*(?:مفيش|بدون|محدش)\s*(?:متابع|كلم)|شافوا العرض ومحدش تابع/;
const APPROACHING_SLA_RE = /\bapproaching\s*sla\b|close\s*to\s*sla|near\s*sla|sla\s*soon|about\s*to\s*breach|almost\s*overdue|قربوا\s*(?:علي|يكسروا|يعدوا|يخلصوا|يتاخروا)\s*(?:sla|وقت\s*الرد|المهله)?/;
const STUCK_BROKERS_RE = /\b(?:brokers?|agents?|leads?)\b.*(?:no|missing)\s*next\s*step|ranked\s*by\s*no\s*next\s*step|no\s*follow[ -]?up\s*scheduled|بدون\s*(?:خطوه\s*جايه|متابعه\s*جايه)|من\s*غير\s*خطوه|مفيش\s*خطوه\s*جايه/;
const RESPONSE_TIME_RE = /\b(response time|first response|reply time|avg response|average response|median response|fastest|slowest|who replied|who responded|speed to lead)\b|how fast.*(?:respond|reply)|وقت الرد|متوسط الرد|اول رد|اسرع (?:رد|واحد بيرد)|ابط[اأ] (?:رد|واحد بيرد)|سرعه الرد|بنرد في قد ايه|مين رد/;
const WIN_LOSS_RE = /\b(win\s*\/?\s*loss|win rate|conversion rate|closing rate|lost reasons?|why.*los(?:ing|t))\b|اسباب الخسار|ليه بنخسر|الصفقات اللي ضاعت|معدل القفل|نسبه القفل|نسبه النجاح|الخساير/;
const SOURCES_RE = /\b(sources?|facebook|fb|meta|instagram|tiktok|google|olx|dubizzle|bayut|property finder|nawy|marketing|ad spend|cpl|cpd|campaigns?|best lead source|marketing roi)\b|where are leads coming from|مصادر|احسن مصدر|افضل مصدر|العملاء جايين منين|فيسبوك|فيس بوك|انستجرام|تيك توك|جوجل|اوليكس|دوبيزل|بروبرتي|بيوت|نوي|تسويق|اعلانات/;
const LEASES_RE = /\b(leases?|expiring|rent ending|renewals?)\b|عقود (?:ال)?ايجار|ايجارات (?:قربت|هت)تخلص|ايجارات|تجديد الايجار/;
const BRIEF_RE = /\b(dashboard|executive brief|agency brief|daily brief|my stats|my summary|my performance|my activity|summary|overview|performance|stuck|activity|how are we doing|today'?s summary|what happened today)\b|ملخص(?:ي)?|احصائياتي|ادائي|شغلي|تقرير(?: اليوم)?|لوحه الشركه|اداء الشركه|حاله الشركه|وضع الشركه|اخبار الشركه|الوضع ايه/;

// Viewings scheduled today / tomorrow at agency/team level (not past broker activity query).
const SCHEDULED_VIEWINGS_RE = /\b(?:how many |what |list |any |upcoming |scheduled )?(?:viewings?|showings?) (?:do we have|are scheduled|we have|planned)? ?(?:today|tomorrow)?\b|\bwho has (?:a )?(?:showing|viewing)\b|عندنا (?:كام )?معاين|معاينات (?:النهارده|بكره|امتي)|مين عنده معاينه|جدول المعاينات/;

// Broker & team activity queries: "what did sara do today", "how many viewings did omar do this week", "calls by ali", "omar's team this week"
const TEAM_POSSESSIVE_RE = /^(?:what did |how did |how many (?:viewings?|calls?|updates?|leads?|deals?) did )?(.+?)(?:'s|’s)?\s+team(?:\s+do|\s+make|\s+close|\s+log)?(?:\s+(.+))?$/;
const TEAM_AR_RE = /^(?:شغل|اداء|تقييم|ملخص|اخبار|احصائيات|معاينات|مكالمات|تحديثات)?\s*(?:فريق|تيم)\s+(.+?)(?:\s+عمل(?:ت)? ايه)?$/;
const BROKER_ACTIVITY_RE = /^(?:what (?:did|has)|how did|how many (?:viewings?|showings?|calls?|updates?|leads?|deals?) (?:did|does|do)|(?:viewings?|showings?) (?:by|for|of)|calls? (?:by|for|of)|updates? (?:by|for|of)|stats for|summary for|report for|check on|how is|performance of|scorecard for|status of)\s+(.+?)(?:\s+(?:do|doing|done|have|has|make|get|log|close|completed))?$/;
const BROKER_ACTIVITY_AR_RE = /^(?:ايه اخبار|اخبار|اداء|تقييم|شغل|ملخص|احصائيات|نتايج|ارقام|معاينات|مكالمات|تحديثات)\s+(.+?)$/;
const BROKER_WORK_AR_RE = /^(.+?)\s+(?:عمل|عملت|سجل|سجلت|كلم|كلمت|حدث|حدثت|قفل|قفلت|جاب|جابت|عنده|عندها|اخباره|اخبارها)\s*(?:ايه|كام)?/;
const AGENCY_DO_RE = /\b(?:what did (?:the )?(?:agency|we|everyone|team) do|how many (?:viewings?|calls?|updates?|leads?|deals?) (?:did )?(?:the )?(?:agency|we)|(?:agency|team) activity)\b|الشركه عملت ايه|عملنا ايه|كام (?:مكالمه|معاينه|تحديث|صفقه)/;

const PRIMARY_EXPLICIT_RE = /\b(primary|off[- ]plan|developer|developers|projects?|launch(?:es)?)\b|برايمر[ي]|اولي|مطور(?:ين)?|مشروع|مشاريع/;
const PRIMARY_WEAK_RE = /\b(payment plan|installments?|delivery|deliver|handover)\b|انظمه سداد|تسهيلات|استلام|توصيل|اقساط|قسط|مقدم/;
const PRIMARY_RE = new RegExp(`${PRIMARY_EXPLICIT_RE.source}|${PRIMARY_WEAK_RE.source}`);
const AMBIGUOUS_FINANCE_RE = /\b(down ?payment|installments?|monthly)\b|مقدم|قسط|اقساط|تقسيط/;
const RESALE_EXPLICIT_RE = /\bresale\b|ريسيل|اعاده البيع/;
const EXCLUDE_PRIMARY_RE = /(?:^|\s)(?:no|not|exclude|without)\s+(?:primary|developers?|projects?)\b|مفيش\s+برايمر[ي]|بدون\s+برايمر[ي]|مش\s+برايمر[ي]|غير\s+برايمر[ي]/;
const EXCLUDE_RESALE_RE = /(?:^|\s)(?:no|not|exclude|without)\s+resale\b|مفيش\s+ريسيل|بدون\s+ريسيل|مش\s+ريسيل|غير\s+ريسيل/;
const UNIT_RE = /\b(apartment|villa|townhouse|twin|duplex|penthouse|studio|chalet|resale|rent|sale|sqm|m2|bedroom|beds?|bath)\b|شقه|شقق|فيلا|فلل|دوبلكس|ستوديو|ريسيل|غرف|متر|مليون|تجمع|زايد|اكتوبر|مدينتي|رحاب|مراسي/;
const UNIT_CODE_RE = /\b[a-z]{1,4}-?\d{2,}\b/i;
const INVENTORY_COUNT_RE = /^(?:how many|count|total)\s+(?:available\s+)?(?:apartments?|villas?|units?|listings?|properties|studios?|duplex(?:es)?|townhouses?|penthouses?|chalets?)\b|^(?:كام|كم|عدد)\s+(?:شقه|شقق|فيلا|فلل|وحده|وحدات|دوبلكس|ستوديو|تاون|توين|بنتهاوس|شاليه)/;
// Clearly not real estate. Guarded by UNIT_RE/PRIMARY_EXPLICIT_RE so "شقة قريبة من النادي" or a Zamalek flat still search.
const OFF_TOPIC_RE = /\b(?:weather|forecast|temperature outside|football|soccer|match scores?|who won the (?:match|game)|world cup|premier league|jokes?|recipes?|how to cook|prayer times?|adhan|azan|(?:latest|breaking|today'?s) news|news headlines)\b|الطقس|درجه الحراره|الجو (?:ايه|عامل|حر|برد)|هتمطر|ماتش|كوره|نتيجه (?:الماتش|المباراه)|مباراه|(?:^|\s)(?:نكته|نكت)(?:\s|$)|اضحكني|وصفه|طريقه (?:عمل|تحضير|طبخ)|مواقيت الصلاه|مواعيد الصلاه|الاذان|اخبار (?:مصر|العالم|السياسه|الكوره|الفن)|نشره الاخبار/;
const GREETING_RE = /^(?:hi|hello|hey|hola|good (?:morning|evening)|how are you|thanks|thank you|ازيك|ازايك|اخبارك|عامل ايه|عامله ايه|صباح الخير|مساء الخير|السلام عليكم|اهلا|اهلا وسهلا|مرحبا|هاي|شكرا|تسلم)(?:\s+(?:ايه|there|bot|assistant|team|all|everyone|باشا|ورحمه الله|يا\s+\S+))*$/;
const DEALS_RE = /\bdeals?\b|صفقات|صفقه/;

function parseMarketSignals(q) {
  const exclusions = [];
  if (EXCLUDE_PRIMARY_RE.test(q)) exclusions.push("primary");
  if (EXCLUDE_RESALE_RE.test(q)) exclusions.push("resale");
  const strippedExcl = q
    .replace(/(?:^|\s)(?:no|not|exclude|without)\s+(?:primary|developers?|projects?|resale)\b/g, " ")
    .replace(/(?:مفيش|بدون|مش|غير)\s+(?:برايمر[ي]|ريسيل)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const hasResale = RESALE_EXPLICIT_RE.test(strippedExcl);
  const hasPrimary = PRIMARY_EXPLICIT_RE.test(strippedExcl);
  let market = null;
  if (exclusions.includes("primary") || (hasResale && !hasPrimary)) market = "resale";
  else if (exclusions.includes("resale") || (hasPrimary && !hasResale)) market = "primary";
  return { market, exclusions, hasResale, hasPrimary, hasBothExplicit: hasResale && hasPrimary };
}

function parseDealQuery(q, raw, now) {
  const windowInfo = extractTimeWindow(q, now);
  const { market, exclusions } = parseMarketSignals(q);
  const stripped = stripWindowWords(q);
  const brokerRole = /\b(involved|split|shared|participat)\b|شارك|مشترك|سبليت/.test(q) ? "participant" : "closer";

  let brokerQuery = null;
  const brEn1 = stripped.match(/\bclosed by\s+([a-z\u0621-\u064a]+(?:\s+[a-z\u0621-\u064a]+)?)(?:\s+(?:in|on|during|for)\b|$)/i);
  const brEn2 = stripped.match(/\bdeals?\s+([a-z\u0621-\u064a]+?(?:\s+[a-z\u0621-\u064a]+?)?)\s+(?:was|were|is)\s+(?:involved|closed|made)\b/i)
    || stripped.match(/\bdeals?\s+([a-z\u0621-\u064a]+?(?:\s+[a-z\u0621-\u064a]+?)?)\s+(?:involved|closed|made)\b/i);
  const brEn3 = stripped.match(/\bdeals?\s+(?:for|by)\s+([a-z\u0621-\u064a]+(?:\s+[a-z\u0621-\u064a]+)?)(?:\s+(?:in|on|during)\b|$)/i);
  const brAr = stripped.match(/(?:^|\s)(?:قفلها|شارك فيها|لـ|ل)\s+([a-z\u0621-\u064a]+)(?:\s+(?:في|خلال)\b|$)/i);
  const rawBroker = brEn1?.[1] || brEn2?.[1] || brEn3?.[1] || brAr?.[1] || null;
  if (rawBroker && !isGenericAgencySubject(rawBroker)) brokerQuery = rawBroker.trim();

  let areaQuery = null;
  const arEn = stripped.match(/\bin\s+([a-z\u0621-\u064a]+(?:\s+[a-z\u0621-\u064a]+)?)$/i);
  const arAr = stripped.match(/\bفي\s+([a-z\u0621-\u064a]+(?:\s+[a-z\u0621-\u064a]+)?)$/i);
  const candArea = (arEn?.[1] || arAr?.[1] || "").trim();
  if (candArea && !/\b(resale|primary|deals?|involved)\b|ريسيل|برايمر/.test(candArea)) {
    areaQuery = candArea;
  }

  return {
    route: "crm_deals",
    job: "deals_report",
    market,
    exclusions,
    brokerQuery,
    brokerRole,
    areaQuery,
    windowInfo
  };
}

function isGenericAgencySubject(s) {
  return /^(?:we|the|my|our|this|the agency|agency|our agency|us|everyone|everybody|company|all|الشركه|احنا|الفريق|فريقي|الكل|كلنا)$/i.test(stripWindowWords(s));
}

// "prices in New Cairo" / "اسعار في التجمع": letters only, so "prices in X under 5m" stays a unit search.
const PRICES_IN_RE = /^(?:(?:what(?:s| is| are)? )?(?:the )?(?:average )?prices? (?:in|of|for)|اسعار(?: الوحدات| الشقق)? (?:في|ب)) ([a-zء-ي]+(?: [a-zء-ي]+)?)$/;

function crmRoute(q, raw, now = new Date()) {
  const windowInfo = extractTimeWindow(q, now);

  const pricesIn = q.replace(/[؟?!.,،]+/g, " ").replace(/\s+/g, " ").trim().match(PRICES_IN_RE);
  if (pricesIn) return { route: "crm_prices", job: "prices", areaQuery: pricesIn[1], windowInfo: null };

  if (DISCIPLINE_RE.test(q)) return { route: "crm_discipline", windowInfo };
  if (OPENED_NO_FU_RE.test(q)) return { route: "crm_opened_no_followup", windowInfo };
  if (APPROACHING_SLA_RE.test(q)) return { route: "crm_approaching_sla", windowInfo };
  if (STUCK_BROKERS_RE.test(q)) return { route: "crm_stuck_brokers", windowInfo };
  if (COMMISSIONS_RE.test(q)) return { route: "crm_commissions", windowInfo };
  if (WAITING_RE.test(q)) return { route: "crm_leads", queueHint: "waiting-over-1h", windowInfo };
  if (UNASSIGNED_RE.test(q)) return { route: "crm_leads", queueHint: "unassigned", windowInfo };
  if (OVERDUE_RE.test(q)) return { route: "crm_leads", queueHint: "overdue", windowInfo };
  if (UNCONTACTED_RE.test(q)) return { route: "crm_leads", queueHint: "uncontacted", windowInfo };
  if (RESPONSE_TIME_RE.test(q)) return { route: "crm_response_time", windowInfo };
  if (WIN_LOSS_RE.test(q)) return { route: "crm_win_loss", windowInfo };
  if (SOURCES_RE.test(q)) return { route: "crm_sources", sourceFilter: extractSourceFilter(q), windowInfo };
  if (DEALS_RE.test(q)) return parseDealQuery(q, raw, now);
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
  if (/\b(?:viewings?|showings?)\b|معاين/.test(q) && !/\b(?:did|does|do)\b|\bby\b|عملها|عملت/.test(q) && !(/عنده|عندها/.test(q) && !/^(?:مين|من)\s+(?:عنده|عندها)/.test(q)) && (isTodayOrTomorrow || (SCHEDULED_VIEWINGS_RE.test(q) && (!windowInfo || !/\bhow many\b|كام|كم/.test(q))))) {
    return { route: "crm_viewings", windowInfo: windowInfo || extractTimeWindow("today", now) };
  }

  const brokerEn = BROKER_ACTIVITY_RE.exec(stripped);
  if (brokerEn) {
    const subj = stripWindowWords(brokerEn[1]).replace(/\s+(?:do|doing|done|have|has|make|get|log|close|completed)$/i, "").trim();
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

function parseBudgetAmount(raw) {
  const ascii = Phone.toAsciiDigits(String(raw || "")).replace(/,/g, "").trim().toLowerCase();
  const m = ascii.match(/^(?:(\d+(?:\.\d+)?)\s*)?(k|m|مليون|الف)$/) || ascii.match(/^(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const num = m[1] ? Number(m[1]) : 1;
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = m[2] || "";
  if (unit === "m" || unit === "مليون") return Math.round(num * 1_000_000);
  if (unit === "k" || unit === "الف") return Math.round(num * 1_000);
  return Math.round(num);
}

function detectFollowup(q) {
  const trimmed = String(q || "").trim().replace(/[؟?!.,]+$/g, "").trim();
  if (!trimmed) return null;
  const b1 = trimmed.match(/^(?:only|just)\s+(?:by|for|closed by|with)\s+([a-z\u0621-\u064a]+(?:\s+[a-z\u0621-\u064a]+)?)$/i)
    || trimmed.match(/^(?:بس\s+(?:بتوع|لـ|ل|قفلها)|(?:بتوع|قفلها))\s+([a-z\u0621-\u064a]+)(?:\s+بس)?$/i)
    || (/^بس\s+بتوع\s+/i.test(trimmed) ? trimmed.match(/^بس\s+بتوع\s+([a-z\u0621-\u064a]+)$/i) : null);
  if (b1 && /\b(?:only|just)\b|بس|بتوع/i.test(trimmed)) {
    return { kind: "filter_broker", brokerQuery: b1[1].trim() };
  }
  const incEn = trimmed.match(/^(?:if we |what if we )?(?:increase|bump|raise|add)\s+(?:the\s+)?budget\s+(?:by\s+)?([\d.,٠-٩]+\s*(?:k|m)?)$/i);
  const incAr = trimmed.match(/^(?:لو\s+)?(?:زودنا|نزود|رفعنا|كبرنا)\s+(?:الميزانيه|البادجت)\s*(?:بـ|ب)?\s*((?:[\d.,٠-٩]+\s*)?(?:الف|مليون)|[\d.,٠-٩]+)$/i);
  if (incEn || incAr) {
    const delta = parseBudgetAmount((incEn || incAr)[1]);
    if (delta) return { kind: "raise_budget", delta };
  }
  return null;
}

/**
 * Classifies one assistant query into an execution route.
 * Explicit modes (`resale`, `primary`, `reports`) lock routing strictly without cross-contamination.
 */
function classifyAssistantQuery({ text = "", mode = "auto", now = new Date(), previousContext = null } = {}) {
  const safeMode = MODES.includes(mode) ? mode : "auto";
  const q = normalize(text);
  if (!q) return { route: "clarify" };

  const followup = detectFollowup(q);
  if (followup) {
    if (!previousContext || typeof previousContext !== "object" || !previousContext.job) {
      return { route: "clarify", clarifyKind: "missing_context", market: null, exclusions: [], preservedText: text };
    }
    if (followup.kind === "filter_broker") {
      if (previousContext.job === "deals_report") {
        return {
          route: "crm_deals",
          job: "deals_report",
          market: previousContext.market || null,
          exclusions: [],
          brokerQuery: followup.brokerQuery,
          brokerRole: previousContext.brokerRole || "closer",
          areaQuery: previousContext.areaQuery || null,
          windowInfo: previousContext.window || null
        };
      }
      if (previousContext.job === "broker_activity" || previousContext.job === "brief") {
        return { route: "crm_broker", brokerQuery: followup.brokerQuery, windowInfo: previousContext.window || null };
      }
      return { route: "clarify", clarifyKind: "missing_context", market: null, exclusions: [], preservedText: text };
    }
    if (followup.kind === "raise_budget") {
      if (previousContext.job === "find_units" && (previousContext.f || previousContext.originalQuery)) {
        return {
          route: "unit_search",
          job: "find_units",
          market: safeMode === "resale" ? "resale" : (previousContext.market || null),
          exclusions: [],
          budgetBump: {
            baseQuery: previousContext.originalQuery || "",
            baseMaxPrice: previousContext.maxPrice || null,
            f: previousContext.f || null,
            delta: followup.delta
          }
        };
      }
      return { route: "clarify", clarifyKind: "missing_context", market: null, exclusions: [], preservedText: text };
    }
  }

  const plain = q.replace(/[؟?!.,،]+/g, " ").replace(/\s+/g, " ").trim();
  if (GREETING_RE.test(plain) || (OFF_TOPIC_RE.test(q) && !UNIT_RE.test(q) && !UNIT_CODE_RE.test(q) && !PRIMARY_EXPLICIT_RE.test(q))) {
    return { route: "clarify", clarifyKind: "off_topic", market: null, exclusions: [], preservedText: text };
  }

  const signals = parseMarketSignals(q);

  if (safeMode === "resale") {
    return { route: "unit_search", job: "find_units", market: "resale", exclusions: signals.exclusions };
  }
  if (safeMode === "primary") {
    const crmInPrimary = crmRoute(q, text, now);
    if (crmInPrimary) {
      return {
        route: "clarify",
        clarifyKind: "switch_mode_reports",
        job: crmInPrimary.route,
        market: "primary",
        hintRoute: crmInPrimary.route,
        preservedText: text
      };
    }
    return { route: "primary", job: "project_info", market: "primary", exclusions: signals.exclusions };
  }
  if (safeMode === "reports") {
    return crmRoute(q, text, now) || { route: "crm_brief", job: "brief", windowInfo: extractTimeWindow(q, now) };
  }

  const crm = crmRoute(q, text, now);
  if (crm) return crm;

  if (INVENTORY_COUNT_RE.test(q) && !signals.hasPrimary) {
    return {
      route: "inventory_count",
      job: "inventory_count",
      market: signals.market || "resale",
      exclusions: signals.exclusions
    };
  }

  if (signals.hasBothExplicit && !signals.exclusions.length) {
    return {
      route: "clarify",
      clarifyKind: "market_choice",
      market: null,
      exclusions: [],
      preservedText: text
    };
  }

  if (AMBIGUOUS_FINANCE_RE.test(q) && !signals.hasResale && !signals.hasPrimary && !signals.exclusions.length) {
    return {
      route: "clarify",
      clarifyKind: "market_choice",
      market: null,
      exclusions: [],
      preservedText: text
    };
  }

  if (signals.market === "resale") {
    return { route: "unit_search", job: "find_units", market: "resale", exclusions: signals.exclusions };
  }
  if (signals.market === "primary" || PRIMARY_RE.test(q)) {
    return { route: "primary", job: "project_info", market: "primary", exclusions: signals.exclusions };
  }
  if (UNIT_RE.test(q) || UNIT_CODE_RE.test(q)) {
    return { route: "unit_search", job: "find_units", market: null, exclusions: signals.exclusions };
  }
  if (/^(?:(?:who|why|when|where|what|how)\b|(?:امتى|امتي|كام|كم|ليه|ايه|مين)(?=\s|$|[؟?!.,]))/.test(q)) {
    return {
      route: "clarify",
      clarifyKind: "unknown_question",
      market: null,
      exclusions: [],
      preservedText: text
    };
  }
  return { route: "unit_search", job: "find_units", market: null, exclusions: signals.exclusions };
}

const AR_SKELETON = {
  ا: "a", أ: "a", إ: "a", آ: "a", ب: "b", ت: "t", ث: "th", ج: "g", ح: "h", خ: "kh",
  د: "d", ذ: "z", ر: "r", ز: "z", س: "s", ش: "sh", ص: "s", ض: "d", ط: "t", ظ: "z",
  ع: "a", غ: "gh", ف: "f", ق: "k", ك: "k", ل: "l", م: "m", ن: "n", ه: "", ة: "", و: "w", ي: "y", ى: "a", ئ: "y", ؤ: "w"
};

function phoneticToken(word) {
  const n = normalize(word).replace(/[^a-z0-9\u0621-\u064a]/g, "");
  if (!n) return "";
  let lat = "";
  for (const ch of n) lat += AR_SKELETON[ch] !== undefined ? AR_SKELETON[ch] : ch;
  lat = lat.replace(/ph/g, "f").replace(/c(?=[eiy])/g, "s").replace(/c|q/g, "k").replace(/(.)\1+/g, "$1");
  const head = lat[0] || "";
  const body = lat.slice(1).replace(/[aeiouyh]/g, "");
  return head + body;
}

function findMatchingBrokers(brokers, rawQuery) {
  const nq = normalize(rawQuery || "");
  if (!nq || !Array.isArray(brokers)) return [];
  const exact = brokers.filter((b) => normalize(b.name) === nq);
  if (exact.length === 1) return exact;
  const sub = brokers.filter((b) => normalize(b.name).includes(nq));
  if (sub.length) return sub;
  const qToks = nq.split(/\s+/).map(phoneticToken).filter((t) => t.length >= 2);
  if (!qToks.length) return [];
  return brokers.filter((b) => {
    const bToks = normalize(b.name).split(/\s+/).map(phoneticToken).filter(Boolean);
    return qToks.every((qt) => bToks.some((bt) => bt === qt || bt.startsWith(qt)));
  });
}

module.exports = { MODES, DAY_MS, MAX_RANGE_DAYS, normalize, addCairoDaysYmd, cairoMidnight, extractTimeWindow, resolveInterval, extractSourceFilter, findMatchingBrokers, classifyAssistantQuery };
