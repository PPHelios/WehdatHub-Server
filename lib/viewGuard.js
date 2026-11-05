// lib/viewGuard.js — Read-only guard for the test number's "view another agency" mode. While a request runs in that mode,
// the shared pool refuses every statement that is not a plain read, so nothing can be written to the agency being viewed.
// Jobs and Telegram run outside the request, so they never enter this mode.
"use strict";

const { AsyncLocalStorage } = require("async_hooks");

const store = new AsyncLocalStorage();

/** Runs fn with the read-only guard on (everything inside the request). */
const runReadOnly = (fn) => store.run(true, fn);
const active = () => store.getStore() === true;

const READ = /^\s*(select|with)\b/i;
// Anything that can change data, sequences or session settings, even inside a SELECT. Fails closed.
const WRITE = /\b(insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|copy|vacuum|reindex|nextval|setval|set_config|call|do)\b|\block\s+table\b/i;

/** True only for a plain read statement. */
function isReadOnlySql(text) {
  return typeof text === "string" && READ.test(text) && !WRITE.test(text);
}

const blocked = () => {
  const err = new Error("Read only while viewing another agency");
  err.code = "VIEW_READ_ONLY";
  return err;
};

/** Wraps query() on the pool and on clients it hands out. Idempotent. */
function guardPool(pool) {
  if (!pool || pool.__viewGuard) return pool;
  const query = pool.query.bind(pool);
  pool.query = (text, ...rest) => (active() && !isReadOnlySql(text) ? Promise.reject(blocked()) : query(text, ...rest));
  const connect = pool.connect.bind(pool);
  pool.connect = async (...args) => {
    const client = await connect(...args);
    if (client && !client.__viewGuard) {
      const cq = client.query.bind(client);
      client.query = (text, ...rest) => (active() && !isReadOnlySql(text) ? Promise.reject(blocked()) : cq(text, ...rest));
      client.__viewGuard = true;
    }
    return client;
  };
  pool.__viewGuard = true;
  return pool;
}

module.exports = { runReadOnly, active, isReadOnlySql, guardPool };
