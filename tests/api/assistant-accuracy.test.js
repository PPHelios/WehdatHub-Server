// tests/api/assistant-accuracy.test.js — The assistant's ANSWERS are right: counts equal the seeded truth and the screens, rankings are ordered,
// roles see only their scope, answers are repeatable, English and Egyptian Arabic agree, and day/week/month edges follow Cairo time.
// The dataset and every expected number come from tests/harness/assistantDataset.js (specs), never from the services.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const PlanGuard = require("../../lib/planGuard");
const Workspace = require("../../lib/workspace");
const Search = require("../../services/search");
const D = require("../harness/assistantDataset");

jest.setTimeout(180000);

let h;
let S;
const tokens = {};
const logged = [];
const spies = [];

// Test roles → [broker fixture key | extra key, whose leads they may see (null = everyone)].
const ROLES = {
  manager: { row: () => h.BROKERS.manager, sees: null },
  owner: { row: () => h.BROKERS.owner, sees: null },
  tl1: { row: () => D.EXTRA.tl1, sees: ["broker", "colleague"] },
  tl2: { row: () => D.EXTRA.tl2, sees: ["b3"] },
  b1: { row: () => h.BROKERS.broker, sees: ["broker"] },
  b2: { row: () => h.BROKERS.colleague, sees: ["colleague"] },
  b3: { row: () => D.EXTRA.b3, sees: ["b3"] }
};

beforeAll(async () => {
  for (const m of ["log", "warn", "error", "info"]) spies.push(jest.spyOn(console, m).mockImplementation((...a) => logged.push(a.map(String).join(" "))));
  h = await createHarness();
  PlanGuard.forget(h.AGENCY_A);
  Workspace.forgetAll();
  S = await D.seed(h);
  for (const [k, r] of Object.entries(ROLES)) {
    const row = (await h.query("SELECT * FROM brokers WHERE id = $1", [r.row().id]))[0];
    tokens[k] = (await WebAuth.createSession(h.pool, row)).sid;
  }
});
afterAll(async () => {
  spies.forEach((s) => s.mockRestore());
  await closeHarness(h);
});

const ask = async (who, q, lang) => {
  await h.query("DELETE FROM web_rate_limits"); // 60 questions a minute per person is a rule of its own; these tests ask more
  const res = await request(h.app.app)
    .post("/api/v1/assistant/query")
    .set("Authorization", `Bearer ${tokens[who]}`)
    .send({ q, mode: "auto", lang: lang || (/[؀-ۿ]/.test(q) ? "ar" : "en") });
  expect(res.status).toBe(200);
  return res.body;
};
const get = async (who, url) => {
  const res = await request(h.app.app).get(url).set("Authorization", `Bearer ${tokens[who]}`);
  expect(res.status).toBe(200);
  return res.body;
};

// ---- oracle: counts straight from the seed specs ----
const visible = (who, l) => ROLES[who].sees === null || (l.who && ROLES[who].sees.includes(l.who));
const count = (who, tags) => S.leads.filter((l) => tags.includes(l.tag) && visible(who, l)).length;
const TAGS = {
  waiting: ["wait"],
  unassigned: ["unas"],
  overdue: ["over"],
  uncontacted: ["wait", "appr", "fresh", "unas"],
  approaching: ["appr"],
  opened: ["opened"],
  vToday: ["vtoday", "vconf", "vplan"],
  vTomorrow: ["vtomorrow"],
  vNextWeek: ["vtoday", "vconf", "vplan", "vtomorrow", "vnext"] // "next week" is the next 7 days from today
};
// Viewings split: booked = on the Calendar (vtoday leads also carry a follow-up: still one viewing), confirmed = the client said yes, planned = follow-up only.
const BOOKED = { vToday: ["vtoday", "vconf"], vTomorrow: ["vtomorrow"], vNextWeek: ["vtoday", "vconf", "vtomorrow", "vnext"] };
const CONFIRMED = { vToday: ["vconf"], vTomorrow: [], vNextWeek: ["vconf"] };
const PLANNED = { vToday: ["vplan"], vTomorrow: [], vNextWeek: ["vplan"] };
const stuck = (b) => b.cards.find((c) => c.kind === "stuck_leads");
const cal = () => S.cal;
const inWindow = {
  today: (d) => D.ymdOf(d) === cal().today,
  week: (d) => D.ymdOf(d) >= cal().weekStart && D.ymdOf(d) <= cal().today,
  month: (d) => D.ymdOf(d).slice(0, 7) === cal().today.slice(0, 7),
  lastMonth: (d) => D.ymdOf(d) >= cal().prevMonthStart && D.ymdOf(d) < cal().monthStart
};
const leadsIn = (win, source) => S.leads.filter((l) => inWindow[win](l.at) && (!source || l.source === source)).length;
const dealsIn = (win, who) => S.deals.filter((d) => inWindow[win](d.closed) && (!who || d.who === who));
const sum = (rows, k) => rows.reduce((t, r) => t + r[k], 0);

