// tests/unit/chat-dividers.test.js — Chat import: dividers, direction cues, HEIC and the verify flag (pure, no database)
"use strict";

const M = require("../../domain/chatMatch");
const P = require("../../domain/chatParse");

const line = (min, sender, text) => `[24/10/2026, 10:${String(min).padStart(2, "0")}:00] ${sender}: ${text}`;
const D = "➖➖➖";
const POST_A = "شقة 150 متر السعر 5 مليون 3 غرف كود HP1 في التجمع";
const POST_B = "شقة 200 متر السعر 7 مليون 4 غرف كود HP2 في التجمع";
const names = (u) => (u ? u.files.map((f) => f.name) : null);

describe("dividers and cues", () => {
  test("a line of separator marks is a divider; plain text is not", () => {
    for (const d of ["➖➖➖", "🔻🔻🔻", "---", "***", "====="]) expect(P.DIVIDER.test(d)).toBe(true);
    expect(P.DIVIDER.test("ab")).toBe(false);
    expect(P.DIVIDER.test("--")).toBe(false);
  });

  test("photos between dividers belong to the one description there, even in the other order of the chat", () => {
    const chat = [line(0, "A", D), line(1, "A", "<attached: P1.jpg>"), line(1, "A", POST_A), line(2, "A", D), line(3, "A", POST_B), line(3, "A", "<attached: P2.jpg>"), line(4, "A", D)].join("\n");
    const r = M.match(chat, { codes: ["HP1", "HP2"] });
    expect(names(r.units.find((u) => u.code === "HP1"))).toEqual(["P1.jpg"]);
    expect(names(r.units.find((u) => u.code === "HP2"))).toEqual(["P2.jpg"]);
    expect(r.tray).toEqual([]);
    expect(r.stats.dividers).toBe(3);
  });

  test("a divider inside a message (a forward's own separator) splits it", () => {
    const chat = [line(0, "A", POST_A), "---", line(1, "A", POST_B)].join("\n");
    expect(P.parseWithAttachments(chat).filter((m) => m.divider)).toHaveLength(1);
  });

  test("two descriptions with photos between them: a direction cue decides; no cue falls back to the chat's habit and asks to verify", () => {
    const down = [line(0, "A", POST_A + " ⬇️ صور تحت"), line(0, "A", "<attached: P1.jpg>"), line(1, "A", POST_B)].join("\n");
    const r = M.match(down, { codes: ["HP1", "HP2"] });
    expect(names(r.units.find((u) => u.code === "HP1"))).toEqual(["P1.jpg"]);
    expect(r.units.find((u) => u.code === "HP1").verify).toBe(false);

    const up = [line(0, "A", POST_A), line(0, "A", "<attached: P1.jpg>"), line(1, "A", POST_B + " ⬆️ صور فوق")].join("\n");
    const r2 = M.match(up, { codes: ["HP1", "HP2"] });
    expect(names(r2.units.find((u) => u.code === "HP2"))).toEqual(["P1.jpg"]);

    // photos first, text next in three bursts, then a sandwiched run with no cue: the habit wins and the unit is marked.
    const habit = [line(0, "A", "<attached: A1.jpg>"), line(0, "A", POST_A), line(20, "A", "<attached: B1.jpg>"), line(20, "A", POST_B), line(40, "A", POST_A.replace("HP1", "HP1")), line(40, "A", "<attached: S.jpg>"), line(40, "A", POST_B.replace("HP2", "HP2"))].join("\n");
    const r3 = M.match(habit, { codes: ["HP1", "HP2"] });
    expect(r3.pattern).toBe("photos_first");
    expect(r3.units.some((u) => u.verify)).toBe(true);
  });

  test("HEIC photos are read like JPEG ones", () => {
    const chat = [line(0, "A", "<attached: 0001-PHOTO.heic>"), line(0, "A", POST_A)].join("\n");
    expect(names(M.match(chat, { codes: ["HP1"] }).units[0])).toEqual(["0001-PHOTO.heic"]);
  });
});
