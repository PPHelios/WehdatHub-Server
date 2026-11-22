// domain/brand.js — WehdatHub's own brand in one place (phase 2 step 3): colours, logo and names. The website, the Mini
// App, the landing page (CSS tokens through web/assets.js brand.css), the PWA manifest and the default colours of a
// new agency's flyers all read it, so a new logo or palette drops in here only.
"use strict";

const Tokens = require("./designTokens");

const BRAND = Object.freeze({
  name: "WehdatHub",
  // Brand v2 (2026-10-27): gold (#c29741) for actions, links, "very interested" and featured, charcoal text.
  colors: Object.freeze({ brand: Tokens.COLORS.light.brand, accent: Tokens.COLORS.light.accent, ink: Tokens.COLORS.light.ink, bg: Tokens.COLORS.light.bg }),
  // Under web/static/ (served at /app/static/).
  logo: "icons/icon.svg"
});

/** The CSS custom properties every page starts from, light and dark (domain/designTokens.js; app.css never names a colour). */
function cssTokens() {
  return Tokens.cssVars();
}

module.exports = { BRAND, cssTokens };
