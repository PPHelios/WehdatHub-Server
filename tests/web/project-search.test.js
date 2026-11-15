// tests/web/project-search.test.js — The grouped project search of Ask (web and app): one card per project with its fitting offers or its free text,
// counts, pages, sorts by price, area and down payment, filters, and the same list from the API and the website.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const WebAuth = require("../../lib/webAuth");
const Catalogue = require("../../services/catalogue");
const Suggest = require("../../services/placeSuggest");
const Search = require("../../services/projectSearch");
const { seedProjects } = require("../../scripts/seed-projects");

jest.setTimeout(120000);

let h;
let admin;
const AREA = "العبور الجديدة";
beforeAll(async () => {
  h = await createHarness();
  const top = (key, en, ar) => h.query("INSERT INTO areas (name_key, name_en, name_ar) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [key, en, ar]);
  const sub = (key, en, ar, parent) => h.query("INSERT INTO areas (name_key, name_en, name_ar, parent_id) SELECT $1, $2, $3, id FROM areas WHERE name_en = $4 ON CONFLICT DO NOTHING", [key, en, ar, parent]);
  await top("obour city", "Obour City", "مدينة العبور");
  await sub("new obour", "New Obour", "العبور الجديدة", "Obour City");
  await top("new capital", "New Capital", "العاصمة الإدارية الجديدة");
  await sub("mu23", "MU23", "منطقة MU23", "New Capital");
  await top("sheikh zayed", "Sheikh Zayed", "الشيخ زايد");
  await top("6th of october", "6th of October", "السادس من أكتوبر");
  await sub("5th settlement", "5th Settlement", "التجمع الخامس", "New Cairo");
  await sub("golden square", "Golden Square", "المربع الذهبي", "New Cairo");
  Suggest.resetCache();
  admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  await seedProjects(h.pool, admin.agency_id);
  // A project with no unit details, only free text in its notes.
  const place = (await h.query("SELECT id FROM areas WHERE name_en = 'New Obour'"))[0].id;
  await Catalogue.saveProject(h.pool, admin, { name: "Notes Only", area_id: place, notes: "مشروع جديد في العبور الجديدة، التفاصيل بتتحدد قريب", paste_text: "" });
});
afterAll(() => closeHarness());

const names = (r) => r.projects.map((p) => p.name);
const search = (f, o = {}) => Search.search(h.pool, admin.agency_id, f, { perPage: 25, ...o });

test("grouped per project: each project once with its offers; a project with no details shows its free text; counts add up", async () => {
  const r = await search({ place_terms: [AREA] }, { lang: "en" });
  expect(r.total_projects).toBe(11); // the ten seeded + Notes Only
  expect(new Set(names(r)).size).toBe(r.projects.length);
  const jazeel = r.projects.find((p) => p.name === "JAZEEL RESIDENCE");
  expect(jazeel.offers_total).toBe(3);
  expect(jazeel.offers[0]).toMatchObject({ area: 110, price: 2862554 });
  const notes = r.projects.find((p) => p.name === "Notes Only");
  expect(notes).toMatchObject({ offers_total: 0, offers: [] });
  expect(notes.free_text).toContain("التفاصيل بتتحدد قريب");
  expect(r.total_options).toBe(r.projects.reduce((s, p) => s + p.offers_total, 0));
});

test("pages: the counts, the page size and the page clamp", async () => {
  const far = await search({ place_terms: [AREA] }, { perPage: 4, page: 99 });
  expect(far.pages).toBe(3); // 11 projects in 4 a page
  expect(far.page).toBe(3);
  expect(far.projects).toHaveLength(3);
  const first = await search({ place_terms: [AREA] }, { perPage: 4, page: 1 });
  expect(first).toMatchObject({ page: 1, per_page: 4, total_projects: 11 });
  expect(first.projects).toHaveLength(4);
});

test("sorts: price, area and down payment", async () => {
  const f = { place_terms: [AREA], price_max: 20000000 };
  const from = (p) => (p.offers.length ? p.offers[0].price : p.price_from);
  const cheap = await search(f, { sort: "cheap" });
  const prices = cheap.projects.map(from);
  expect(prices).toEqual([...prices].sort((a, b) => a - b));
  const pricey = await search(f, { sort: "pricey" });
  expect(pricey.projects[0].name).toBe("OBOUR VILLAS"); // 11.5M, the dearest
  expect(cheap.projects[0].name).toBe("OBOUR HEIGHTS"); // 1.9M
  // Area: projects with sized units first (smallest or largest unit), the rest after.
  expect((await search(f, { sort: "small" })).projects[0].name).toBe("JAZEEL RESIDENCE");
  expect((await search(f, { sort: "big" })).projects[0].name).toBe("JAZEEL RESIDENCE");
  // Down payment: a unit's written amount, or price from × the lowest down payment %.
  const down = await search({ place_terms: [AREA], max_down_payment: 1000000 }, { sort: "down" });
  expect(down.total_projects).toBeGreaterThan(3);
  expect(down.projects.every((p) => (p.offers.length ? Math.min(...p.offers.map((o) => o.down)) <= 1000000 : p.price_from != null))).toBe(true);
  expect(names(down)).toContain("OBOUR HEIGHTS"); // 1.9M × 10% = 190,000, the lowest of the projects that do not list units
});

test("filters: price, area, bedrooms, features; nothing asked lists nothing; the page's filters win", async () => {
  const under = await search({ place_terms: [AREA], price_max: 3000000 });
  expect(under.total_projects).toBeGreaterThan(0);
  for (const p of under.projects) expect(p.offers.length ? p.offers[0].price : p.price_from).toBeLessThanOrEqual(3000000);
  const sized = await search({ place_terms: [AREA], area_min: 150, area_max: 160 });
  expect(names(sized)).toEqual(["JAZEEL RESIDENCE"]);
  expect(sized.projects[0].offers).toHaveLength(1);
  expect(names(await search({ place_terms: [AREA], bedrooms_min: 5, bedrooms_max: 5 })).sort()).toEqual(["LAGOON VIEW OBOUR", "OBOUR VILLAS"]);
  expect(names(await search({ place_terms: [AREA], features: ["roof"] }))).toEqual(["SKYLINE OBOUR"]);
  expect(await search({})).toMatchObject({ total_projects: 0, projects: [] });
  const explicit = await search({ place_terms: [AREA], price_max: 3000000 }, { explicit: { pmax: "2,000,000" } });
  for (const p of explicit.projects) expect(p.offers.length ? p.offers[0].price : p.price_from).toBeLessThanOrEqual(2000000);
});

test("the API and the website show the same grouped list, and a chip can be dropped", async () => {
  const b = h.BROKERS.broker;
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const tok = (await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
  const q = "شقة في العبور الجديدة";
  const api = await request(h.app.app).get("/api/v1/ask/results").query({ q, per: 5 }).set("Authorization", `Bearer ${tok}`);
  expect(api.status).toBe(200);
  expect(api.body).toMatchObject({ per_page: 5, sort: "best" });
  expect(api.body.total_projects).toBeGreaterThanOrEqual(10);
  expect(api.body.chips.map((c) => c.key)).toContain("place");
  const dropped = await request(h.app.app).get("/api/v1/ask/results").query({ q, drop: "place" }).set("Authorization", `Bearer ${tok}`);
  expect(dropped.body.chips.map((c) => c.key)).not.toContain("place");
  const { agent } = await signIn(h, "broker");
  const web = await agent.get("/app/ask/results").query({ q, per: 5 });
  expect(web.status).toBe(200);
  expect(web.text).toContain("data-results-count");
  expect(web.text).toContain("data-results-filters");
  expect(web.text).toMatch(new RegExp(`data-results-count>${api.body.total_projects} `));
  for (const p of api.body.projects) expect(web.text).toContain(`data-ask-project="${p.id}"`);
  expect(web.text).toContain("data-results-pages");
});

test("the catalogue API takes the same filters and a project comes with its new rows", async () => {
  const b = h.BROKERS.broker;
  const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
  const tok = (await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
  const get = (p, query) => request(h.app.app).get(`/api/v1${p}`).query(query || {}).set("Authorization", `Bearer ${tok}`);
  const place = (await h.query("SELECT id FROM areas WHERE name_en = 'New Obour'"))[0].id;
  const list = await get("/catalogue", { pl: place, bed: "5" });
  expect(list.body.projects.items.map((p) => p.name).sort()).toEqual(["LAGOON VIEW OBOUR", "OBOUR VILLAS"]);
  const one = (await h.query("SELECT id FROM projects WHERE name = 'PMC Mall'"))[0].id;
  const detail = await get(`/catalogue/projects/${one}`);
  expect(detail.body.project.property_types).toEqual(["office"]);
  expect(detail.body.facts.map((x) => x.key)).toContain("consultant");
});

describe("AI first, parser second, both kept", () => {
  const FakeAI = require("../harness/fake-ai");
  const Line = require("../../domain/projectAnswerLine");

  test("the answer line is written from the results: counts, prices, the date; nothing when nothing matches", async () => {
    const r = await search({ place_terms: [AREA] }, { lang: "en" });
    const en = Line.line(r, "en");
    expect(en).toMatch(/^11 projects match this search\./);
    expect(en).toContain("Prices on this page start from");
    expect(en).toContain("Data last updated");
    expect(Line.line({ total_projects: 0, projects: [] }, "en")).toMatch(/No project in our data/);
    expect(Line.line(r, "ar")).toContain("مشروع مناسب");
  });

  test("a question: the AI reads it first (its filters are used), the parser second; both readings are in the search log and the web shows the AI's answer", async () => {
    FakeAI.reset();
    FakeAI.respond((call) => {
      if (call.operation === "search_parse") return { intent: "search", filters: { place_terms: ["العبور الجديدة"], price_max: 3000000 } };
      if (call.operation === "assistant") return { answer: "Two projects are under 3 million.", found: true };
      throw new Error(`unexpected ${call.operation}`);
    });
    const { agent, csrf } = await signIn(h, "broker");
    const res = await agent.post("/app/ask").set("X-CSRF-Token", csrf).type("form").send({ q: "شقة رخيصة في العبور الجديدة" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Two projects are under 3 million.");
    const log = (await h.query("SELECT channel, source, local_filters, ai_filters, used_filters FROM search_log WHERE channel = 'ask' ORDER BY created_at DESC LIMIT 1"))[0];
    expect(log).toMatchObject({ channel: "ask", source: "ai" });
    expect(log.ai_filters.price_max).toBe(3000000);
    expect(log.local_filters).toBeTruthy(); // the parser's own reading, kept for the comparison
    const q = (await h.query("SELECT ai_answer, local_answer, answer_source, search_log_id FROM assistant_questions ORDER BY created_at DESC LIMIT 1"))[0];
    expect(q.answer_source).toBe("ai");
    expect(q.ai_answer).toBe("Two projects are under 3 million.");
    expect(q.local_answer).toContain("مشروع مناسب");
    expect(q.search_log_id).toBeTruthy();
    // Page and sort links carry the reading: following one reads and logs nothing again.
    const before = (await h.query("SELECT count(*)::int AS n FROM search_log WHERE channel = 'ask'"))[0].n;
    const link = res.text.match(/href="(\/app\/ask\/results\?[^"]*sort=cheap[^"]*)"/)[1].replace(/&amp;/g, "&");
    expect(link).toMatch(/[?&]f=/);
    expect((await agent.get(link)).status).toBe(200);
    expect((await h.query("SELECT count(*)::int AS n FROM search_log WHERE channel = 'ask'"))[0].n).toBe(before);
  });

  test("with the AI unavailable the parser's reading and the line written from the data are the answer, and it is logged as local", async () => {
    FakeAI.reset();
    FakeAI.respond(() => new Error("quota"));
    const { agent, csrf } = await signIn(h, "broker");
    const res = await agent.post("/app/ask").set("X-CSRF-Token", csrf).type("form").send({ q: "شقة في العبور الجديدة" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("data-answer-local");
    expect(res.text).toContain("مشروع مناسب للبحث ده");
    const q = (await h.query("SELECT ai_answer, answer_source FROM assistant_questions ORDER BY created_at DESC LIMIT 1"))[0];
    expect(q).toMatchObject({ ai_answer: null, answer_source: "local" });
    expect((await h.query("SELECT source FROM search_log WHERE channel = 'ask' ORDER BY created_at DESC LIMIT 1"))[0].source).not.toBe("ai");
  });
});

describe("what the broker does next, wrong results, the owner's figures, and the app's contract", () => {
  const FakeAI = require("../harness/fake-ai");
  const tokenOf = async (b) => {
    const code = await WebAuth.issueLoginCode(h.pool, { id: b.id, agency_id: b.agency_id });
    return (await request(h.app.app).post("/api/v1/auth/code/verify").send({ phone: b.phone, code })).body.token;
  };

  test("the contract the app reads: field names of /ask/results, /catalogue and /ask", async () => {
    FakeAI.reset();
    const tok = await tokenOf(h.BROKERS.broker);
    const get = (p, q) => request(h.app.app).get(`/api/v1${p}`).query(q || {}).set("Authorization", `Bearer ${tok}`);
    const r = (await get("/ask/results", { q: "شقة في العبور الجديدة", per: 2 })).body;
    expect(Object.keys(r).sort()).toEqual(expect.arrayContaining(["answer_line", "chips", "dropped", "filters", "log_id", "page", "pages", "per_page", "projects", "read", "sort", "token", "total_options", "total_projects"]));
    expect(Object.keys(r.projects[0]).sort()).toEqual(expect.arrayContaining(["client_text", "cover_url", "delivery", "developer", "facts", "free_text", "governorate", "id", "name", "name_en", "offers", "offers_total", "place", "price_from", "status"]));
    const place = (await h.query("SELECT id FROM areas WHERE name_en = 'New Obour'"))[0].id;
    const cat = (await get("/catalogue", { pl: place, f: ["roof", "view_lagoon"], max: "9000000" })).body;
    expect(cat.projects.items.map((p) => p.name)).toEqual([]); // both features at once: none has both
    const one = (await get("/catalogue", { pl: place, f: ["roof"] })).body.projects;
    expect(one.items.map((p) => p.name)).toEqual(["SKYLINE OBOUR"]);
    expect(Object.keys(one.items[0])).toEqual(expect.arrayContaining(["price_from", "area_acres", "down_pct_min", "years_max", "bedroom_options", "property_types", "feature_keys", "delivery_raw", "cover_url", "units", "plans"]));
  });

  test("actions are logged against the search, only the broker's own; a wrong-results report is kept; the owner sees the project-search figures", async () => {
    FakeAI.reset();
    const tok = await tokenOf(h.BROKERS.broker);
    const other = await tokenOf(h.BROKERS.colleague);
    const auth = (rq, t) => rq.set("Authorization", `Bearer ${t}`);
    const r = (await auth(request(h.app.app).get("/api/v1/ask/results").query({ q: "شقة في العبور الجديدة" }), tok)).body;
    expect(r.log_id).toBeTruthy();
    // Following a link keeps the same log id (sl), so a page turn belongs to the first search.
    const next = (await auth(request(h.app.app).get("/api/v1/ask/results").query({ q: "شقة في العبور الجديدة", f: r.token, sl: r.log_id, sort: "cheap" }), tok)).body;
    expect(next.log_id).toBe(r.log_id);
    const act = (body, t = tok) => auth(request(h.app.app).post("/api/v1/ask/action").send(body), t);
    expect((await act({ log_id: r.log_id, action: "sort", detail: "cheap" })).status).toBe(204);
    expect((await act({ log_id: r.log_id, action: "open", detail: r.projects[0].id })).status).toBe(204);
    expect((await act({ log_id: r.log_id, action: "send" })).status).toBe(204);
    expect((await act({ log_id: r.log_id, action: "bogus" })).status).toBe(404);
    expect((await act({ log_id: r.log_id, action: "open" }, other)).status).toBe(404); // someone else's search
    expect((await h.query("SELECT action FROM search_actions WHERE search_log_id = $1 ORDER BY created_at", [r.log_id])).map((x) => x.action)).toEqual(["sort", "open", "send"]);
    const rep = await auth(request(h.app.app).post("/api/v1/ask/report").send({ log_id: r.log_id, note: "wrong place" }), tok);
    expect(rep.body).toEqual({ ok: true });
    expect((await auth(request(h.app.app).post("/api/v1/ask/report").send({ log_id: r.log_id }), tok)).status).toBe(409);
    expect((await h.query("SELECT note FROM search_reports WHERE search_log_id = $1", [r.log_id]))[0].note).toBe("wrong place");
    // The owner's figures count the project searches and what brokers did next.
    const Review = require("../../services/searchReview");
    const day = 24 * 3600 * 1000;
    const now = await Review.summary(h.pool, { from: new Date(Date.now() - day), to: new Date(Date.now() + day), prevFrom: new Date(Date.now() - 3 * day), prevTo: new Date(Date.now() - day) });
    expect(now.now.ask).toBeGreaterThanOrEqual(1);
    expect(now.now.ask_used).toBe(2);
    expect(now.now.ask_refined).toBe(1);
  });

  test("the website: the results page has the report box and the tracker script; the click endpoint logs an action", async () => {
    FakeAI.reset();
    const { agent, csrf } = await signIn(h, "broker");
    const page = await agent.get("/app/ask/results").query({ q: "شقة في العبور الجديدة", per: 3 });
    expect(page.text).toContain("data-wrong-results");
    expect(page.text).toMatch(/askTrack\.js/);
    expect(page.text).toContain('data-track="sort"');
    const sl = page.text.match(/name="sl" value="([0-9a-f-]{36})"/)[1];
    expect((await agent.post("/app/ask/action").set("X-CSRF-Token", csrf).type("form").send({ sl, action: "page", detail: "2" })).status).toBe(204);
    const rep = await agent.post("/app/ask/report").set("X-CSRF-Token", csrf).type("form").send({ sl, note: "x" });
    expect(rep.status).toBe(303);
    expect((await h.query("SELECT count(*)::int AS n FROM search_reports WHERE search_log_id = $1", [sl]))[0].n).toBe(1);
  });
});

describe("why a project is listed, and the shared card", () => {
  test("each card says what it matched; units=1 hides projects with no unit details; a project that matches nothing is never listed", async () => {
    const r = await search({ place_terms: [AREA], price_max: 3000000 });
    for (const p of r.projects) expect(p.matched).toEqual(expect.arrayContaining(["place", "price"]));
    const placeOnly = await search({ place_terms: [AREA] });
    expect(placeOnly.projects.find((p) => p.name === "Notes Only").matched).toEqual(["place"]);
    const withUnits = await search({ place_terms: [AREA] }, { unitsOnly: true });
    expect(withUnits.projects.every((p) => p.offers_total > 0)).toBe(true);
    expect(names(withUnits)).not.toContain("Notes Only");
    expect(names(await search({ place_terms: ["Sheikh Zayed"], bedrooms_min: 9, bedrooms_max: 9 }))).toEqual([]);
  });

  test("the results page and the catalogue list use the same card; the list is the same search in browse mode", async () => {
    const { agent } = await signIn(h, "broker");
    const ask = await agent.get("/app/ask/results").query({ q: "شقة في العبور الجديدة", per: 3 });
    expect(ask.text).toContain("data-matched");
    expect(ask.text).toContain("pj-card");
    expect(ask.text).toContain('name="units"');
    const place = (await h.query("SELECT id FROM areas WHERE name_en = 'New Obour'"))[0].id;
    const list = await agent.get("/app/catalogue").query({ pl: place });
    expect(list.text).toContain("pj-card pj-browse");
    expect(list.text).toMatch(/data-counts>(\d+ (unit offers|عرض وحدات)|No unit details yet|مفيش تفاصيل وحدات لسه)/);
    expect(list.text).toContain("OBOUR VILLAS");
    const browse = await Search.browse(h.pool, admin, { place });
    expect(browse.total_projects).toBe(11);
    expect(Object.keys(browse.projects[0])).toEqual(expect.arrayContaining(["id", "name", "facts", "price_from", "units", "plans", "offers", "matched"]));
  });
});

describe("Ask answers from the projects that fit, never 'not in our data' over a list that has them", () => {
  const FakeAI = require("../harness/fake-ai");
  test("the model gets the fitting projects as data; if it still says not found, the line written from the list is the answer", async () => {
    FakeAI.reset();
    let prompt = "";
    FakeAI.respond((call) => {
      if (call.operation === "search_parse") return { intent: "search", filters: { place_terms: ["el obour"], bedrooms_min: 3, bedrooms_max: 3, price_max: 4000000 } };
      if (call.operation === "assistant") {
        prompt = String(call.contents);
        return { answer: "That's not in our data.", found: false };
      }
      throw new Error(`unexpected ${call.operation}`);
    });
    const { agent, csrf } = await signIn(h, "broker");
    const res = await agent.post("/app/ask").set("X-CSRF-Token", csrf).type("form").send({ q: "apartment in el obour, 3 bedrooms and price less than 4m" });
    expect(res.status).toBe(200);
    expect(prompt).toContain("Projects in the catalogue that fit the question");
    expect(prompt).toContain("ZEN OBOUR");
    expect(res.text).not.toContain("That&#39;s not in our data");
    expect(res.text).toMatch(/projects? match/i);
    expect(res.text).toContain("data-ask-project");
  });

  test("'el obour' and 'al obour' find the same projects as 'obour'", async () => {
    const a = await search({ place_terms: ["obour"] });
    expect(names(await search({ place_terms: ["el obour"] }))).toEqual(names(a));
    expect(names(await search({ place_terms: ["al obour"] }))).toEqual(names(a));
  });
});
