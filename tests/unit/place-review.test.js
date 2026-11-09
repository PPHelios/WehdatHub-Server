"use strict";

// The owner's review of new places: grouping alike names, the hourly limit per broker, approve / merge / reject for compounds and areas.
jest.mock("../../lib/notifications", () => ({ ...jest.requireActual("../../lib/notifications"), notifyBroker: jest.fn(async () => ({ id: 1 })) }));

const Notifications = require("../../lib/notifications");
const R = require("../../domain/placeReview");
const PN = require("../../lib/placeNames");
const Review = require("../../services/placeReview");
const SystemAlerts = require("../../services/systemAlerts");
const { createTestDb } = require("../harness/db");

jest.setTimeout(60000);

describe("grouping pending names", () => {
  const existing = [
    { kind: "compound", id: "p1", name_en: "Mivida", name_ar: "ميفيدا", aliases: [], path: "New Cairo" },
    { kind: "area", id: "a1", name_en: "New Cairo", name_ar: "القاهرة الجديدة", aliases: [], path: "" }
  ];
  test("alike names form one group and show the place they may duplicate", () => {
    const pending = [
      { kind: "compound", id: "n1", name_en: "Mivida Compound", times_seen: 2 },
      { kind: "compound", id: "n2", name_en: "mivida", times_seen: 1 },
      { kind: "compound", id: "n3", name_en: "Sun Valley", times_seen: 5 }
    ];
    const groups = R.groupPending(pending, existing);
    expect(groups).toHaveLength(2);
    const mivida = groups.find((g) => g.items.some((i) => i.id === "n1"));
    expect(mivida.items.map((i) => i.id).sort()).toEqual(["n1", "n2"]);
    expect(mivida.matches[0]).toMatchObject({ id: "p1", exact: true });
    expect(groups[0].lead.id).toBe("n3");
    expect(groups.find((g) => g.lead.id === "n3").matches).toEqual([]);
  });
  test("a pending compound is never matched to an area", () => {
    const groups = R.groupPending([{ kind: "compound", id: "n1", name_en: "New Cairo", times_seen: 1 }], existing);
    expect(groups[0].matches.map((m) => m.id)).not.toContain("a1");
  });
});

