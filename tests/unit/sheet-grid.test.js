// tests/unit/sheet-grid.test.js — Tabs of cells → the rows the import plans, and the facts hidden in one cell.
"use strict";

const { buildSheet, typeFromName } = require("../../lib/sheetGrid");
const SheetImport = require("../../domain/sheetImport");
const Mixed = require("../../domain/sheetMixed");

const row = (n, ...v) => ({ n, v });
const HEAD = ["name", "number", "unit type", "location", "price", "details", "area", "descibation", "code"];

describe("tabs", () => {
  test("every tab is read, the tab name is the compound, rent comes from the file name, typo headers are understood", () => {
    const sheet = buildSheet(
      [
        { name: "villette", rows: [row(1, ...HEAD), row(2, "Wafaa", 1069985171, "apartment", "Villette (u1-1310)", "65K", "2 Bedrooms (1 master) / 3 Bathrooms", "160m", "fully furnished", "Vr1")] },
        { name: "Mivida", rows: [row(1, ...HEAD), row(2, "Maged", 1019956161, "standalone villa", "parcel22", "3000$", "3 bedrooms / 4 bathrooms", "land 600 m / built up 244 m", "finished", "MIr1")] }
      ],
      { filename: "RENT - All compounds.xlsx" }
    );
    expect(sheet.rows.map((r) => [r.tab, r.sheetRow, r.cells.compound, r.cells.listing_type])).toEqual([
      ["villette", 2, "villette", "rent"],
      ["Mivida", 2, "Mivida", "rent"]
    ]);
    expect(sheet.rows.map((r) => r.rowNumber)).toEqual([1, 2]);
    const draft = SheetImport.rowToDraft(sheet.rows[0].cells).draft;
    expect(draft).toMatchObject({ price_value: 65000, area_value: 160, bedrooms: 2, bathrooms: 3, compound: "villette", listing_type: "rent" });
    expect(draft.details).toMatchObject({ owner_name: "Wafaa", owner_phone: "01069985171", address: "Villette (u1-1310)" });
    expect(sheet.tabs.map((t) => t.mode)).toEqual(["headers", "headers"]);
  });

  test("a header row missing an empty column (every name shifted one place) is put back by the content", () => {
    const data = [];
    for (let i = 2; i < 12; i++) data.push(row(i, `owner${i}`, 1001000000 + i, "apartment", `loc ${i}`, null, `${20 + i}k`, "3 bedrooms / 2 bathrooms", `${150 + i}m`, "finished", `NC${i}`));
    const sheet = buildSheet([{ name: "New Cairo", rows: [row(1, ...HEAD), ...data] }]);
    expect(sheet.tabs[0].shifted).toBe(true);
    const c = sheet.rows[0].cells;
    expect(c.price_value).toBe("22k");
    expect(c.code).toBe("NC2");
    expect(c.area_value).toBe("152m");
  });

  test("a tab with no header row has its columns recognised by what they hold", () => {
    const data = [];
    const NAMES = ["Ahmed Hassan", "Sara Ali", "Mona Said", "Omar Fathy", "Hala Nour", "Karim Adel", "Dina Samir", "Tarek Wael", "Laila Amr", "Youssef Hany", "Rana Khaled", "Ziad Magdy"];
    for (let i = 0; i < 12; i++) data.push(row(i + 1, NAMES[i], `0100${1000000 + i}`, "apartment", `${30 + i}k`, `${120 + i} m`, `AB-${i + 1}`));
    const sheet = buildSheet([{ name: "El Patio", rows: data }]);
    expect(sheet.tabs[0].mode).toBe("content");
    const c = sheet.rows[0].cells;
    expect(c).toMatchObject({ owner_name: "Ahmed Hassan", owner_phone: "01001000000", property_type: "apartment", price_value: "30k", area_value: "120 m", code: "AB-1", compound: "El Patio" });
  });

  test("a row with fewer than two real values is dropped, a punctuation-only cell counts as empty, hidden-name tabs are not places", () => {
    const sheet = buildSheet([{ name: "Sheet1", rows: [
      row(1, ...HEAD, "extra"),
      row(2, "a", 1001, "villa", "x", "10k", "3 bed", "100m", "d", "C1"),
      row(3, null, null, null, null, null, null, null, null, null, "memo"), // text only in an unknown column
      row(4, null, null, null, null, "65000", null, null, null, null), // one stray number
      row(5, null, "-", "`", null, "70k", null, null, null, null), // punctuation + one number
      row(6, null, null, "`", null, "65k", null, "160m", null, null) // a real unit with a junk type
    ] }]);
    expect(sheet.skipped).toEqual([]);
    expect(sheet.rows.map((r) => r.sheetRow)).toEqual([2, 6]);
    expect(sheet.rows[1].cells.property_type).toBeUndefined();
    expect(sheet.rows[0].cells.compound).toBeUndefined();
  });

  test("one long text is kept as free text (notes) whatever its column; n/a and a short word or stray number are dropped", () => {
    const long = "شقة 3 غرف 150م التجمع الخامس 4 مليون 01012345678";
    const sheet = buildSheet([{ name: "Sheet1", rows: [
      row(1, ...HEAD),
      row(2, "a", 1001, "villa", "x", "10k", "3 bed", "100m", "d", "C1"),
      row(3, null, null, null, null, null, null, null, null, long), // the long text sits in the code column
      row(4, "n/a", "لا يوجد", null, null, "n/a", null, null, null, null), // only "nothing" words
      row(5, null, null, null, null, null, null, null, null, "villa"), // one short word
      row(6, null, null, null, null, "65000", null, null, null, null) // one stray number
    ] }]);
    expect(sheet.rows.map((r) => r.sheetRow)).toEqual([2, 3]);
    expect(sheet.rows[1].cells).toEqual({ notes: long });
  });

  test("a lone long line with no digit or no space (a footer) is dropped", () => {
    const sheet = buildSheet([{ name: "Sheet1", rows: [
      row(1, ...HEAD),
      row(2, "a", 1001, "villa", "x", "10k", "3 bed", "100m", "d", "C1"),
      row(3, null, null, null, null, null, null, null, null, "Prepared by Ahmed Hassan"), // long, no digit
      row(4, null, null, null, null, null, null, null, null, "0100123456789012345"), // digits, no space
      row(5, null, null, null, null, null, null, null, null, "Total units listed: 120") // long, digit and space: kept
    ] }]);
    expect(sheet.rows.map((r) => r.sheetRow)).toEqual([2, 5]);
  });

  test("rent or sale from a name: only when it says one of them", () => {
    expect(typeFromName("RENT - All compounds")).toBe("rent");
    expect(typeFromName("للبيع - كل الكمبوندات")).toBe("sale");
    expect(typeFromName("Rent and sale")).toBeNull();
    expect(typeFromName("Inventory")).toBeNull();
  });

  test("no tabs, or no columns anyone knows, stops with a clear code", () => {
    expect(() => buildSheet([])).toThrow(expect.objectContaining({ code: "NO_TABS" }));
    expect(() => buildSheet([{ name: "x", rows: [row(1, "foo", "bar"), row(2, "a", "b")] }])).toThrow(expect.objectContaining({ code: "NO_HEADER" }));
  });
});

