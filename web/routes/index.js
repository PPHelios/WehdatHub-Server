// web/routes/index.js — Page modules of the web app, in mount order. Each exports register(router, ctx).
// PUBLIC pages are open (sign-in); PRIVATE pages need a signed-in broker and CSRF tokens on writes.
"use strict";

const PUBLIC = [require("./auth"), require("./guide"), require("./signup"), require("./viewing")];
const PRIVATE = [
  require("./home"),
  require("./search"),
  require("./assistant"),
  require("./imports"),
  require("./matchPhotos"),
  require("./unitForm"),
  require("./units"),
  require("./compare"),
  require("./leadImports"),
  require("./leads"),
  require("./deals"),
  require("./commissions"),
  require("./notifications"),
  require("./activityLog"),
  require("./failures"),
  require("./owners"),
  require("./openedLinks"),
  require("./settings"),
  require("./passkeys"),
  require("./usage"),
  require("./dashboard"),
  require("./searchReview"),
  require("./map"),
  require("./placeSuggest"),
  require("./accessRequests"),
  require("./team"),
  require("./plan"),
  require("./report"),
  require("./sources"),
  require("./portalEnquiries"),
  require("./winLoss"),
  require("./insights"),
  require("./catalogueUpdates"),
  require("./brochure"),
  require("./gallery"),
  require("./globalProjects"),
  require("./catalogue"),
  require("./priceSheets"),
  require("./testRole"),
  require("./adminBoard")
];

module.exports = { PUBLIC, PRIVATE };
