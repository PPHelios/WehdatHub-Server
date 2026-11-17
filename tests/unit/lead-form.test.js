// tests/unit/lead-form.test.js — A lead message written from a template (a portal enquiry, a Meta lead form, "Name: ... Phone: ...")
// is read by rules: the name and number the message states, the portal as the source, the link kept in the notes. The greeting
// ("Hi Kenzy Emad") is never the client. A message that is not laid out that way reads as before.
"use strict";

const I = require("../../domain/leadIntake");

const BAYUT = `Hi Kenzy Emad, 
You have received a new enquiry on Bayut. 
Take a look at the details of your lead and get in touch with them soon so you can convert successfully! Enquirer Details: 
Name: Khaled El-Sawy 
Property Link: https://www.bayut.eg/pm/503956661/2662e7a7-7689-4a1c-9803-42d7977cf71a
`;

describe("a Bayut enquiry with no number", () => {
  test("is offered as a lead; name, source and link are read; the greeting is not the client", () => {
    expect(I.looksLikeLead(BAYUT)).toBe(true);
    const r = I.readLeadText(BAYUT);
    expect(r).toMatchObject({ name: "Khaled El-Sawy", phones: [], source: "Bayut", request: null });
    expect(r.note).toContain("https://www.bayut.eg/pm/503956661/2662e7a7-7689-4a1c-9803-42d7977cf71a");
  });

  test("the same enquiry with a number in it keeps the number", () => {
    const r = I.readLeadText(`${BAYUT}Phone: +20 101 234 5678`);
    expect(r.phones).toEqual(["+201012345678"]);
    expect(r.name).toBe("Khaled El-Sawy");
  });
});

describe("a Meta or website form", () => {
  const FB = "Full name: Mona Adel\nphone_number: +201012345678\nemail: m@x.com\nbudget: 5 مليون\nbedrooms: 3\nlocation: التجمع\nplatform: fb";
  test("name, number, source and the request are read from the labels", () => {
    expect(I.looksLikeLead(FB)).toBe(true);
    const r = I.readLeadText(FB);
    expect(r).toMatchObject({ name: "Mona Adel", phones: ["+201012345678"], source: "Facebook" });
    expect(r.note).toContain("m@x.com");
    expect(r.request).toMatchObject({ price_max: 5000000, bedrooms_min: 3 });
  });
});

describe("not a template", () => {
  test("a unit post with a label or two is not a lead; a plain lead line reads as before", () => {
    expect(I.looksLikeLead("الاسم: محمد\nشقة للبيع 120 متر السعر 3 مليون")).toBe(false);
    expect(I.looksLikeLead("الاسم: محمد\nكود: A12\nشقة للبيع 120 متر السعر 3 مليون 01012345678")).toBe(false);
    expect(I.readLeadText("ليد احمد سمير 01012345678 عايز شقة في التجمع 3 غرف")).toMatchObject({ name: "احمد سمير", phones: ["+201012345678"], source: null });
    expect(I.readLeadForm("hello there")).toBeNull();
  });
});
