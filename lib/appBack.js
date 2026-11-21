// lib/appBack.js — Where a form may send the user back to: a page of this app only (never another site, never "//").
"use strict";

const APP_PAGE = /^\/app(\/(search|units)?)?(\?[\w=&%.+-]*)?$/;

/** The path when it is a safe app page, else null. */
function appBack(value) {
  const v = String(value || "");
  return APP_PAGE.test(v) && !v.includes("//") ? v : null;
}

module.exports = { appBack };
