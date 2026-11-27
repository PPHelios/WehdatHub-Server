"use strict";
// Tiny in-memory LRU with a per-entry TTL. Map keeps insertion order: the first key is the least recently used.
function createLru({ max = 500, ttlMs = 600000, now = Date.now } = {}) {
  const m = new Map();
  return {
    get(key) {
      const e = m.get(key);
      if (!e) return undefined;
      m.delete(key);
      if (e.exp <= now()) return undefined;
      m.set(key, e);
      return e.value;
    },
    set(key, value) {
      m.delete(key);
      m.set(key, { value, exp: now() + ttlMs });
      while (m.size > max) m.delete(m.keys().next().value);
    },
    get size() {
      return m.size;
    },
    clear: () => m.clear()
  };
}
module.exports = { createLru };
