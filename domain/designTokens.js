// domain/designTokens.js — The one set of colours and shapes for the website and the app (plan part 2, section 8).
// Light: azure is the main colour. Dark: copper is the main colour, and azure becomes the second colour.
// The website gets these as CSS variables (web/assets.js, brand.css); the app carries the same values in
// packages/shared/src/tokens.ts (a test there compares the two when the repos sit side by side).
// Every "on" colour is the text or icon colour that is readable on its fill: tests/unit/design-tokens.test.js checks the
// contrast of every pair in both modes, so a colour that is hard to read cannot be added by mistake.
"use strict";

const COLORS = Object.freeze({
  light: Object.freeze({
    // Main colour (azure): buttons, links, the selected item.
    brand: "#1d70b8", "brand-hi": "#2a82cc", "brand-strong": "#14558c", "brand-weak": "#6fa8d6", "on-brand": "#ffffff", "brand-ink": "#155a96", "brand-soft": "#e6f0fa",
    // Second colour (copper): "very interested", featured, launching.
    accent: "#b8501f", "on-accent": "#ffffff", "accent-ink": "#8a3416", "accent-soft": "#fbeae2",
    ink: "#0e1521", bg: "#f4f6f9", card: "#ffffff", soft: "#eef2f6", field: "#ffffff", muted: "#4a5568", line: "#e2e8f0", "line-strong": "#cbd5e1",
    ok: "#1e7b4e", "on-ok": "#ffffff", "ok-ink": "#145a38", "ok-soft": "#e3f3ea", "ok-line": "#bfe3cb",
    warn: "#9a5b00", "on-warn": "#ffffff", "warn-soft": "#fdf3e1",
    bad: "#b42318", "on-bad": "#ffffff", "bad-ink": "#8f1b12", "bad-soft": "#fdecea",
    // A dark surface that stays dark in both modes (toasts) and a neutral fill (idle, sold out).
    inverse: "#0e1521", "on-inverse": "#f8fafc", neutral: "#5b6878", "on-neutral": "#ffffff"
  }),
  dark: Object.freeze({
    // Main colour (copper). Text on a copper fill is dark: white on copper is too faint to read.
    brand: "#e8845a", "brand-hi": "#ee9872", "brand-strong": "#dc6a3d", "brand-weak": "#7a4a36", "on-brand": "#0e1521", "brand-ink": "#f3b190", "brand-soft": "#3b2219",
    // Second colour (azure).
    accent: "#4e9fea", "on-accent": "#0e1521", "accent-ink": "#9fcaf3", "accent-soft": "#1b3350",
    ink: "#f8fafc", bg: "#0e1521", card: "#172133", soft: "#1f2b40", field: "#1f2b40", muted: "#a9b4c4", line: "#2a3850", "line-strong": "#3a4a66",
    ok: "#3fae78", "on-ok": "#0e1521", "ok-ink": "#9de0bd", "ok-soft": "#173328", "ok-line": "#2c5a44",
    warn: "#e0a33a", "on-warn": "#0e1521", "warn-soft": "#33270f",
    bad: "#f0715f", "on-bad": "#0e1521", "bad-ink": "#f7b4aa", "bad-soft": "#3a1c19",
    inverse: "#f8fafc", "on-inverse": "#0e1521", neutral: "#5b6878", "on-neutral": "#ffffff"
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
  ["brand", "bg", 4.5], ["brand", "card", 4.5], ["brand", "soft", 4.5],
  ["on-brand", "brand", 4.5], ["on-brand", "brand-hi", 3], ["on-brand", "brand-strong", 4.5],
  ["brand-ink", "brand-soft", 4.5], ["brand-ink", "card", 4.5],
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
