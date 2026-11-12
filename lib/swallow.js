// lib/swallow.js — For a catch that must not stop the request but must not hide the error either: it is written to the
// console and to operation_logs (swallowed_error, shown on the Failures page) and the fallback value is returned.
"use strict";

const { logOperation } = require("./db");
const { maskPhones } = require("./errorReports");

/**
 * @param {Object} pool
 * @param {string} where - short place name, e.g. "unitForm.places"
 * @param {*} [fallback] - what the failed step yields
 * @returns {(err: Error) => *} for promise.catch(...)
 */
function logged(pool, where, fallback = undefined) {
  return (err) => {
    const message = maskPhones(`${where}: ${err && err.message ? err.message : err}`).slice(0, 300);
    console.warn(JSON.stringify({ t: new Date().toISOString(), level: "warn", msg: "SWALLOWED_ERROR", where, error: message }));
    if (pool) logOperation(pool, { operation_type: "swallowed_error", status: "error", error_code: message, metadata: { where } }).catch(() => {});
    return fallback;
  };
}

module.exports = { logged };