// ---- readers of the answer ----
const queueTotal = (b) => b.cards.find((c) => c.kind === "stuck_leads")?.total ?? 0;
const metrics = (b) => b.cards.find((c) => c.kind === "metric_row")?.items || [];
const dealNumbers = (b) => {
  const it = metrics(b);
  return { deals: it[0].value, commission: it[1].value, volume: it[it.length - 1].value };
};
const monthUrl = () => `from=${cal().monthStart}&to=${D.addDays(`${D.addDays(cal().monthStart, 31).slice(0, 7)}-01`, -1)}`;
const lastMonthUrl = () => `from=${cal().prevMonthStart}&to=${D.addDays(cal().monthStart, -1)}`;

const QUEUES = [
  { key: "waiting", q: "waiting over 1h", ar: "عملاء مستنيين اكتر من ساعة", intent: "crm_leads", queue: "waiting-over-1h" },
  { key: "unassigned", q: "unassigned leads", ar: "عملاء بدون وسيط", intent: "crm_leads", queue: "unassigned" },
  { key: "overdue", q: "overdue follow-ups", ar: "متابعات متأخرة", intent: "crm_leads", queue: "overdue" },
  { key: "uncontacted", q: "uncontacted leads", ar: "عملاء محدش كلمهم", intent: "crm_leads", queue: "uncontacted" },
  { key: "approaching", q: "leads approaching SLA", ar: "عملاء قربوا على وقت الرد", intent: "crm_approaching_sla" },
  { key: "opened", q: "offer links opened without follow up", ar: "شافوا العرض ومحدش تابع", intent: "crm_opened_no_followup" },
  { key: "vToday", q: "how many viewings today", ar: "معاينات النهارده", intent: "crm_viewings" },
  { key: "vTomorrow", q: "viewings tomorrow", ar: "معاينات بكره", intent: "crm_viewings" },
  { key: "vNextWeek", q: "viewings next week", intent: "crm_viewings" }
];

test("dataset sanity: the seed holds the counts the other tests rely on", () => {
  expect(count("manager", TAGS.waiting)).toBe(5);
  expect(count("manager", TAGS.unassigned)).toBe(3);
  expect(count("manager", TAGS.overdue)).toBe(4);
  expect(count("manager", TAGS.uncontacted)).toBe(11);
  expect(count("manager", TAGS.approaching)).toBe(2);
  expect(count("manager", TAGS.opened)).toBe(3);
  expect(S.deals.length).toBe(12);
  // The window edges really sit on both sides of midnight.
  const edge = (tag) => S.leads.find((l) => l.tag === tag).at;
  expect(inWindow.today(edge("edge2330"))).toBe(false);
  expect(inWindow.today(edge("edge0030"))).toBe(true);
  expect(inWindow.month(edge("edgeMonthPrev"))).toBe(false);
  expect(inWindow.month(edge("edgeMonthNext"))).toBe(true);
});

