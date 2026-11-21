// domain/designTokens.js — The one set of colours and shapes for the website and the app (plan part 2, section 8).
// Light: Brushed Satin Gold is the main colour and Royal Dark Blue the companion. Dark: a lighter gold is the main colour and Cobalt Blue the companion.
// The website gets these as CSS variables (web/assets.js, brand.css); the app carries the same values in
// packages/shared/src/tokens.ts (a test there compares the two when the repos sit side by side).
// Every "on" colour is the text or icon colour that is readable on its fill: tests/unit/design-tokens.test.js checks the
// contrast of every pair in both modes, so a colour that is hard to read cannot be added by mistake.
"use strict";

const COLORS = Object.freeze({
  light: Object.freeze({
    // Main colour (Brushed Satin Gold): primary CTAs, active accents, outer 4 logo towers. Deep royal ink on gold (6.9:1 AA+/AAA).
    brand: "#c29741", "brand-hi": "#d5af55", "brand-strong": "#a67e32", "brand-weak": "#e8d49c", "on-brand": "#0a1324", "brand-ink": "#122b4f", "brand-soft": "#f8f2e2",
    // Companion colour (Royal Dark Blue): secondary strong actions, links, status highlights.
    accent: "#122b4f", "on-accent": "#ffffff", "accent-ink": "#122b4f", "accent-soft": "#e6eef9",
    ink: "#0d182b", bg: "#f4f6fa", card: "#ffffff", soft: "#ecf0f6", field: "#ffffff", muted: "#4c596f", line: "#dce2ee", "line-strong": "#c2cce0",
    // Status tones (strictly 2-colour system — no green): Royal Dark Blue for positive/ready/Call, antique bronze for warn, muted crimson for errors.
    ok: "#122b4f", "on-ok": "#ffffff", "ok-ink": "#122b4f", "ok-soft": "#e6eef9", "ok-line": "#c3d3ec",
    warn: "#7a5614", "on-warn": "#ffffff", "warn-soft": "#faf3df",
    bad: "#a62319", "on-bad": "#ffffff", "bad-ink": "#8a1c14", "bad-soft": "#fbece9",
    // A dark surface that stays dark in both modes (toasts) and a neutral fill (idle, sold out).
    inverse: "#0d182b", "on-inverse": "#f8fafc", neutral: "#566073", "on-neutral": "#ffffff"
  }),
  dark: Object.freeze({
    // Main colour (Brushed Satin Gold) on deep Royal Navy surfaces.
    brand: "#d5af55", "brand-hi": "#ddb95e", "brand-strong": "#c29741", "brand-weak": "#6b5424", "on-brand": "#08101e", "brand-ink": "#e8cc7e", "brand-soft": "#261f10",
    // Companion colour (Lifted Cobalt Blue — matches invariant logo center spire).
    accent: "#4b83d4", "on-accent": "#08101e", "accent-ink": "#c6dcfa", "accent-soft": "#162a4a",
    ink: "#f8fafc", bg: "#09111f", card: "#111c30", soft: "#182742", field: "#15233b", muted: "#9db0ca", line: "#243656", "line-strong": "#344b73",
    ok: "#d5af55", "on-ok": "#08101e", "ok-ink": "#c6dcfa", "ok-soft": "#162a4a", "ok-line": "#27416b",
    warn: "#d5af55", "on-warn": "#08101e", "warn-soft": "#261f10",
    bad: "#e87166", "on-bad": "#170a08", "bad-ink": "#f7b7ae", "bad-soft": "#361918",
    inverse: "#f8fafc", "on-inverse": "#09111f", neutral: "#566073", "on-neutral": "#ffffff"
  })
});

/** Corners and heights shared by every button and field. Buttons come in three sizes with the same corners. */
const SHAPE = Object.freeze({ radius: 20, "radius-btn": 14, "radius-field": 12, "btn-sm": 44, "btn-md": 48, "btn-lg": 56 });

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
