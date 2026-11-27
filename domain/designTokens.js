// domain/designTokens.js — The one set of colours and shapes for the website and the app (plan part 2, section 8).
// Deep green leads in both modes, with blue as the companion.
// The website gets these as CSS variables (web/assets.js, brand.css); the app carries the same values in
// packages/shared/src/tokens.ts (a test there compares the two when the repos sit side by side).
// Every "on" colour is the text or icon colour that is readable on its fill: tests/unit/design-tokens.test.js checks the
// contrast of every pair in both modes, so a colour that is hard to read cannot be added by mistake.
"use strict";

const COLORS = Object.freeze({
  light: Object.freeze({
    brand: "#0f3f34", "brand-hi": "#1a5647", "brand-strong": "#082921", "brand-weak": "#285d50", "on-brand": "#ffffff", "brand-ink": "#082d25", "brand-soft": "#ebf5f3", "required-field": "#0f3f340a", "brand-line": "#b7ded5",
    // Companion colour (Royal Dark Blue): secondary strong actions, links, status highlights.
    accent: "#122b4f", "on-accent": "#ffffff", "accent-ink": "#122b4f", "accent-soft": "#e6eef9",
    ink: "#0d182b", bg: "#f4f6fa", card: "#ffffff", soft: "#ecf0f6", field: "#ffffff", muted: "#4c596f", line: "#dce2ee", "line-strong": "#c2cce0",
    ok: "#0f766e", "on-ok": "#ffffff", "ok-ink": "#082d25", "ok-soft": "#ebf5f3", "ok-line": "#b7ded5",
    warn: "#b45309", "on-warn": "#ffffff", "warn-soft": "#fef3c7", "warn-ink": "#92400e",
    bad: "#a62319", "on-bad": "#ffffff", "bad-ink": "#8a1c14", "bad-soft": "#fbece9",
    // A dark surface that stays dark in both modes (toasts) and a neutral fill (idle, sold out).
    inverse: "#0d182b", "on-inverse": "#f8fafc", neutral: "#566073", "on-neutral": "#ffffff"
  }),
  dark: Object.freeze({
    brand: "#0f3f34", "brand-hi": "#1a5647", "brand-strong": "#082921", "brand-weak": "#285d50", "on-brand": "#ffffff", "brand-ink": "#6ee7b7", "brand-soft": "#13352c", "required-field": "#34d39914", "brand-line": "#1d584c",
    // Companion colour (Lifted Cobalt Blue).
    accent: "#4b83d4", "on-accent": "#08101e", "accent-ink": "#c6dcfa", "accent-soft": "#162a4a",
    ink: "#f8fafc", bg: "#09111f", card: "#111c30", soft: "#182742", field: "#15233b", muted: "#9db0ca", line: "#243656", "line-strong": "#344b73",
    ok: "#10b981", "on-ok": "#06260f", "ok-ink": "#6ee7b7", "ok-soft": "#13352c", "ok-line": "#1d584c",
    warn: "#f59e0b", "on-warn": "#08101e", "warn-soft": "#2a1f0b", "warn-ink": "#fcd34d",
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
  ["on-brand", "brand", 4.5], ["on-brand", "brand-hi", 4.5], ["on-brand", "brand-strong", 4.5], ["on-brand", "brand-weak", 4.5],
  ["on-accent", "accent", 4.5], ["accent-ink", "accent-soft", 4.5], ["accent", "card", 3],
  ["on-ok", "ok", 4.5], ["ok-ink", "ok-soft", 4.5], ["ok", "card", 4.5], ["ok", "bg", 4.5],
  ["on-warn", "warn", 4.5], ["ink", "warn-soft", 4.5], ["warn-ink", "warn-soft", 4.5], ["warn", "card", 4.5], ["warn", "bg", 4.5],
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
  const brandGradient = "linear-gradient(145deg, var(--brand-hi) 0%, var(--brand) 60%, var(--brand-strong) 100%)";
  const lightSoftGradient = "linear-gradient(145deg, #34d39908 0%, #1a564710 100%)";
  const darkSoftGradient = "linear-gradient(145deg, #34d3991c 0%, #34d3990d 100%)";
  return [
    "/* Generated from domain/designTokens.js */",
    `:root { ${vars(colors.light)} ${sizes} --brand-grad: ${brandGradient}; --brand-soft-grad: ${lightSoftGradient}; color-scheme: light; }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${vars(colors.dark)} --brand-soft-grad: ${darkSoftGradient}; color-scheme: dark; } }`,
    `:root[data-theme="dark"] { ${vars(colors.dark)} --brand-soft-grad: ${darkSoftGradient}; color-scheme: dark; }`,
    ""
  ].join("\n");
}

module.exports = { COLORS, SHAPE, PAIRS, contrast, unreadable, cssVars };