test("1. Truth: every count in an answer equals the seeded count and what the screens show", async () => {
  // Queues: assistant == seed == Leads screen (same actor, same queue) == Dashboard == Today.
  const screenQueue = { waiting: "waiting-over-1h", unassigned: "unassigned", overdue: "overdue", uncontacted: "uncontacted" };
  const dash = await get("manager", "/api/v1/dashboard?days=30");
  const today = await get("manager", "/api/v1/today");
  for (const who of ["manager", "owner", "tl1", "b1"]) {
    for (const { key, q, intent } of QUEUES.slice(0, 4)) {
      const body = await ask(who, q);
      expect(body.intent).toBe(intent);
      const expected = count(who, TAGS[key]);
      expect({ who, q, n: queueTotal(body) }).toEqual({ who, q, n: expected });
      expect(body.headline).toContain(String(expected));
      const screen = await get(who, `/api/v1/leads?queue=${screenQueue[key]}`);
      expect({ who, q, screen: screen.total }).toEqual({ who, q, screen: expected });
    }
  }
  expect({ unassigned: dash.unassigned, uncontacted: dash.uncontacted, waiting: dash.waitingOver1h, overdue: dash.overdue }).toEqual({ unassigned: 3, uncontacted: 11, waiting: 5, overdue: 4 });
  // Today's ops card is the same queue (it said 0 overdue while Leads said 4: "before today" vs "before now").
  expect(today.cards.ops).toMatchObject({ unassigned: 3, overdue: 4 });
  const tl1Today = await get("tl1", "/api/v1/today");
  expect(tl1Today.cards.ops).toMatchObject({ overdue: count("tl1", TAGS.overdue) });

  // Approaching SLA and opened links.
  expect(queueTotal(await ask("manager", "leads approaching SLA"))).toBe(2);
  const opened = await ask("manager", "offer links opened without follow up");
  expect(queueTotal(opened)).toBe(3);
  expect(opened.headline).toContain("3");
  const links = await get("manager", "/api/v1/opened-links?status=opened");
  expect(links.total).toBe(3);

  // Viewings: agency count == seed == the sum of every broker's own calendar for the same window.
  const windows = {
    vToday: [cal().todayStart, cal().tomorrowStart],
    vTomorrow: [cal().tomorrowStart, new Date(D.midnightOf(D.addDays(cal().today, 2)))],
    vNextWeek: [cal().todayStart, new Date(D.midnightOf(D.addDays(cal().today, 8)))]
  };
  for (const { key, q } of QUEUES.slice(6)) {
    const body = await ask("manager", q);
    expect(body.intent).toBe("crm_viewings");
    expect(metrics(body)[0].value).toBe(count("manager", TAGS[key]));
    expect(queueTotal(body)).toBe(count("manager", TAGS[key]));
    expect(stuck(body).split).toEqual({ booked: count("manager", BOOKED[key]), confirmed: count("manager", CONFIRMED[key]), planned: count("manager", PLANNED[key]) });
    expect(stuck(body).queue).toBeNull();
    for (const it of stuck(body).items) {
      const lead = S.leads.find((l) => l.name === it.name);
      const state = PLANNED[key].includes(lead.tag) ? "planned" : CONFIRMED[key].includes(lead.tag) ? "confirmed" : "booked";
      expect(it.viewingState).toBe(state);
      expect(typeof it.at).toBe("string");
      if (state === "planned") expect(it.action).toEqual({ kind: "book_viewing", ref: it.ref, at: it.at });
      else expect(it.action).toBeUndefined();
      expect(it).toHaveProperty("lastAutoReminderAt", null);
    }
    let calendars = 0;
    for (const who of ["b1", "b2", "b3"]) {
      const [from, to] = windows[key];
      const cal1 = await get(who, `/api/v1/viewings?from=${from.toISOString()}&to=${to.toISOString()}`);
      const mine = stuck(await ask(who, q))?.split.booked ?? 0;
      expect(mine).toBe(cal1.items.length); // the broker's booked viewings == the broker's calendar
      calendars += cal1.items.length;
    }
    expect(calendars).toBe(count("manager", BOOKED[key]));
  }

  // Deals: this month / last month, with commission and volume.
  for (const [q, win, url] of [["deals this month", "month", monthUrl()], ["deals last month", "lastMonth", lastMonthUrl()]]) {
    const body = await ask("manager", q);
    expect(body.intent).toBe("crm_deals");
    const rows = dealsIn(win);
    expect(dealNumbers(body)).toEqual({ deals: rows.length, commission: sum(rows, "commission"), volume: sum(rows, "price") });
    const screen = await get("manager", `/api/v1/deals?${url}`);
    expect(screen.dealSummary).toMatchObject({ deals: rows.length, commissionTotal: sum(rows, "commission"), volume: sum(rows, "price") });
  }
  const resale = await ask("manager", "resale deals this month");
  expect(dealNumbers(resale).deals).toBe(dealsIn("month").filter((d) => d.market === "resale").length);
  const primary = await ask("manager", "primary deals this month");
  expect(dealNumbers(primary).deals).toBe(dealsIn("month").filter((d) => d.market === "primary").length);

  // Sources: Facebook leads this month == seed == Sources screen.
  const fb = await ask("manager", "how many leads came from facebook this month");
  expect(fb.intent).toBe("crm_sources");
  expect(metrics(fb)[0].value).toBe(leadsIn("month", "Facebook"));
  expect(metrics(fb)[1].value).toBe(leadsIn("month"));
  const sourcesScreen = await get("manager", "/api/v1/sources");
  expect(sourcesScreen.rows.find((r) => r.source === "Facebook").leads).toBe(leadsIn("month", "Facebook"));

  // Lost leads and reasons: assistant == seed == Win/Loss screen.
  const wl = await ask("manager", "lost reasons");
  expect(wl.intent).toBe("crm_win_loss");
  const lost = S.leads.filter((l) => l.stage === "lost").length;
  expect(metrics(wl)[1].value).toBe(lost);
  const wlScreen = await get("manager", "/api/v1/insights/winloss");
  expect(wlScreen.lost).toBe(lost);
  expect(wlScreen.reasons.reduce((t, r) => t + r.n, 0)).toBe(lost);
  const reasonRows = wl.cards.find((c) => c.title === "Top lost reasons" || c.kind === "bar_breakdown").rows;
  expect(reasonRows.reduce((t, r) => t + r.count, 0)).toBe(lost);

  // Leases ending within 90 days: two (the far, the done and the expired ones are left out).
  const leases = await ask("manager", "leases ending soon");
  expect(leases.intent).toBe("crm_leases");
  expect(metrics(leases)[0].value).toBe(2);
  expect((await get("manager", "/api/v1/leases?soon=1")).items).toHaveLength(2);
  expect(today.leases).toHaveLength(2);

  // The 30-day brief reads the same numbers as the Dashboard.
  const brief = await ask("manager", "agency brief");
  expect(brief.intent).toBe("crm_brief");
  const byLabel = (re) => metrics(brief).find((i) => re.test(i.label))?.value;
  expect(byLabel(/New leads|عملاء جدد/)).toBe(dash.leads);
  expect(byLabel(/Waiting|مستني/)).toBe(dash.waitingOver1h);
  expect(byLabel(/Overdue|متأخرة/)).toBe(dash.overdue);
  expect(byLabel(/Deals|صفقات/)).toBe(dash.deals.n);
});

