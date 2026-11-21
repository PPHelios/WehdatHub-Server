const { phaseOf, phasesOf, editPhaseFields } = require("../../lib/unitPhase");

// Areas: Cairo (top) > Madinaty (compound, sub-zone of Cairo) > B6, B10 (phases) ; Rehab (top area) has no phases.
const AREAS = [
  { id: "cairo", parent_id: null, place_type: "area", name_ar: "القاهرة", name_en: "Cairo" },
  { id: "mad", parent_id: "cairo", place_type: "subzone", name_ar: "مدينتي", name_en: "Madinaty" },
  { id: "b10", parent_id: "mad", place_type: "phase", name_ar: "ب10", name_en: "B10" },
  { id: "b6", parent_id: "mad", place_type: "phase", name_ar: "ب6", name_en: "B6" },
  { id: "reh", parent_id: null, place_type: "area", name_ar: "الرحاب", name_en: "Rehab" },
];

// A tiny stand-in for the database: answers the four queries lib/unitPhase.js makes.
const pool = {
  query: async (sql, args = []) => {
    const id = args[0];
    if (/SELECT name_ar, name_en FROM areas WHERE id/.test(sql)) return { rows: AREAS.filter((a) => a.id === id && a.place_type === "phase") };
    if (/SELECT id, parent_id, place_type FROM areas/.test(sql)) return { rows: AREAS.filter((a) => a.id === id) };
    if (/SELECT id, name_ar, name_en FROM areas WHERE parent_id/.test(sql)) return { rows: AREAS.filter((a) => a.parent_id === id && a.place_type === "phase") };
    if (/SELECT parent_id FROM areas WHERE id/.test(sql)) return { rows: AREAS.filter((a) => a.id === id).map((a) => ({ parent_id: a.parent_id })) };
    throw new Error("unexpected query: " + sql);
  },
};

describe("unit phases", () => {
  it("a unit filed under a phase: that phase is selected, the others are offered, numbers in order", async () => {
    const r = await phasesOf(pool, "b10", null);
    expect(r.list.map((x) => x.label)).toEqual(["ب6", "ب10"]);
    expect((await phasesOf(pool, "b10", null, "en")).list.map((x) => x.label)).toEqual(["B6", "B10"]);
    expect(r.list.find((x) => x.selected).id).toBe("b10");
    expect(r.base).toBe("mad");
  });

  it("a unit on the compound itself: no phase selected, base is the compound", async () => {
    const r = await phasesOf(pool, "mad", null);
    expect(r.list.some((x) => x.selected)).toBe(false);
    expect(r.base).toBe("mad");
  });

  it("a place with no phases returns null, and a top-level area gives an empty base", async () => {
    expect(await phasesOf(pool, "reh", null)).toBeNull();
    expect(await phasesOf(pool, null, null)).toBeNull();
  });

  it("edit fields carry the phase name in the asked language and the JSON the app's box reads", async () => {
    const f = await editPhaseFields(pool, { subzone_id: "b10", area_id: "cairo" });
    expect(f.phase_label).toBe("ب10");
    expect((await editPhaseFields(pool, { subzone_id: "b10", area_id: "cairo" }, "en")).phase_label).toBe("B10");
    expect(JSON.parse(f.place_phases).list).toHaveLength(2);
    expect((await editPhaseFields(pool, { subzone_id: "mad", area_id: "cairo" })).phase_label).toBe("");
    expect(await phaseOf(pool, null)).toEqual({ phase: null, phaseEn: null });
  });
});