describe("one cell, several facts", () => {
  test("rooms, areas and a price are read from free text", () => {
    expect(Mixed.rooms("3 berooms / 4 bathrooms / nanny room")).toEqual({ bedrooms: 3, bathrooms: 4 });
    expect(Mixed.rooms("شقة 3 غرف و 2 حمام")).toEqual({ bedrooms: 3, bathrooms: 2 });
    expect(Mixed.areas("land 600 m / built up 244 m")).toEqual({ area_value: 244, land_area: 600 });
    expect(Mixed.areas("500m land / 290m bua")).toEqual({ area_value: 290, land_area: 500 });
    expect(Mixed.areas("160 sqm")).toEqual({ area_value: 160 });
    expect(Mixed.priceText("60k negotiable")).toEqual({ price_value: 60000, rest: "negotiable" });
    expect(Mixed.priceText("3000$")).toEqual({ foreign: true });
    expect(Mixed.priceText("long 90k / short 100k / day 6k")).toEqual({ ambiguous: true });
  });

  test("a description with the facts in it fills what the row leaves empty, and never overrides a stated cell", () => {
    const a = SheetImport.rowToDraft({ code: "X1", property_type: "apartment", listing_type: "rent", compound: "C", description: "3 bedrooms 2 bathrooms 150 sqm price 40k" });
    expect(a.draft).toMatchObject({ bedrooms: 3, bathrooms: 2, area_value: 150, price_value: 40000 });
    expect(a.derived.sort()).toEqual(["area_value", "bathrooms", "bedrooms", "price_value"]);
    const b = SheetImport.rowToDraft({ code: "X1", bedrooms: 4, description: "3 bedrooms" });
    expect(b.draft.bedrooms).toBe(4);
  });

  test("a price with words keeps the amount and the words go to the notes; dollars and several prices are held back", () => {
    const a = SheetImport.rowToDraft({ code: "X1", price_value: "60k بخلاف العمولات" });
    expect(a.draft.price_value).toBe(60000);
    expect(a.draft.details.notes).toContain("بخلاف العمولات");
    expect(SheetImport.rowToDraft({ code: "X1", price_value: "3000$" }).errors).toEqual(["currency"]);
    expect(SheetImport.rowToDraft({ code: "X1", price_value: "long 90k / short 100k" }).errors).toEqual(["price_value"]);
  });

  test("two phone numbers: the first is the owner's, the other goes to the notes; a ten-digit number gets its 0", () => {
    const d = SheetImport.rowToDraft({ code: "X1", owner_phone: "1001222400/ 1275615557" }).draft;
    expect(d.details.owner_phone).toBe("01001222400");
    expect(d.details.notes).toContain("01275615557");
  });

  test("a typo in a type or a header is still understood; a code with spaces is one code", () => {
    expect(SheetImport.propertyType("apatment")).toBe("apartment");
    expect(SheetImport.propertyType("penthous")).toBe("penthouse");
    expect(SheetImport.propertyType("twon house")).toBe("townhouse");
    expect(SheetImport.propertyType("triplex")).toBe("triplex");
    expect(SheetImport.propertyType("zebra")).toBeNull();
    expect(SheetImport.columnFor("descibation ")).toBe("description");
    expect(SheetImport.columnFor("deatils")).toBe("details_text");
    expect(SheetImport.rowToDraft({ code: "MVICr 128" }).code).toBe("MVICR128");
  });

  test("one price out of several, and dollars", () => {
    expect(Mixed.pickPrice("long 90k / short 100k / day 6k", "long")).toBe(90000);
    expect(Mixed.pickPrice("month 160k /year140k /day 8k", "long")).toBe(160000);
    expect(Mixed.pickPrice("100k / day 5k", "first")).toBe(100000);
    expect(Mixed.pickPrice("100k / day 5k", "long")).toBeNull();
    expect(Mixed.dollars("2000$")).toBe(2000);
    expect(Mixed.dollars("1000$ \\ 50k")).toBeNull();
  });
});

