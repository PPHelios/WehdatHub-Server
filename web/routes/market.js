// web/routes/market.js — "Market" (/app/market): an agency's managers and owner see their own lead funnel next to the market median
// and the market reports for the places where the agency has units. Only while the product owner has switched market analytics on for
// the agency (agencies.analytics_enabled); otherwise the ordinary 404, and no menu item shows. Every read goes through
// services/analytics.js, which checks the switch and the role again and takes the agency from the signed-in person.
"use strict";

const Analytics = require("../../services/analytics");
const View = require("../views/analytics");
const { html } = require("../html");
const { L } = require("../../lib/copy");

const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");

function register(web, { pool, page }) {
  web.get("/market", async (req, res) => {
    const lang = langOf(req);
    const data = await Analytics.forAgency(pool, req.session.broker);
    if (data.error) {
      return page(req, res, { title: L(lang, "غير موجود", "Not found"), body: html`<div class="card"><h1>🔍 ${L(lang, "الصفحة غير موجودة", "Page not found")}</h1><p><a class="btn secondary small" href="/app/">${L(lang, "الرئيسية", "Home")}</a></p></div>` }, 404);
    }
    return page(req, res, { title: L(lang, "السوق", "Market"), nav: "market", body: View.agencyPage(data, lang) });
  });
}

module.exports = { register };
