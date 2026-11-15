// 118: projects made before the details became rows get their place (from the district or city they already name, when that leads to
// one area) and their search_text, so the catalogue search finds them too. A project whose district matches no area keeps no place.
// Roll back: UPDATE projects SET search_text = '', place_ids = '{}', area_id = NULL, subzone_id = NULL;
"use strict";

async function up(client) {
  const Suggest = require("../../services/placeSuggest");
  const ProjectRows = require("../../services/projectRows");
  Suggest.resetCache();
  await ProjectRows.rebuild(client);
  Suggest.resetCache();
}

module.exports = { up };
