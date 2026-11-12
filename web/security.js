// web/security.js — Headers for every web page (CSP, framing only by Telegram Web, no referrer leaks) and the same-origin check
"use strict";

const Links = require("../lib/links");

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https: data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  // "Send to client" posts, then redirects to WhatsApp (wa.me forwards to api.whatsapp.com).
  "form-action 'self' https://wa.me https://api.whatsapp.com",
  // Telegram Web shows the Mini App (the website opened from the bot) in an iframe; nobody else may frame us.
  "frame-ancestors 'self' https://web.telegram.org",
  "manifest-src 'self'",
  "worker-src 'self'"
].join("; ");

/**
 * The policy, plus the origins the browser reads or writes directly in connect-src: the map file's address when MAP_TILES_URL is
 * set (read in ranges) and the storage project's address when SUPABASE_URL is set (photos go straight to storage).
 */
function cspWithMap() {
  const origins = [];
  const tiles = require("../config").getConfig().map.tilesUrl;
  if (tiles) origins.push(new URL(tiles).origin);
  try {
    if (process.env.SUPABASE_URL) origins.push(new URL(process.env.SUPABASE_URL).origin);
  } catch {
    /* a malformed address adds nothing */
  }
  if (!origins.length) return CSP;
  return CSP.replace("connect-src 'self'", `connect-src 'self' ${[...new Set(origins)].join(" ")}`);
}

/** Security headers for HTML pages and static files of the web app and the public pages. */
function securityHeaders(_req, res, next) {
  res.set({
    "Content-Security-Policy": cspWithMap(),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=(self), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin"
  });
  next();
}

/**
 * Rejects state-changing requests that a browser marks as coming from another site
 * (Sec-Fetch-Site, else Origin compared with the site origin). Defence in depth next to CSRF tokens.
 */
function sameOrigin() {
  return (req, res, next) => {
    const allowed = Links.siteOrigin();
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const site = req.get("sec-fetch-site");
    if (site && !["same-origin", "none"].includes(site)) return res.status(403).send("Cross-site request refused");
    const origin = req.get("origin");
    if (origin && origin !== "null" && origin !== allowed) return res.status(403).send("Cross-site request refused");
    return next();
  };
}

module.exports = { CSP, securityHeaders, sameOrigin };
