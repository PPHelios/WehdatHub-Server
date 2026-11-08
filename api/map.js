// api/map.js — The map for the app: the same pins, filters and units as the website's Map page (services/mapPlaces),
// behind the same visibility rule. The phone draws the map itself from the public .pmtiles file whose address is sent here.
"use strict";

const Maps = require("../services/mapPlaces");
const { getConfig } = require("../config");

function register(api, { pool }) {
  api.get("/map", async (req, res) => {
    const { broker } = req.session;
    const [p, facets] = await Promise.all([Maps.pins(pool, broker, req.query), Maps.facets(pool, broker, req.query)]);
    return res.json({ tilesUrl: getConfig().map.tilesUrl || null, pins: p.pins, idle: p.idle, total: p.total, unmapped: p.unmapped, facets });
  });

  api.get("/map/places/:id/units", async (req, res) => {
    const { broker } = req.session;
    const place = await Maps.place(pool, req.params.id);
    if (!place) return res.status(404).json({ error: "not_found" });
    const units = await Maps.unitsAt(pool, broker, place.id, req.query);
    return res.json({
      place: { id: place.id, name_en: place.name_en, name_ar: place.name_ar },
      items: units.map((u) => ({
        code: u.code,
        title: u.title,
        propertyType: u.property_type,
        listingType: u.listing_type,
        bedrooms: u.bedrooms,
        bathrooms: u.bathrooms,
        area: u.area_value,
        price: u.price_value,
        priceText: u.price_display
      }))
    });
  });
}

module.exports = { register };
