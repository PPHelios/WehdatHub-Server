// 081: "twinhouse" is no longer a unit type: its units become twin villas. The search vocabulary is reseeded, because the type
// words added since migration 004 (triplex, sky loft, basement, mazonette, i villa, twin villa, maisonette) were never written
// to it. Every search document is rebuilt so the new words and the moved units are found.
"use strict";

const { seedVocabulary } = require("../../domain/vocabulary");

async function up(client) {
  await client.query("UPDATE listings SET property_type = 'twin_villa' WHERE property_type = 'twinhouse'");
  await client.query("UPDATE unit_reference SET property_type = 'twin_villa' WHERE property_type = 'twinhouse'");
  await seedVocabulary(client);
  await client.query("UPDATE listings SET compound = compound");
}

module.exports = { up };
