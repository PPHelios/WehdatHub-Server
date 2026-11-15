// 116: "roof" (روف) is a unit type: a unit that is the roof floor itself. The search vocabulary is reseeded so a search finds it by
// its words. No unit has the type yet, so no search document needs rebuilding.
// Roll back: delete the roof words from domain/vocabulary.js and run seedVocabulary again.
"use strict";

const { seedVocabulary } = require("../../domain/vocabulary");

async function up(client) {
  await seedVocabulary(client);
}

module.exports = { up };
