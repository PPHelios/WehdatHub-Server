// 134: "mazonette" and "maisonette" are one type (maisonette, مازونيت). Existing units move to it and the search vocabulary
// and every search document are rebuilt, so every spelling (mazonet, mizonette, مزونيت, ميزونيت …) finds them.
"use strict";

const { seedVocabulary } = require("../../domain/vocabulary");

async function up(client) {
  await client.query("UPDATE listings SET property_type = 'maisonette' WHERE property_type = 'mazonette'");
  await client.query("UPDATE unit_reference SET property_type = 'maisonette' WHERE property_type = 'mazonette'");
  await client.query("DELETE FROM search_vocabulary WHERE kind = 'type' AND key = 'mazonette'");
  await seedVocabulary(client);
  await client.query("UPDATE listings SET compound = compound");
}

module.exports = { up };
