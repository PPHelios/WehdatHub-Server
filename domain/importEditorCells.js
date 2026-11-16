// domain/importEditorCells.js — The cells the import Edit window owns, and how its posted form becomes cells (pure).
// The form is the same controls as the add/edit unit form: its `c_<cell>` fields plus the unit box's `compound`, `feature`
// and `features_other`. A managed cell posted empty clears the cell, so a person can remove a wrong reading.
"use strict";

const Features = require("./features");

const MANAGED = [
  "listing_type", "property_type", "compound", "features", "price_value", "area_value", "land_area", "bedrooms", "bathrooms", "floor",
  "finishing", "furnishing", "delivery", "down_payment_value", "remaining_amount", "installment_value", "owner_name", "owner_phone"
];

/** The area (or sub-zone) name a posted area_id / subzone_id stands for, so the planner can place the unit like a sheet's district. */
function districtOf(body, areas) {
  const id = String([].concat(body.subzone_id || body.area_id || "")[0] || "");
  const a = id && (areas || []).find((x) => String(x.id) === id);
  return a ? a.name_en || a.name_ar || "" : "";
}

/** A new compound asked for in the window: its Arabic name and map link wait on the pending name (like the add-unit form). */
function newPlaceOf(body = {}) {
  if (String([].concat(body.compound_new || "")[0]) !== "1" || !String(body.compound || "").trim()) return null;
  return { nameAr: String([].concat(body.compound_ar || "")[0] || "").slice(0, 120), pin: String([].concat(body.compound_pin || "")[0] || "").slice(0, 500) };
}

/** The posted editor fields → { every managed cell: string } ("" = empty). `areas` turns a picked area into the district cell. */
function cellsFromForm(body = {}, { areas = null } = {}) {
  const one = (v) => String([].concat(v === undefined ? [] : v)[0] ?? "").trim().slice(0, 600);
  const many = (v) => [].concat(v === undefined ? [] : v).map((x) => String(x).trim()).filter(Boolean);
  const out = {};
  for (const k of MANAGED) if (k !== "compound" && k !== "features") out[k] = one(body[`c_${k}`]);
  out.compound = one(body.compound);
  const keys = many(body.feature).filter((k) => Features.featureLabel(k));
  const other = String(body.features_other || "").split(/[,،\n]/).map((s) => s.trim()).filter(Boolean);
  out.features = [...keys, ...other].join(", ");
  const district = districtOf(body, areas);
  if (district) out.district = district;
  return out;
}

/** The parser's cells with the person's editor fields on top (a managed cell left empty is removed). */
function mergeEdits(cells = {}, fields = null, opts = {}) {
  if (!fields || typeof fields !== "object") return { ...cells };
  const out = { ...cells };
  for (const [k, v] of Object.entries(cellsFromForm(fields, opts))) {
    if (v) out[k] = v;
    else delete out[k];
  }
  return out;
}

/** Cells → what the unit box shows: the feature keys and the ones the list does not know. */
function boxValues(cells = {}) {
  const words = String(cells.features || "").split(/[•,،/|\n;]+/).map((x) => x.trim()).filter(Boolean);
  const { keys, other } = Features.classifyFeatures(words);
  return { compound: cells.compound || "", compound_new: "", compound_ar: "", compound_pin: "", district: "", city: "", area_id: "", subzone_id: "", feature: keys, features_other: other.join("، ") };
}

module.exports = { MANAGED, newPlaceOf, cellsFromForm, mergeEdits, boxValues };
