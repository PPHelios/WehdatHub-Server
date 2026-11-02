// tests/crm/portal-enquiry-parse.test.js — Reading a forwarded portal enquiry (pure): portal, name, link, listing number.
"use strict";

const { parse } = require("../../domain/portalEnquiry");

test("Bayut, Dubizzle and Nawy use one format: the portal, the name and the link are read; nothing is guessed", () => {
  expect(parse("You have received a new enquiry on Bayut.\nName: Khaled El-Sawy \nProperty Link: https://www.bayut.eg/pm/503956661/2662e7a7-7689-4a1c-9803-42d7977cf71a")).toEqual({
    portal: "Bayut",
    name: "Khaled El-Sawy",
    link: "https://www.bayut.eg/pm/503956661/2662e7a7-7689-4a1c-9803-42d7977cf71a",
    listingNo: "503956661"
  });
  expect(parse("You have received a new enquiry on Dubizzle.\r\nName: Sara\r\nhttps://dubizzle.com/property-for-sale/x-12345678.html")).toMatchObject({ portal: "Dubizzle", name: "Sara", listingNo: "12345678" });
  expect(parse("New enquiry on Nawy https://www.nawy.com/property/abc-998877")).toMatchObject({ portal: "Nawy", name: null, listingNo: "998877" });
});

test("not an enquiry, or no link: null (a phone or a plain message is never read as one)", () => {
  expect(parse("hello 0101 234 5678")).toBeNull();
  expect(parse("You have received a new enquiry on Bayut. Name: Khaled")).toBeNull();
  expect(parse("https://www.bayut.eg/pm/503956661/x")).toBeNull();
});