test("2. Ranking: the broker with the most deals this month is first, order and ties are stable", async () => {
  const closed = (who) => dealsIn("month", who).length;
  const expected = { "Broker One": closed("broker"), "Broker Two": closed("colleague"), "Broker Three": closed("b3") };
  expect(expected).toEqual({ "Broker One": 3, "Broker Two": 2, "Broker Three": 2 }); // one clear leader, a tie behind it
  // "Closed by <broker>" answers equal the seed.
  for (const [name, n] of Object.entries(expected)) {
    const body = await ask("manager", `deals closed by ${name} this month`);
    expect(body.intent).toBe("crm_deals");
    expect({ name, n: dealNumbers(body).deals }).toEqual({ name, n });
  }
  // The Dashboard leaderboard for the same month: same numbers, best first, and the same order every time.
  const board = async () => (await get("manager", `/api/v1/dashboard?from=${cal().monthStart}&to=${cal().today}`)).board;
  const first = (await board()).filter((b) => b.deals > 0);
  expect(first.map((b) => [b.name, b.deals])).toEqual(expect.arrayContaining(Object.entries(expected)));
  expect(first.map((b) => b.deals)).toEqual([...first.map((b) => b.deals)].sort((a, b) => b - a));
  expect(first[0].name).toBe("Broker One");
  for (let i = 0; i < 3; i++) expect((await board()).filter((b) => b.deals > 0).map((b) => b.id)).toEqual(first.map((b) => b.id));
});

