// tests/unit/secret-box.test.js — lib/secretBox.js: AES-256-GCM for Facebook Page tokens at rest
"use strict";

const crypto = require("crypto");
const SecretBox = require("../../lib/secretBox");

const key = crypto.randomBytes(32).toString("base64");
const cfg = (k, isProd = false) => ({ isProd, security: { tokenEncryptionKey: k } });

describe("secretBox", () => {
  test("round trip, v1 format, a new ciphertext every call, plaintext not inside", () => {
    const a = SecretBox.encrypt("EAAB-secret-token", { config: cfg(key) });
    const b = SecretBox.encrypt("EAAB-secret-token", { config: cfg(key) });
    expect(a).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("EAAB-secret-token");
    expect(SecretBox.decrypt(a, { config: cfg(key) })).toBe("EAAB-secret-token");
    expect(SecretBox.decrypt(b, { config: cfg(key) })).toBe("EAAB-secret-token");
  });

  test("a tampered value, or another key, throws", () => {
    const a = SecretBox.encrypt("token", { config: cfg(key) });
    const parts = a.split(":");
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] ^= 1;
    parts[3] = ct.toString("base64url");
    expect(() => SecretBox.decrypt(parts.join(":"), { config: cfg(key) })).toThrow();
    expect(() => SecretBox.decrypt(a, { config: cfg(crypto.randomBytes(32).toString("base64")) })).toThrow();
  });

  test("a legacy plain value (no v1: prefix) and null pass through", () => {
    expect(SecretBox.decrypt("EAABplain", { config: cfg(key) })).toBe("EAABplain");
    expect(SecretBox.decrypt(null)).toBeNull();
  });

  test("production without a usable key refuses; development falls back to a test key", () => {
    expect(SecretBox.hasKey(cfg("", true))).toBe(false);
    expect(SecretBox.hasKey(cfg("short", true))).toBe(false);
    expect(() => SecretBox.encrypt("t", { config: cfg("", true) })).toThrow("encryption_key");
    expect(SecretBox.hasKey(cfg(""))).toBe(true);
    expect(SecretBox.decrypt(SecretBox.encrypt("t", { config: cfg("") }), { config: cfg("") })).toBe("t");
  });
});
