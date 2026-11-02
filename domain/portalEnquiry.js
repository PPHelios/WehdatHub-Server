// domain/portalEnquiry.js — Reads a forwarded portal enquiry (Bayut, Dubizzle, Nawy: the same message format) (pure).
// Takes only what the message states: the portal, the client's name, the property link and the listing number in
// that link. It never guesses a unit, a phone or a code, and it returns null for anything else.
"use strict";

const PORTALS = { bayut: "Bayut", dubizzle: "Dubizzle", nawy: "Nawy" };
const ENQUIRY = /new\s+enquiry\s+on\s+(bayut|dubizzle|nawy)\b/i;
const LINK = /https?:\/\/[^\s<>"']+/i;
const NAME = /^[ \t]*Name:[ \t]*(.+)$/im;

/**
 * @returns {{portal: string, name: string|null, link: string, listingNo: string|null}|null}
 */
function parse(text) {
  const s = String(text || "");
  const m = s.match(ENQUIRY);
  if (!m) return null;
  const link = (s.match(LINK) || [])[0];
  if (!link) return null;
  let path = link;
  try {
    path = new URL(link).pathname;
  } catch {
    // keep the raw link; the number search below still works on it
  }
  // The listing number is the last run of six or more digits in the path (Bayut: /pm/<number>/<uuid>).
  const runs = path.match(/\d{6,}/g);
  const nameLine = s.match(NAME);
  const name = nameLine ? nameLine[1].trim().slice(0, 120) : null;
  return {
    portal: PORTALS[m[1].toLowerCase()],
    name: name || null,
    link: link.slice(0, 1000),
    listingNo: runs ? runs[runs.length - 1] : null
  };
}

module.exports = { parse, PORTALS };
