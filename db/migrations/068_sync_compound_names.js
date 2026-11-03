// 068: copies the compound names from the code's place list (domain/places) into compound_synonyms, so units are
// tagged with the same compounds the search reads. Names already in the table are left as they are.
"use strict";

const Places = require("../../domain/places");

async function up(client) {
  for (const r of Places.synonymRows().filter((x) => x.kind === "compound")) {
    await client.query(
      `INSERT INTO compound_synonyms (kind, key, synonym, synonym_norm, area_key, developer_key)
       SELECT 'compound', $1::text, $2::text, public.normalize_search($2::text), $3::text, $4::text
       WHERE NOT EXISTS (SELECT 1 FROM compound_synonyms c
                         WHERE c.kind = 'compound' AND c.key = $1::text AND c.synonym_norm = public.normalize_search($2::text))`,
      [r.key, r.synonym, r.area_key, r.developer_key]
    );
  }
  // Re-save units that have a compound name but no compound tag, so the new names tag them.
  await client.query("UPDATE listings SET compound = compound WHERE compound_key IS NULL AND compound IS NOT NULL");
}

module.exports = { up };
