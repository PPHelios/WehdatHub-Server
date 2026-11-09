// 099: loads the starter list of areas and sub-zones (data/areas/areas.json) and links each compound to its area from the
// district text it already has. Compounds whose district is combined or unknown keep no area and are listed for the owner.
"use strict";

const Areas = require("../../services/areas");
const tree = require("../../data/areas/areas.json");

async function up(client) {
  await Areas.seedTree(client, tree);
  await Areas.linkPlacesFromDistrict(client);
}

module.exports = { up };
