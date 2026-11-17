// tests/unit/post-reader-corpus.test.js — Posts shaped like the ones in production (codes changed), and adversarial ones built around the
// same failure class: a size, a dimension or a dollar figure next to a price. Each row is the verified reading: the price in EGP (a
// number) or as written for dollars, the area, the land, the sale/rent type. A new misreading is added here as a row before it is fixed.
"use strict";

const C = require("../../domain/chatListing");
const { readAmount } = require("../../domain/read/amount");

const ROWS = [
 {
  "text": "شقة للبيع في التجمع مساحة 150م وحديقة 80م السعر 6 مليون",
  "price": 6000000,
  "area": 150,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع 150 متر روف 60 متر السعر 7.5 مليون",
  "price": 7500000,
  "area": 150,
  "land": null,
  "type": "sale"
 },
 {
  "text": "Apartment for sale 150m garden 50m price 6m",
  "price": 6000000,
  "area": 150,
  "land": null,
  "type": "sale"
 },
 {
  "text": "Apartment for sale area 150m terrace 40m price 6m",
  "price": 6000000,
  "area": 150,
  "land": null,
  "type": "sale"
 },
 {
  "text": "Villa for sale land 500m bua 300m price 25m",
  "price": 25000000,
  "area": 300,
  "land": 500,
  "type": "sale"
 },
 {
  "text": "فيلا للبيع ارض 500م مباني 300م السعر 25 مليون",
  "price": 25000000,
  "area": 300,
  "land": 500,
  "type": "sale"
 },
 {
  "text": "شقة للبيع عمارة 5 دور 3 السعر 4 مليون مساحة 120",
  "price": 4000000,
  "area": 120,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع بارسل 12 عمارة 7 مساحة 140م السعر 5.5 مليون",
  "price": 5500000,
  "area": 140,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع في المرحلة 3 مساحة 130 متر السعر 4.2 مليون",
  "price": 4200000,
  "area": 130,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع طابق 2 واجهة 12م مساحة 160م السعر 5 مليون",
  "price": 5000000,
  "area": 160,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع مساحة 160م شارع 20م السعر 5 مليون",
  "price": 5000000,
  "area": 160,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع 160م ارتفاع 3.5م السعر 5 مليون",
  "price": 5000000,
  "area": 160,
  "land": null,
  "type": "sale"
 },
 {
  "text": "Apartment for sale 160m price 5m installments 8 years",
  "price": 5000000,
  "area": 160,
  "land": null,
  "type": "sale"
 },
 {
  "text": "Apartment for sale 160 sqm 5m cash",
  "price": 5000000,
  "area": 160,
  "land": null,
  "type": "sale"
 },
 {
  "text": "Apartment for rent 160m price 40k monthly",
  "price": 40000,
  "area": 160,
  "land": null,
  "type": "rent"
 },
 {
  "text": "شقة للايجار 160م السعر 40 الف",
  "price": 40000,
  "area": 160,
  "land": null,
  "type": "rent"
 },
 {
  "text": "شقة للايجار 160م 40k",
  "price": 40000,
  "area": 160,
  "land": null,
  "type": "rent"
 },
 {
  "text": "Studio for rent 60m 15k furnished 6th floor",
  "price": 15000,
  "area": 60,
  "land": null,
  "type": "rent"
 },
 {
  "text": "شقة للبيع 100م 3 غرف المقدم 500 الف والباقي على 7 سنين",
  "price": null,
  "area": 100,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع 100م 3 غرف المقدم 10% القسط 25 الف",
  "price": null,
  "area": 100,
  "land": null,
  "type": "sale"
 },
 {
  "text": "Apartment for sale 4 bedrooms 3 bathrooms 200m price 9.5m 2nd floor",
  "price": 9500000,
  "area": 200,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع في 6 اكتوبر 3 غرف 150م 2.5 مليون",
  "price": 2500000,
  "area": 150,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع في الحي 7 مساحة 150م السعر 3 مليون",
  "price": 3000000,
  "area": 150,
  "land": null,
  "type": "sale"
 },
 {
  "text": "Penthouse for sale 250m with 100m roof price 15m",
  "price": 15000000,
  "area": 250,
  "land": null,
  "type": "sale"
 },
 {
  "text": "Duplex for sale 300m + garden 120m price 18m",
  "price": 18000000,
  "area": 300,
  "land": null,
  "type": "sale"
 },
 {
  "text": "فيلا مستقلة للبيع ارض 400م السعر 30 مليون",
  "price": 30000000,
  "area": null,
  "land": 400,
  "type": "sale"
 },
 {
  "text": "Chalet for sale in Sahel 100m price 4.5m 2 bedrooms ready to move",
  "price": 4500000,
  "area": 100,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع 120م السعر 3,500,000",
  "price": 3500000,
  "area": 120,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع 120م السعر 3500000 جنيه",
  "price": 3500000,
  "area": 120,
  "land": null,
  "type": "sale"
 },
 {
  "text": "Apartment for sale 120m price 3.5 million EGP",
  "price": 3500000,
  "area": 120,
  "land": null,
  "type": "sale"
 },
 {
  "text": "Apartment for sale 120m $85,000",
  "price": "$85,000",
  "area": 120,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع 120م السعر 85 الف دولار",
  "price": "85 الف دولار",
  "area": 120,
  "land": null,
  "type": "sale"
 },
 {
  "text": "محل للبيع 40م السعر 2 مليون",
  "price": 2000000,
  "area": 40,
  "land": null,
  "type": "sale"
 },
 {
  "text": "Office for rent 80m 25k per month 3rd floor",
  "price": 25000,
  "area": 80,
  "land": null,
  "type": "rent"
 },
 {
  "text": "Land for sale 1000m price 10m",
  "price": 10000000,
  "area": 1000,
  "land": null,
  "type": "sale"
 },
 {
  "text": "ارض للبيع مساحة 600 متر السعر 12 مليون",
  "price": 12000000,
  "area": 600,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع 150 متر اوفر 500 الف والسعر 4 مليون",
  "price": 4000000,
  "area": 150,
  "land": null,
  "type": "sale"
 },
 {
  "text": "شقة للبيع 150م 3 غرف 2 حمام تشطيب سوبر لوكس 5 مليون و 500 الف",
  "price": 5500000,
  "area": 150,
  "land": null,
  "type": "sale"
 },
 {
  "text": "Code X-46 Compound name : Mivida (parcel 12) Unit type: standalone Area : land area 420m / build up 354m 3 bedrooms (1 Master with dressing) 3 bathrooms nanny's room with bathroom fully furnished except living / private pool price:5000$",
  "price": "5000$",
  "area": 354,
  "land": 420,
  "type": null
 },
 {
  "text": "Available Code X-23 Compound name : Mivida _ avenues 4th floor Unit type : apartment Area : 154m 2 bedrooms 2 bathrooms Fully furnished Price :65k with Kitchen & acs ......... 75k fully furnished",
  "price": 65000,
  "area": 154,
  "land": null,
  "type": null
 },
 {
  "text": "Code X-40 Compound name : Mivida (parcel 1/ 130) Unit type: town house corner Area : land area 347m / build up 277m 4 bedrooms (1 Master) 4 bathrooms nanny's room with bathroom storage room fully furnished super lux with private heated pool Price : 3800$",
  "price": "3800$",
  "area": 277,
  "land": 347,
  "type": null
 },
 {
  "text": "Code X-597 Compound name : Mivida Unit type: apartment Area : 160m 2 bedrooms 2 bathrooms fully furnished Price : 130$ short / 2700$ long",
  "price": "short 130$ / long 2700$",
  "area": 160,
  "land": null,
  "type": "rent"
 },
 {
  "text": "update Code X-590 Compound name : Mivida Unit type: town house Area : 216m/garden 80m 3 bedrooms 4 bathrooms nanny's room fully furnished Price : 135k year",
  "price": 135000,
  "area": 216,
  "land": null,
  "type": "rent"
 },
 {
  "text": "Code X-601 Compound name : Mivida Unit type: Apartment Area : 198m 3 bedrooms 3 bathrooms 2 balcony Price : 75k empty 80k kitchen 85k kitchen & acs",
  "price": 75000,
  "area": 198,
  "land": null,
  "type": null
 }
];

const priceOf = (c) => {
  if (c.price_value === undefined) return null;
  if (/\$|usd|دولار|\//i.test(c.price_value)) return c.price_value;
  const r = readAmount(c.price_value);
  return r ? r.value : c.price_value;
};

test.each(ROWS.map((r) => [r.text.slice(0, 70), r]))("%s", (_name, row) => {
  const out = C.parsePost(row.text);
  const c = out.cells;
  expect(priceOf(c)).toEqual(row.price);
  expect(c.area_value ? Number(c.area_value) : null).toEqual(row.area);
  expect(c.land_area ? Number(c.land_area) : null).toEqual(row.land);
  expect(c.listing_type || null).toEqual(row.type);
  // The safety net never had to fire on these: every reading was already right.
  expect(out.suspect).toEqual([]);
});