test("3. Roles: each role sees only its scope, and a broker never sees another broker's client name or phone", async () => {
  const keyOf = (id) => ({ [h.BROKERS.broker.id]: "broker", [h.BROKERS.colleague.id]: "colleague", [D.EXTRA.b3.id]: "b3" })[id];
  const leaks = (who, text) => S.leads.filter((l) => !visible(who, l) && (text.includes(l.name) || text.includes(l.phone) || text.includes(l.phone.replace("+", "")))).map((l) => l.name);
  const questions = [
    ...QUEUES.map((x) => x.q),
    "deals this month", "deals last month", "agency brief", "what did Broker Two do today", "what did Broker Three do today?",
    "who is not updating leads?", "leads with no next step", "what is the average response time per person?", "how many leads came from facebook this month",
    "lost reasons", "leases ending soon", "overdue developer commissions", "how did Team Lead Two's team do this week?"
  ];
  for (const who of ["b1", "b2", "b3", "tl1", "tl2"]) {
    for (const q of questions) {
      const body = await ask(who, q);
      expect({ who, q, leaked: leaks(who, JSON.stringify(body)) }).toEqual({ who, q, leaked: [] });
      for (const c of body.cards || []) for (const it of c.items || []) if (it.assigneeId) expect({ who, q, holder: ROLES[who].sees.includes(keyOf(it.assigneeId)) }).toEqual({ who, q, holder: true });
    }
  }
  // Counts by role (the manager and owner see the whole agency; a team lead their team; a broker their own).
  for (const who of Object.keys(ROLES)) {
    for (const { key, q } of QUEUES) {
      const body = await ask(who, q);
      expect({ who, key, n: key.startsWith("v") ? metrics(body)[0].value : queueTotal(body) }).toEqual({ who, key, n: count(who, TAGS[key]) });
    }
  }
  // Deals: everyone's own numbers (a team lead closed none), the agency's for managers and owners; the screen agrees for the same person.
  for (const who of Object.keys(ROLES)) {
    const key = ROLES[who].sees === null ? null : ROLES[who].row().id;
    const rows = dealsIn("month").filter((d) => key === null || D.keyId(h, d.who) === key);
    const body = await ask(who, "deals this month");
    expect({ who, n: dealNumbers(body).deals }).toEqual({ who, n: rows.length });
    const screen = await get(who, `/api/v1/deals?${monthUrl()}`);
    expect({ who, screen: screen.dealSummary.deals }).toEqual({ who, screen: rows.length });
  }
  // Manager-only answers stay manager-only.
  for (const who of ["b1", "tl1"]) {
    for (const q of ["leases ending soon", "how many leads came from facebook this month", "lost reasons"]) {
      expect({ who, q, intent: (await ask(who, q)).intent }).toEqual({ who, q, intent: "clarify" });
    }
  }
});

test("4. Determinism: the same question gives the same body twice, and again after the in-memory caches are cleared", async () => {
  const volatile = new Set(["at", "ts", "generatedAt", "requestId"]);
  const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !volatile.has(k)).map(([k, x]) => [k, strip(x)])) : v);
  const questions = [...QUEUES.flatMap((x) => [x.q, x.ar].filter(Boolean)), "deals this month", "deals last month", "resale deals this month", "agency brief",
    "how many leads came from facebook this month", "lost reasons", "leases ending soon", "who is not updating leads?", "deals closed by Broker One this month"];
  for (const who of ["manager", "tl1", "b1"]) {
    for (const q of questions) {
      const a = strip(await ask(who, q));
      const b = strip(await ask(who, q));
      PlanGuard.forget(h.AGENCY_A);
      Workspace.forgetAll();
      Search.parseCache.clear();
      const c = strip(await ask(who, q));
      expect({ who, q, same: b }).toEqual({ who, q, same: a });
      expect({ who, q, same: c }).toEqual({ who, q, same: a });
    }
  }
});

test("5. Language parity: English and Egyptian Arabic give the same intent and the same numbers", async () => {
  const signature = (b) => ({
    intent: b.intent,
    cards: (b.cards || []).map((c) => [c.kind, c.total ?? null, (c.items || []).map((i) => i.value ?? i.ref ?? null), (c.rows || []).map((r) => r.count ?? null)])
  });
  const pairs = [
    ...QUEUES.filter((x) => x.ar).map((x) => [x.q, x.ar]),
    ["deals this month", "صفقات الشهر ده"],
    ["deals last month", "صفقات الشهر اللي فات"],
    ["how many leads came from facebook this month", "كام عميل جاي من فيسبوك الشهر ده"],
    ["lost reasons", "اسباب الخسارة"],
    ["leases ending soon", "عقود الايجار"]
  ];
  for (const who of ["manager", "tl1", "b1"]) {
    for (const [en, ar] of pairs) {
      const a = await ask(who, en, "en");
      const b = await ask(who, ar, "ar");
      expect({ who, en, ...signature(b) }).toEqual({ who, en, ...signature(a) });
    }
  }
});

