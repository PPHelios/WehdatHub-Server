// web/views/phoneHelp.js — The one helper line under every phone box: which numbers are accepted.
"use strict";

const { html } = require("../html");
const { L } = require("../../lib/copy");

/** "Mobile: 01012345678, or a foreign number with + and the country code. Landlines are not used." */
const phoneHelp = (lang) => html`<small class="muted" data-phone-help>${L(lang, "موبايل بس (مش أرضي): 01012345678، أو رقم أجنبي بـ + وكود الدولة (+971…).", "Mobile only (no landlines): 01012345678, or a foreign number with + and the country code (+971…).")}</small>`;

module.exports = { phoneHelp };
