// services/quickFill.js — The free fill for "fill the form from the message" when the AI is blocked (credits used up, the
// owner's switch, a daily cap) or not answering: the rules-only reader (domain/chatListing, the same one the WhatsApp
// import uses) reads the typed text, at no credit cost. Voice notes need the AI and get nothing here.
"use strict";

const ChatListing = require("../domain/chatListing");

/**
 * The unit fields the quick reader finds in `text` (the AI extraction's shape, ready for listing.composeFields), or null
 * when it finds nothing useful.
 */
async function draftFromText(pool, text, lang = "ar") {
  const t = String(text || "").trim();
  if (!t) return null;
  try {
    const places = await require("./chatPlan").loadPlaces(pool).catch(() => null);
    const cells = ChatListing.parsePost(t, places, {}).cells;
    const draft = require("./imports").fieldsOfCells(cells, lang);
    // The import marks its rows "WhatsApp" in the notes; a typed description is not a WhatsApp import.
    if (draft.details && draft.details.notes === "WhatsApp") delete draft.details.notes;
    const found = ["property_type", "price_value", "area_value", "bedrooms", "compound", "location", "finishing"].filter((k) => draft[k] !== null && draft[k] !== undefined && draft[k] !== "");
    return found.length ? { draft, code: cells.code || "" } : null;
  } catch {
    return null;
  }
}

module.exports = { draftFromText };
