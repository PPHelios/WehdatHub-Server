// tests/unit/chat-dates.test.js — Date orders, Arabic digits, edited markers, since/until of a chat export
"use strict";

const { match, normCode } = require("../../domain/chatMatch");
const P = require("../../domain/chatParse");

const POST = (code) => `شقة ${code} للبيع في التجمع 200 متر 3 غرف السعر 12 مليون`;
const ms = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe("date order is detected once per file", () => {
  test("ar-locale export: Arabic comma, Arabic-Indic digits, ص/م", () => {
    const text = ["٢٤‏/١٠‏/٢٠٢٦،‏ ١٠:١٥ م - أحمد: " + POST("HP-1"), "٢٥/١٠/٢٠٢٦، ٩:٠٥ ص - أحمد: IMG-1.jpg (ملف مرفق)"].join("\n");
    const m = P.parseWithAttachments(text);
    expect(m).toHaveLength(2);
    expect(m[0].t).toBe(ms(2026, 10, 24, 22, 15));
    expect(m[1].t).toBe(ms(2026, 10, 25, 9, 5));
  });

  test("en-US 12h M/D/YY: a second part above 12 makes the whole file M/D, even for 3/4/26", () => {
    const text = [
      "3/4/26, 9:15 AM - Ahmed: " + POST("HP-1"),
      "3/4/26, 11:45 PM - Ahmed: IMG-1.jpg (file attached)",
      "3/15/26, 12:05 AM - Ahmed: hello",
    ].join("\n");
    const m = P.parseWithAttachments(text);
    expect(m[0].t).toBe(ms(2026, 3, 4, 9, 15));
    expect(m[1].t).toBe(ms(2026, 3, 4, 23, 45));
    expect(m[2].t).toBe(ms(2026, 3, 15, 0, 5));
  });

  test("a first part above 12 means D/M", () => {
    expect(P.detectDateOrder(["13/2/2026 10:00", "1/2/2026 10:00"])).toBe("dmy");
  });

  test("all ambiguous: the order that keeps time non-decreasing wins; default D/M", () => {
    expect(P.detectDateOrder(["3/4/26 9:00 AM", "5/4/26 9:00 AM"])).toBe("dmy");
    expect(P.detectDateOrder(["12/1/26 9:00 AM", "1/2/26 9:00 AM"])).toBe("dmy");
    // D/M would run backwards (1 Dec, then 2 Jan); M/D reads Jan 12, then Feb 1
    expect(P.detectDateOrder(["1/12/26 9:00 AM", "2/1/26 9:00 AM"])).toBe("mdy");
    expect(P.detectDateOrder([])).toBe("dmy");
  });

  test("year-first dates parse, with a Latin or Arabic comma and iOS brackets", () => {
    const text = ["[2026-10-24, 10:15:32] Ahmed: " + POST("HP-1"), "2026/10/25،‏ 11:00 - Ahmed: hi"].join("\n");
    const m = P.parseWithAttachments(text);
    expect(m.map((x) => x.t)).toEqual([ms(2026, 10, 24, 10, 15) + 32000, ms(2026, 10, 25, 11, 0)]);
  });
});

describe("edited markers and date-like continuation lines", () => {
  test("a trailing edited marker (English and Arabic) is removed from text and orig", () => {
    const text = [`24/10/2026, 10:15 - Ahmed: ${POST("HP-1")} <This message was edited>`, `24/10/2026, 10:16 - Ahmed: سعر جديد <تم تعديل هذه الرسالة>`].join("\n");
    const m = P.parseWithAttachments(text);
    expect(m[0].text.endsWith("مليون")).toBe(true);
    expect(m[0].orig).not.toMatch(/edited/);
    expect(m[1].text).toBe("سعر جديد");
  });

  test("a continuation line starting with a date and time does not split the post", () => {
    const text = ["24/10/2026, 10:15 - Ahmed: " + POST("HP-1"), "استلام 12/10/2027, 10:00 صباحا", "12/10/2027, 10:00 تسليم", "24/10/2026, 10:20 - Ahmed: next"].join("\n");
    const m = P.parseWithAttachments(text);
    expect(m).toHaveLength(2);
    expect(m[0].text).toMatch(/تسليم$/);
  });

  test("a real system notice still ends the message", () => {
    const text = ["24/10/2026, 10:15 - Ahmed: " + POST("HP-1"), "24/10/2026, 10:16 - Messages and calls are end-to-end encrypted.", "tail"].join("\n");
    expect(P.parseWithAttachments(text)).toHaveLength(1);
  });
});

describe("since / until", () => {
  const lines = [
    `24/10/2026, 09:00 - Ahmed: ${POST("NH-1")}`,
    `24/10/2026, 12:30 - Ahmed: ${POST("NH-2")}`,
    `25/10/2026, 08:00 - Ahmed: ${POST("NH-3")}`,
  ].join("\n");
  const codes = ["NH-1", "NH-2", "NH-3"];
  const got = (o) => match(lines, { codes, ...o }).units.map((u) => u.code);

  test("date string, datetime string, epoch ms", () => {
    expect(got({ since: "2026-10-25" })).toEqual(["NH-3"]);
    expect(got({ since: "2026-10-24T12:30" })).toEqual(["NH-2", "NH-3"]);
    expect(got({ since: "٢٠٢٦-١٠-٢٤T١٢:٣١" })).toEqual(["NH-3"]);
    expect(got({ since: ms(2026, 10, 24, 12, 30) })).toEqual(["NH-2", "NH-3"]);
  });

  test("until is an exclusive upper bound", () => {
    expect(got({ until: "2026-10-24T12:30" })).toEqual(["NH-1"]);
    expect(got({ until: "2026-10-25" })).toEqual(["NH-1", "NH-2"]);
    expect(got({ since: "2026-10-24T10:00", until: ms(2026, 10, 25, 8, 0) })).toEqual(["NH-2"]);
  });

  test("no bounds: everything; bad bound: ignored", () => {
    expect(got({})).toEqual(["NH-1", "NH-2", "NH-3"]);
    expect(got({ since: "nonsense", until: null })).toEqual(["NH-1", "NH-2", "NH-3"]);
  });

  test("en-US file with since/until uses the detected order", () => {
    const us = [`10/24/26, 9:00 AM - A: ${POST("NH-1")}`, `10/25/26, 8:00 AM - A: ${POST("NH-2")}`].join("\n");
    const r = match(us, { codes, since: "2026-10-25" });
    expect(r.units.map((u) => u.code)).toEqual(["NH-2"]);
  });
});

describe("codes compare by normCode", () => {
  test("HP-12 and HP12 are one unit; aliases land on the app's spelling", () => {
    expect(normCode("hp 12")).toBe(normCode("HP-12"));
    const text = [`24/10/2026, 10:00 - A: ${POST("HP12")}`, `24/10/2026, 10:01 - A: ${POST("hp-12")}`, `24/10/2026, 10:02 - A: ${POST("zz9")}`].join("\n");
    const r = match(text, { codes: ["HP-12", "AB-5"], aliases: { "zz 9": "ab5" } });
    expect(r.units.map((u) => [u.code, u.messages])).toEqual([["HP-12", 2], ["AB-5", 1]]);
    expect(r.noPhotos).toEqual(["HP-12", "AB-5"]);
  });
});