test("6. Windows follow Cairo days: a lead or deal at 23:30 and at 00:30 lands on the right side of today, this week, this month and last month", async () => {
  const fbQuestions = [["today", "how many leads came from facebook today"], ["week", "how many leads came from facebook this week"], ["month", "how many leads came from facebook this month"], ["lastMonth", "how many leads came from facebook last month"]];
  for (const [win, q] of fbQuestions) {
    const body = await ask("manager", q);
    expect(body.intent).toBe("crm_sources");
    expect({ win, facebook: metrics(body)[0].value, all: metrics(body)[1].value }).toEqual({ win, facebook: leadsIn(win, "Facebook"), all: leadsIn(win) });
  }
  // The edge leads are in different windows, so a boundary error would move a number.
  const e = (tag) => S.leads.find((l) => l.tag === tag).at;
  expect([inWindow.today(e("edge2330")), inWindow.today(e("edge0030"))]).toEqual([false, true]);
  expect([inWindow.week(e("edgeWeekPrev")), inWindow.week(e("edgeWeekNext"))]).toEqual([false, true]);
  expect([inWindow.month(e("edgeMonthPrev")), inWindow.month(e("edgeMonthNext"))]).toEqual([false, true]);
  expect([inWindow.lastMonth(e("edgeMonthPrev")), inWindow.lastMonth(e("edgeMonthNext"))]).toEqual([true, false]);

  // Deals at 23:30 on the last day of last month and 00:30 on the 1st.
  const lastNight = S.deals.find((d) => d.closed.getTime() === S.cal.monthStartAt.getTime() - 30 * 60000);
  const firstNight = S.deals.find((d) => d.closed.getTime() === S.cal.monthStartAt.getTime() + 30 * 60000);
  expect([inWindow.lastMonth(lastNight.closed), inWindow.month(lastNight.closed)]).toEqual([true, false]);
  expect([inWindow.lastMonth(firstNight.closed), inWindow.month(firstNight.closed)]).toEqual([false, true]);
  const thisM = await ask("manager", "deals this month");
  const lastM = await ask("manager", "deals last month");
  expect(dealNumbers(thisM).deals).toBe(dealsIn("month").length);
  expect(dealNumbers(lastM).deals).toBe(dealsIn("lastMonth").length);
  expect(dealNumbers(thisM).commission).toBe(sum(dealsIn("month"), "commission"));
  expect(dealNumbers(lastM).commission).toBe(sum(dealsIn("lastMonth"), "commission"));

  // Viewings: the one at the end of today is not "tomorrow"; the one at 10:00 tomorrow is not "today".
  const vToday = await ask("manager", "how many viewings today");
  const vTomorrow = await ask("manager", "viewings tomorrow");
  const refs = (b) => b.cards.find((c) => c.kind === "stuck_leads").items.map((i) => i.name).sort();
  const names = (tag) => S.leads.filter((l) => l.tag === tag).map((l) => l.name);
  expect(refs(vToday)).toEqual([...names("vtoday"), ...names("vconf"), ...names("vplan")].sort());
  expect(refs(vTomorrow)).toEqual(names("vtomorrow").sort());
});

test("7. Tap-through: every card queue opens the exact list the card shows (first page), and the card carries the last automatic reminder", async () => {
  const stamp = new Date(Date.now() - 3600000).toISOString();
  const waiting = S.leads.find((l) => l.tag === "wait");
  await h.query("UPDATE leads SET follow_up_reminded_at = $2, nudged_at = $3 WHERE ref = $1", [waiting.ref, new Date(Date.now() - 7200000).toISOString(), stamp]);
  const ids = (body) => stuck(body).items.map((i) => i.ref);
  for (const who of ["manager", "tl1", "b1"]) {
    for (const { q } of QUEUES.filter((x) => x.intent !== "crm_viewings")) {
      const body = await ask(who, q);
      const card = stuck(body);
      expect({ who, q, queue: typeof card.queue }).toEqual({ who, q, queue: "string" });
      const list = await get(who, `/api/v1/leads?queue=${card.queue}`);
      expect({ who, q, refs: list.items.slice(0, card.items.length).map((i) => i.ref), total: list.total }).toEqual({ who, q, refs: ids(body), total: card.total });
    }
  }
  const items = stuck(await ask("manager", "waiting over 1h")).items;
  expect(items.find((i) => i.ref === `L-${waiting.ref}`)?.lastAutoReminderAt).toBe(stamp);
  expect(items.filter((i) => i.ref !== `L-${waiting.ref}`).every((i) => i.lastAutoReminderAt === null)).toBe(true);
});

test("no client name or phone reached the logs", () => {
  const text = logged.join("\n");
  for (const l of S.leads) {
    expect(text).not.toContain(l.name);
    expect(text).not.toContain(l.phone);
  }
});
