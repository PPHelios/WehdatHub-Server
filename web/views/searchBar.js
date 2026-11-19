// web/views/searchBar.js — the one search bar (home and search page): a pill input and ONE round button on the right.
// Empty box: the button is a mic. Typed text: it is a send arrow that searches. While recording (web/static/app.js
// and voice.js) the input is replaced by the red recording rail and the same button sends the note.
"use strict";

const { html, raw } = require("../html");
const { icon } = require("../icons");
const { L } = require("../../lib/copy");

function searchBar({ lang, q = "", label, placeholder, float = false, voiceStart = false }) {
  return html`<form method="get" action="/app/search" class="searchbox sb${float ? " float" : ""}${q ? " has-text" : ""}" role="search" data-search-form>
  <span class="search-icon" aria-hidden="true">${icon("search", 20)}</span><input name="q" value="${q}" dir="${lang === "en" ? "auto" : "rtl"}" aria-label="${label}" placeholder="${placeholder}" autocomplete="off" enterkeyhint="search"${voiceStart ? raw(" data-voice-start") : ""}>
  <button type="button" class="mic sb-act" data-ai="voice_search" data-mic data-search-go data-voice-url="/app/search/voice" aria-pressed="false" data-l-mic="${L(lang, "بحث بالصوت: اضغط عشان تسجّل", "Voice search: tap to record")}" data-l-go="${L(lang, "بحث", "Search")}" data-l-send="${L(lang, "إرسال التسجيل", "Send recording")}" aria-label="${q ? L(lang, "بحث", "Search") : L(lang, "بحث بالصوت: اضغط عشان تسجّل", "Voice search: tap to record")}"><span class="ico-mic">${icon("mic", 22)}</span><span class="ico-send">${icon("send", 22)}</span></button>
</form>`;
}

module.exports = { searchBar };
