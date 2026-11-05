// 074: finishing is always one of the fixed statuses (core_and_shell, semi_finished, fully_finished, super_lux,
// ultra_super_lux). Old free-text entries are matched to a status; what does not match becomes blank (null), and a blank
// finishing still shows in search, after the units that match exactly. Free text that only sits in details (units saved
// before the column was used) is read the same way.
"use strict";

const { mapFinishing, FINISHING_STATUSES } = require("../../domain/furnishingStatus");

async function up(client) {
  const { rows } = await client.query("SELECT DISTINCT finishing AS v FROM listings WHERE finishing IS NOT NULL AND finishing <> ALL($1::text[])", [FINISHING_STATUSES]);
  for (const { v } of rows) await client.query("UPDATE listings SET finishing = $2 WHERE finishing = $1", [v, mapFinishing(v)]);
  const old = await client.query("SELECT DISTINCT details->>'finishing' AS v FROM listings WHERE finishing IS NULL AND coalesce(details->>'finishing', '') <> ''");
  for (const { v } of old.rows) {
    const mapped = mapFinishing(v);
    if (mapped) await client.query("UPDATE listings SET finishing = $2 WHERE finishing IS NULL AND details->>'finishing' = $1", [v, mapped]);
  }
}

module.exports = { up };