describe("code pattern and room words", () => {
  const SheetGrid = require("../../lib/sheetGrid");
  const Mixed = require("../../domain/sheetMixed");

  test("a pattern needs three coded rows with a clear majority", () => {
    expect(SheetGrid.codePattern(["NH-1", "NH-2", "NH-9"])).toMatchObject({ prefix: "NH", sep: "-", max: 9, width: 0 });
    expect(SheetGrid.codePattern(["vr01", "VR02", "VR10"])).toMatchObject({ prefix: "VR", sep: "", width: 2, max: 10 });
    expect(SheetGrid.codePattern(["NH-1", "NH-2"])).toBeNull();
    expect(SheetGrid.codePattern(["A1", "B2", "C3", "A4"])).toBeNull();
  });

  test("bedrooms and bathrooms in short, labelled, Arabic and mixed forms", () => {
    expect(Mixed.rooms("3BR/2BA")).toEqual({ bedrooms: 3, bathrooms: 2 });
    expect(Mixed.rooms("bedrooms: 4 bathrooms: 3")).toEqual({ bedrooms: 4, bathrooms: 3 });
    expect(Mixed.rooms("3 غرف نوم و 2 حمام")).toEqual({ bedrooms: 3, bathrooms: 2 });
    expect(Mixed.rooms("2 Bedrooms (1 master) / 3 Bathrooms")).toEqual({ bedrooms: 2, bathrooms: 3 });
    expect(Mixed.areas("ارض 600 م مباني 244 م")).toEqual({ area_value: 244, land_area: 600 });
  });
});

describe("compound column that says no compound", () => {
  test("'outside' in the compound column reads the compound from the location column", () => {
    const head = ["name", "number", "unit type", "compound", "location", "price", "area", "code"];
    const sheet = buildSheet([{ name: "Sheet1", rows: [row(1, ...head), row(2, "Ali", 1011111111, "apartment", "outside", "Rehab 1, 3rd floor", "8m", "120m", "A1"), row(3, "Sam", 1022222222, "apartment", "Mivida", "u12", "9m", "130m", "A2")] }]);
    expect(sheet.rows.map((r) => r.cells.compound)).toEqual(["Rehab 1, 3rd floor", "Mivida"]);
  });
});

