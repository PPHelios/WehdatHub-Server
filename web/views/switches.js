// web/views/switches.js — The two owner-control patterns, used everywhere so every control looks and works the same
// (spec-web.md section 3):
//   choice (two or more options): radio buttons, each option written out in full, no pill style;
//   on/off: a switch with the state word beside it ("On" / "Off") and one sentence saying what turning it on does.
// Field names stay as they were, so saved settings and old links keep working. Both work without script.
"use strict";

const { html } = require("../html");

const { L } = require("../../lib/copy");

/**
 * An on/off switch. Checked posts `value` (default "on"); unchecked posts nothing.
 * @param {Object} o - { name, on, label, sentence, lang, disabled, value, send0 }
 *   send0: also post "0" when off (a hidden "0" comes first, the checkbox's value after it: read the last one).
 */
function switchField({ name, on, label, sentence = "", lang, disabled = false, value = "on", send0 = false, id = null }) {
  return html`<div class="sw-row">${send0 && !disabled ? html`<input type="hidden" name="${name}" value="0">` : ""}<label class="sw"><input type="checkbox" role="switch" name="${name}" value="${value}"${id ? html` id="${id}"` : ""}${on ? html` checked` : ""}${disabled ? html` disabled` : ""}><span class="sw-track" aria-hidden="true"><span class="sw-thumb"></span></span><span class="sw-label">${label}</span><span class="sw-state" aria-hidden="true"><span class="sw-on">${L(lang, "شغّال", "On")}</span><span class="sw-off">${L(lang, "مقفول", "Off")}</span></span></label>${sentence ? html`<p class="muted small sw-hint">${sentence}</p>` : ""}</div>`;
}

/**
 * A choice of two or more options as radio buttons, each written out in full.
 * @param {Object} o - { name, legend, options: [{ value, label, hint? }], value, lang, disabled }
 */
function choiceField({ name, legend, options, value, disabled = false }) {
  return html`<fieldset class="choice"><legend>${legend}</legend>${options.map(
    (o) => html`<label class="choice-opt"><input type="radio" name="${name}" value="${o.value}"${value === o.value ? html` checked` : ""}${disabled ? html` disabled` : ""}><span><b>${o.label}</b>${o.hint ? html`<span class="muted small choice-hint">${o.hint}</span>` : ""}</span></label>`
  )}</fieldset>`;
}

module.exports = { switchField, choiceField };
