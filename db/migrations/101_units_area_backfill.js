// 101: every unit that points at an approved compound gets that compound's area and sub-zone, and a unit with only a district
// or city text gets the area that text names (when it leads to exactly one area). Units that match nothing keep no area.
"use strict";

const A = require("../../domain/areas");
const Areas = require("../../services/areas");

async function up(client) {
  await client.query(
    `UPDATE listings l SET area_id = p.area_id, subzone_id = p.subzone_id
       FROM map_places p WHERE l.place_id = p.id AND p.area_id IS NOT NULL AND l.area_id IS NULL`
  );
  const areas = await Areas.approvedAreas(client);
  const index = A.buildIndex(areas);
  const { rows } = await client.query(
    `SELECT DISTINCT district AS text FROM listings WHERE area_id IS NULL AND district IS NOT NULL AND district <> ''
     UNION SELECT DISTINCT city FROM listings WHERE area_id IS NULL AND city IS NOT NULL AND city <> ''`
  );
  for (const { text } of rows) {
    const hit = A.resolveArea(index, text);
    if (!hit?.id) continue;
    const at = A.placement(areas, hit.id);
    await client.query(
      "UPDATE listings SET area_id = $2, subzone_id = $3 WHERE area_id IS NULL AND (district = $1 OR (district IS NULL AND city = $1))",
      [text, at.area_id, at.subzone_id]
    );
  }
}

module.exports = { up };
