"use strict";

// Ask's catalog answer: which words name a project, which project matches, which note lines answer, and the reply's date line.
const PA = require("../../services/projectAnswer");

const NOTES = "خبر عاجل! 🔥يونت 153م الدور الاول سعرها بعد خصم 15% =3,180,590 مقدم 5% = 159,029 __ 🔥يونت 110 الدور التاني سعرها بعد خصم 15% = 2,862,554 مقدم 5% = 143,127 __ مقدم يبدأ من 5% وتقسيط يصل إلى 9 سنين";

const PROJECT = {
  name: "جزيل ريزدنس",
  name_en: "JAZEEL RESIDENCE",
  developer_name: "الفتح جروب",
  district: "obour",
  city: "cairo",
  status: "selling",
  delivery_year: 2029,
  notes: NOTES,
  updated_at: "2026-11-07T10:00:00Z"
};

describe("project catalog answer", () => {
  test("the request's words drop generic words and numbers", () => {
    const words = PA.nameWords("يومت ١١٠ متر في جزيل ريزيدنس");
    expect(words).toContain("جزيل");
    expect(words.some((w) => /\d/.test(w))).toBe(false);
    expect(words).not.toContain("ريزيدنس");
  });

  test("numbers in the request are read in Western digits", () => {
    expect(PA.requestNumbers("يومت ١١٠ متر")).toEqual(["110"]);
  });

  test("a project matches by its Arabic name, and a generic word alone matches nothing", () => {
    expect(PA.matchProjects([PROJECT], ["جزيل"])).toEqual([PROJECT]);
    expect(PA.matchProjects([PROJECT], PA.nameWords("كمبوند"))).toEqual([]);
  });

  test("with a number asked, only the note lines that mention it are used", () => {
    const lines = PA.noteLines(NOTES, ["110"]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("110");
    expect(lines[0]).toContain("2,862,554");
  });

  test("the reply says the answer comes from the catalog and gives the update date", () => {
    const text = PA.projectReply(PROJECT, "يومت ١١٠ متر في جزيل ريزيدنس", "ar");
    expect(text).toContain("2,862,554");
    expect(text).toContain("من بيانات المشروع في الكتالوج");
    expect(text).toContain("آخر تحديث: 2026-11-07");
  });
});