describe("header synonyms and cleaner header choice", () => {
  const key = (h) => SheetImport.columnFor(h);

  test("rent, size, rooms and phone words are known; 'Area name' is a place, not the size", () => {
    for (const h of ["Rent", "الإيجار", "Monthly rent", "سعر البيع", "Selling price"]) expect([h, key(h)]).toEqual([h, "price_value"]);
    for (const h of ["Size", "م2", "Built up area", "Area", "Area (sqm)", "المساحة بالمتر"]) expect([h, key(h)]).toEqual([h, "area_value"]);
    expect(key("Area name")).toBe("district");
    expect(key("Rooms")).toBe("bedrooms");
    expect(key("Bathrooms")).toBe("bathrooms");
    for (const h of ["WhatsApp", "الهاتف", "Mobile number"]) expect([h, key(h)]).toEqual([h, "owner_phone"]);
    expect(key("Rent / Sale")).toBe("listing_type");
  });

  test("installment years are the length, not the amount; Arabic typos are still the column", () => {
    expect(key("Installment years")).toBe("installment_years");
    expect(key("سنوات القسط")).toBe("installment_years");
    expect(key("Installment")).toBe("installment_value");
    expect(key("الكمبواند")).toBe("compound");
    expect(key("المساحة")).toBe("area_value");
  });

  test("an 'Area' column full of place names is the district", () => {
    const head = ["code", "area", "price", "size", "type"];
    const sheet = buildSheet([{ name: "x", rows: [row(1, ...head), row(2, "A1", "Fifth Settlement", "5m", 120, "apartment"), row(3, "A2", "Sheikh Zayed", "6m", 130, "apartment"), row(4, "A3", "Rehab", "7m", 140, "apartment")] }]);
    expect(sheet.rows[0].cells).toMatchObject({ district: "Fifth Settlement", area_value: 120 });
  });

  test("the best header row wins, not the first that qualifies; group labels above name the sub-headers", () => {
    const sheet = buildSheet([
      {
        name: "Hyde Park",
        rows: [
          row(1, "code", "price", "type"),
          row(2, null, null, null, null, "Payment", null),
          row(3, "code", "compound", "price", "area", "Down", "Years", "type"),
          row(4, "A1", "Hyde", "8m", 150, "1m", 5, "apartment")
        ]
      }
    ]);
    expect(sheet.tabs[0].mapped).toEqual(expect.arrayContaining(["down_payment_value", "installment_years", "area_value"]));
    expect(sheet.rows[0].cells).toMatchObject({ code: "A1", price_value: "8m", down_payment_value: "1m", installment_years: 5 });
  });

  test("the re-uploaded 'rows not imported' file does not turn its tab name into a compound", () => {
    for (const name of ["Not imported", "مش متسجل"]) {
      const sheet = buildSheet([{ name, rows: [row(1, "code", "price", "area"), row(2, "A1", "5m", 100)] }]);
      expect(sheet.rows[0].cells.compound).toBeUndefined();
    }
  });
});

describe("numbers in cells", () => {
  const draft = (cells) => SheetImport.rowToDraft(cells);

  test("no code column is fine: price and area are the only required columns", () => {
    expect(SheetImport.REQUIRED).toEqual(["price_value", "area_value"]);
    expect(SheetImport.emptyRequired([{ cells: { price_value: "5m", area_value: 100 } }])).toEqual([]);
  });

  test("'3+1' rooms is 3 with a note; ranges take the low value with a note and are never joined", () => {
    const a = draft({ bedrooms: "3+1", area_value: "120-130" });
    expect(a.draft).toMatchObject({ bedrooms: 3, area_value: 120 });
    expect(a.draft.details.notes).toMatch(/3\+1/);
    expect(a.draft.details.notes).toMatch(/120-130/);
    expect(draft({ bedrooms: "3-4" }).draft.bedrooms).toBe(3);
    expect(draft({ bedrooms: "3" }).draft.details.notes).toBeUndefined();
  });

  test("Persian and Arabic digits, ٫ decimals and ٬ thousands", () => {
    expect(draft({ area_value: "۱۲۰" }).draft.area_value).toBe(120);
    expect(draft({ area_value: "١٢٠٫٥" }).draft.area_value).toBe(120.5);
    expect(SheetImport.money("٨٫٥ مليون")).toBe(8500000);
    expect(SheetImport.money("٨٬٥٠٠٬٠٠٠")).toBe(8500000);
  });

  test("a single comma before a unit word is a decimal mark", () => {
    expect(SheetImport.money("8,5 مليون")).toBe(8500000);
    expect(SheetImport.money("2,25 million")).toBe(2250000);
    expect(SheetImport.money("8,500,000")).toBe(8500000);
    expect(SheetImport.money("65,000")).toBe(65000);
  });
});
