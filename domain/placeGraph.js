// domain/placeGraph.js — The ids a place answers to (pure): the place itself, every area above it and its zones (with the areas above
// those). A search for any of them finds what is filed under the place (docs/plans/unified-unit-box.md, 3.2). Projects use it now;
// units get the same projection later.
"use strict";

const A = require("./areas");

/**
 * @param {{ place_id?: string|null, area_id?: string|null, subzone_id?: string|null }} pick what the box chose
 * @param {{ areas: object[], zones?: Array<{place_id: string, area_id: string}> }} graph
 * @returns {string[]} unique ids, the pick first
 */
function placeIds(pick = {}, { areas = [], zones = [] } = {}) {
  const out = [];
  const add = (id) => id && !out.includes(id) && out.push(id);
  add(pick.place_id);
  for (const a of A.chain(areas, pick.subzone_id || pick.area_id).reverse()) add(a.id);
  add(pick.area_id);
  for (const z of zones) {
    if (z.place_id !== pick.place_id) continue;
    for (const a of A.chain(areas, z.area_id).reverse()) add(a.id);
  }
  return out;
}

module.exports = { placeIds };
