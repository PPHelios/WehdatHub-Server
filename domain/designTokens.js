// domain/designTokens.js — The one set of colours and shapes for the website and the app (plan part 2, section 8).
// Light: azure is the main colour. Dark: copper is the main colour, and azure becomes the second colour.
// The website gets these as CSS variables (web/assets.js, brand.css); the app carries the same values in
// packages/shared/src/tokens.ts (a test there compares the two when the repos sit side by side).
// Every "on" colour is the text or icon colour that is readable on its fill: tests/unit/design-tokens.test.js checks the
// contrast of every pair in both modes, so a colour that is hard to read cannot be added by mistake.
"use strict";

const COLORS = Object.freeze({
  light: Object.freeze({
    // Main colour (Bright Sun Gold): primary CTAs, active accents, outer 4 logo towers. Dark navy text on gold (10:1 AAA).
    brand: "#e8b92a", "brand-hi": "#f2c946", "brand-strong": "#cfa11b", "brand-weak": "#f4dc8a", "on-brand": "#0a111f", "brand-ink": "#0c1629", "brand-soft": "#fef7de",
    // Companion colour (Obsidian Navy): center logo tower, secondary strong actions, links, status highlights.
    accent: "#0c1629", "on-accent": "#ffffff", "accent-ink": "#0c1629", "accent-soft": "#e9edf4",
    ink: "#0a111f", bg: "#f6f7f9", card: "#ffffff", soft: "#edeff3", field: "#ffffff", muted: "#4c5566", line: "#e0e4ec", "line-strong": "#c6cddb",
    // Status tones (no green, no pink): crisp Obsidian Navy for positive/ready states, warm gold-bronze for warn, muted crimson for errors.
    ok: "#0c1629", "on-ok": "#ffffff", "ok-ink": "#0c1629", "ok-soft": "#e9edf4", "ok-line": "#cad2e0",
    warn: "#855d00", "on-warn": "#ffffff", "warn-soft": "#fef7de",
    bad: "#a62319", "on-bad": "#ffffff", "bad-ink": "#801810", "bad-soft": "#fbece9",
    // A dark surface that stays dark in both modes (toasts) and a neutral fill (idle, sold out).
    inverse: "#0a111f", "on-inverse": "#f8f9fc", neutral: "#566073", "on-neutral": "#ffffff"
  }),
  dark: Object.freeze({
    // Main colour (Glowing Sun Gold) on deep Obsidian Navy surfaces.
    brand: "#f7cc48", "brand-hi": "#fbd96d", "brand-strong": "#dfb026", "brand-weak": "#6b5619", "on-brand": "#080c14", "brand-ink": "#fde699", "brand-soft": "#2e2409",
    // Companion colour (Steel Sky Navy).
    accent: "#8ab3f0", "on-accent": "#070d18", "accent-ink": "#c7dcf9", "accent-soft": "#142036",
    ink: "#f8f9fc", bg: "#070b12", card: "#0f1624", soft: "#162033", field: "#162033", muted: "#a3afc2", line: "#222e45", "line-strong": "#334363",
    ok: "#8ab3f0", "on-ok": "#070d18", "ok-ink": "#c7dcf9", "ok-soft": "#142036", "ok-line": "#273b60",
    warn: "#f7cc48", "on-warn": "#080c14", "warn-soft": "#2e2409",
    bad: "#f07060", "on-bad": "#170a08", "bad-ink": "#f7b7ae", "bad-soft": "#381b18",
    inverse: "#f8f9fc", "on-inverse": "#070b12", neutral: "#566073", "on-neutral": "#ffffff"
  })
});

/** Corners and heights shared by every button and field. Buttons come in three sizes with the same corners. */
const SHAPE = Object.freeze({ radius: 20, "radius-btn": 14, "radius-field": 12, "btn-sm": 40, "btn-md": 48, "btn-lg": 56 });

/**
 * Pairs that must be readable: [text, surface, least contrast]. 4.5 is the level for normal text, 3 for large text,
 * icons and the edge of a control (WCAG 2.1 AA).
 */
const PAIRS = Object.freeze([
  ["ink", "bg", 4.5], ["ink", "card", 4.5], ["ink", "soft", 4.5], ["ink", "field", 4.5],
  ["muted", "bg", 4.5], ["muted", "card", 4.5], ["muted", "soft", 4.5],
  ["brand-ink", "bg", 4.5], ["brand-ink", "card", 4.5], ["brand-ink", "soft", 4.5], ["brand-ink", "brand-soft", 4.5],
  ["on-brand", "brand", 4.5], ["on-brand", "brand-hi", 4.5], ["on-brand", "brand-strong", 4.5],
  ["on-accent", "accent", 4.5], ["accent-ink", "accent-soft", 4.5], ["accent", "card", 3],
  ["on-ok", "ok", 4.5], ["ok-ink", "ok-soft", 4.5], ["ok", "card", 3],
  ["on-warn", "warn", 4.5], ["ink", "warn-soft", 4.5], ["warn", "card", 3],
  ["on-bad", "bad", 4.5], ["bad-ink", "bad-soft", 4.5], ["bad", "card", 4.5], ["bad", "bg", 4.5],
  ["on-inverse", "inverse", 4.5], ["on-neutral", "neutral", 4.5]
]);

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio of two #rrggbb colours (1 to 21). */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every pair that is below its level, per mode: [] when all are readable. */
function unreadable(colors = COLORS) {
  const out = [];
  for (const mode of Object.keys(colors)) {
    for (const [text, surface, min] of PAIRS) {
      const ratio = contrast(colors[mode][text], colors[mode][surface]);
      if (ratio < min) out.push({ mode, text, surface, ratio: Math.round(ratio * 100) / 100, min });
    }
  }
  return out;
}

const vars = (set) => Object.entries(set).map(([k, v]) => `--${k}: ${v};`).join(" ");

/** The CSS variables for both modes: light by default, dark when the phone asks for it or the person chose it. */
function cssVars(colors = COLORS, shape = SHAPE) {
  const sizes = Object.entries(shape).map(([k, v]) => `--${k}: ${v}px;`).join(" ");
  return [
    "/* Generated from domain/designTokens.js */",
    `:root { ${vars(colors.light)} ${sizes} color-scheme: light; }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${vars(colors.dark)} --shadow: none; color-scheme: dark; } }`,
    `:root[data-theme="dark"] { ${vars(colors.dark)} --shadow: none; color-scheme: dark; }`,
    ""
  ].join("\n");
}

module.exports = { COLORS, SHAPE, PAIRS, contrast, unreadable, cssVars };
