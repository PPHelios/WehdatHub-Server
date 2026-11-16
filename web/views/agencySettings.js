// web/views/agencySettings.js — The agency's settings forms for the one Settings page (web/routes/settings.js): the dollar
// and euro rates, and the monthly credits, broker caps and unit code letters. They post to the same routes as before
// (/app/usage/fx, /app/usage/agency); `ret` makes those routes come back to Settings.
"use strict";

const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const back = (ret) => (ret ? html`<input type="hidden" name="return" value="${ret}">` : "");

/** The dollar and euro rates: { lang, rates: { USD, EUR }, bad, ret, id }. */
function fxForm({ lang, rates = {}, bad = false, ret = null, id = null }) {
  return html`<form method="post" action="/app/usage/fx" class="card stack" data-fx-rates${id ? html` id="${id}"` : ""}>${back(ret)}
  <h2>${L(lang, "سعر الدولار واليورو", "Dollar and euro rates")}</h2>
  ${bad ? html`<p class="bad" role="alert">${L(lang, "السعر لازم يكون رقم بين 1 و 1000، أو فاضي.", "The rate must be a number from 1 to 1000, or blank.")}</p>` : ""}
  <p class="muted">${L(lang, "بالجنيه لكل وحدة. الوحدات والميزانيات بالدولار أو اليورو بتتحول بيه في البحث. لو فاضي، الوحدات دي مش هتتطابق مع الأسعار.", "In EGP per unit. Dollar and euro units and budgets convert at this rate in search. Blank means those units do not match prices.")}</p>
  <label>${L(lang, "الدولار (ج.م لكل دولار)", "USD (EGP per dollar)")} <input name="USD" inputmode="decimal" dir="ltr" value="${rates.USD ?? ""}" size="8"></label>
  <label>${L(lang, "اليورو (ج.م لكل يورو)", "EUR (EGP per euro)")} <input name="EUR" inputmode="decimal" dir="ltr" value="${rates.EUR ?? ""}" size="8"></label>
  <button type="submit">${L(lang, "حفظ السعر", "Save rates")}</button>
</form>`;
}

/** Monthly bot credits, the daily and weekly cap per broker, and the unit code letters: { lang, state, codePrefix, ret, id }. */
function capsForm({ lang, state, codePrefix = "", ret = null, id = null }) {
  return html`<form method="post" action="/app/usage/agency" class="card stack" data-agency-caps${id ? html` id="${id}"` : ""}>${back(ret)}
  <h2>${L(lang, "رصيد الشركة وحدود البروكرز وحروف الأكواد", "Agency credits, broker caps and unit code letters")}</h2>
  <label>${L(lang, "الرصيد الشهري (رسايل)", "Monthly credits (messages)")} <input type="number" name="monthly" min="0" max="100000" value="${state.limit}"></label>
  <label>${L(lang, "حد يومي لكل بروكر (فاضي = بدون حد)", "Daily cap per broker (empty = off)")} <input type="number" name="daily_cap" min="1" max="10000" value="${state.broker.dailyCap ?? ""}"></label>
  <label>${L(lang, "حد أسبوعي لكل بروكر (فاضي = بدون حد)", "Weekly cap per broker (empty = off)")} <input type="number" name="weekly_cap" min="1" max="50000" value="${state.broker.weeklyCap ?? ""}"></label>
  <label>${L(lang, "حروف أكواد الوحدات (مثال NH ← NH-V12)", "Unit code letters (e.g. NH → NH-V12)")} <input name="code_prefix" maxlength="4" pattern="[A-Za-z]{1,4}" dir="ltr" value="${codePrefix}"></label>
  <p class="muted">${L(lang, "للوحدات اللي بتتضاف من غير كود. الأكواد القديمة مش بتتغير.", "For units added without a code. Existing codes don't change.")}</p>
  <button type="submit">${L(lang, "حفظ", "Save")}</button>
</form>`;
}

module.exports = { fxForm, capsForm };