describe("review in the database", () => {
  let db;
  let broker;
  let area;
  let sub;
  beforeAll(async () => {
    db = await createTestDb();
    const { rows: [a] } = await db.pool.query("INSERT INTO agencies (name) VALUES ('Review Agency') RETURNING id");
    ({ rows: [broker] } = await db.pool.query("INSERT INTO brokers (agency_id, phone_number, name, role, is_active, preferred_lang) VALUES ($1, '201000000077', 'Rev', 'broker', true, 'en') RETURNING id, agency_id, name, role, is_active, preferred_lang", [a.id]));
    ({ rows: [area] } = await db.pool.query("SELECT id FROM areas WHERE name_en = 'New Cairo' AND parent_id IS NULL"));
    ({ rows: [sub] } = await db.pool.query("SELECT id FROM areas WHERE name_en = 'Golden Square'"));
  });
  beforeEach(() => Notifications.notifyBroker.mockClear());
  afterAll(() => db.pool.end());

  const nameRow = async (n) => (await db.pool.query("SELECT * FROM place_names WHERE name_en = $1", [n])).rows[0];

  test("a new name is queued once with its proposer; the same name again only counts", async () => {
    expect((await PN.noteUnknown(db.pool, "Sun Valley", { brokerId: broker.id })).status).toBe("new");
    expect((await PN.noteUnknown(db.pool, "Sun Valley", { brokerId: broker.id })).status).toBe("pending");
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM place_proposals WHERE broker_id = $1", [broker.id]);
    expect(rows[0].n).toBe(1);
  });

  test("a broker can queue five new things an hour; the sixth is not queued, an import counts as one", async () => {
    for (const n of ["Alpha Hills", "Beta Hills", "Gamma Hills", "Delta Hills"]) expect((await PN.noteUnknown(db.pool, n, { brokerId: broker.id })).status).toBe("new");
    expect((await PN.noteUnknown(db.pool, "Epsilon Hills", { brokerId: broker.id })).status).toBe("limited");
    expect(await nameRow("Epsilon Hills")).toBeUndefined();
    expect((await PN.noteUnknown(db.pool, "Alpha Hills", { brokerId: broker.id })).status).toBe("pending");
    await db.pool.query("DELETE FROM place_proposals");
    for (const n of ["Imp One", "Imp Two", "Imp Three", "Imp Four", "Imp Five", "Imp Six", "Imp Seven"]) {
      expect((await PN.noteUnknown(db.pool, n, { brokerId: broker.id, batch: "excel-1" })).status).toBe("new");
    }
    await db.pool.query("DELETE FROM place_proposals");
  });

  test("approving needs an area; it makes the place, turns the group's other names into aliases, and refuses a sub-zone from elsewhere", async () => {
    const lead = await nameRow("Sun Valley");
    await PN.noteUnknown(db.pool, "Sunvalley Compound", { brokerId: broker.id });
    const other = await nameRow("Sunvalley Compound");
    expect(await Review.approveCompound(db.pool, lead.id, { name_en: "Sun Valley" })).toEqual({ error: "needs_area" });
    const { rows: [sz] } = await db.pool.query("SELECT id FROM areas WHERE name_en = 'Sheikh Zayed'");
    expect(await Review.approveCompound(db.pool, lead.id, { name_en: "Sun Valley", area_id: sz.id, subzone_id: sub.id })).toEqual({ error: "bad_subzone" });
    const r = await Review.approveCompound(db.pool, lead.id, { name_en: "Sun Valley", name_ar: "صن فالي", area_id: area.id, subzone_id: sub.id, also: [other.id], aliases: "SV" });
    expect(r.ok).toBe(true);
    const { rows: [p] } = await db.pool.query("SELECT * FROM map_places WHERE id = $1", [r.place_id]);
    expect(p).toMatchObject({ name_en: "Sun Valley", name_ar: "صن فالي", approved: true, area_id: area.id, subzone_id: sub.id, lat: null });
    expect(p.aliases).toEqual(expect.arrayContaining(["Sunvalley Compound", "SV"]));
    expect((await nameRow("Sun Valley")).status).toBe("approved");
    expect((await nameRow("Sunvalley Compound")).status).toBe("merged");
    expect((await PN.noteUnknown(db.pool, "Sun Valley", {})).status).toBe("approved");
    expect(await Review.approveCompound(db.pool, lead.id, { name_en: "Sun Valley", area_id: area.id })).toEqual({ error: "not_pending" });
  });

  test("merging adds the names to an existing place as aliases", async () => {
    await PN.noteUnknown(db.pool, "Sun Valli", { brokerId: broker.id });
    const n = await nameRow("Sun Valli");
    const { rows: [p] } = await db.pool.query("SELECT id FROM map_places WHERE name_en = 'Sun Valley'");
    expect((await Review.mergeCompound(db.pool, n.id, p.id)).ok).toBe(true);
    const { rows: [after] } = await db.pool.query("SELECT aliases FROM map_places WHERE id = $1", [p.id]);
    expect(after.aliases).toContain("Sun Valli");
    expect((await nameRow("Sun Valli")).status).toBe("merged");
  });

  test("rejecting needs a reason, tells the proposer, and the name stays rejected", async () => {
    await PN.noteUnknown(db.pool, "Fake Place", { brokerId: broker.id });
    const n = await nameRow("Fake Place");
    expect(await Review.rejectName(db.pool, n.id, "")).toEqual({ error: "reason" });
    expect((await Review.rejectName(db.pool, n.id, "Not a compound")).ok).toBe(true);
    expect(Notifications.notifyBroker).toHaveBeenCalledTimes(1);
    expect(Notifications.notifyBroker.mock.calls[0][2]).toMatchObject({ kind: "place_review", body: expect.stringContaining("Not a compound") });
    expect(Notifications.notifyBroker.mock.calls[0][1].id).toBe(broker.id);
    expect((await PN.noteUnknown(db.pool, "Fake Place", { brokerId: broker.id })).status).toBe("rejected");
  });

  test("a proposed area waits as pending; a known one is returned; approve, merge and reject work", async () => {
    await db.pool.query("DELETE FROM place_proposals");
    const known = await Review.proposeArea(db.pool, broker.id, { name_en: "new cairo" });
    expect(known.status).toBe("known");
    const p1 = await Review.proposeArea(db.pool, broker.id, { name_en: "Hay El Sefarat", parent_id: area.id });
    expect(p1.status).toBe("pending");
    expect((await Review.proposeArea(db.pool, broker.id, { name_en: "Hay El Sefarat", parent_id: area.id })).status).toBe("pending");
    expect((await Review.approveArea(db.pool, p1.id, { name_ar: "حي السفارات" })).ok).toBe(true);
    const { rows: [ok] } = await db.pool.query("SELECT status, name_ar FROM areas WHERE id = $1", [p1.id]);
    expect(ok).toEqual({ status: "approved", name_ar: "حي السفارات" });

    const p2 = await Review.proposeArea(db.pool, broker.id, { name_en: "Golden Sq", parent_id: area.id });
    await db.pool.query("INSERT INTO map_places (name_key, name_en, area_id, subzone_id) VALUES ('uses golden sq', 'Uses Golden Sq', $1, $2)", [area.id, p2.id]);
    expect((await Review.mergeArea(db.pool, p2.id, sub.id)).ok).toBe(true);
    const { rows: [moved] } = await db.pool.query("SELECT area_id, subzone_id FROM map_places WHERE name_key = 'uses golden sq'");
    expect(moved).toEqual({ area_id: area.id, subzone_id: sub.id });
    expect((await db.pool.query("SELECT 1 FROM areas WHERE id = $1", [p2.id])).rowCount).toBe(0);
    const { rows: [gs] } = await db.pool.query("SELECT aliases FROM areas WHERE id = $1", [sub.id]);
    expect(gs.aliases).toContain("Golden Sq");

    Notifications.notifyBroker.mockClear();
    const p3 = await Review.proposeArea(db.pool, broker.id, { name_en: "Nowhere" });
    await db.pool.query("INSERT INTO map_places (name_key, name_en, area_id) VALUES ('uses nowhere', 'Uses Nowhere', $1)", [p3.id]);
    expect(await Review.rejectArea(db.pool, p3.id, "")).toEqual({ error: "reason" });
    expect((await Review.rejectArea(db.pool, p3.id, "Not a real area")).ok).toBe(true);
    const { rows: [gone] } = await db.pool.query("SELECT area_id FROM map_places WHERE name_key = 'uses nowhere'");
    expect(gone.area_id).toBeNull();
    expect(Notifications.notifyBroker).toHaveBeenCalledTimes(1);
  });

  test("the owner gets one alert an hour that counts the new places together", async () => {
    await db.pool.query("UPDATE place_names SET status = 'rejected' WHERE status = 'pending'");
    await db.pool.query("UPDATE areas SET status = 'rejected' WHERE status = 'pending'");
    await PN.noteUnknown(db.pool, "Digest One", {});
    await PN.noteUnknown(db.pool, "Digest Two", {});
    const now = new Date();
    const first = (await SystemAlerts.due(db.pool, { now })).filter((a) => a.key.startsWith("places:"));
    expect(first).toHaveLength(1);
    expect(first[0].title).toMatch(/2 new places waiting/);
    const later = (await SystemAlerts.due(db.pool, { now: new Date(now.getTime() + 2 * 3600 * 1000) })).filter((a) => a.key.startsWith("places:"));
    expect(later).toHaveLength(0);
  });
});
