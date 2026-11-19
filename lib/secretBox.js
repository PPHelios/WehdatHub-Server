// lib/secretBox.js — AES-256-GCM for secrets kept in the database (Facebook Page tokens). Stored form:
// "v1:<iv>:<tag>:<ciphertext>" (base64url). Key: TOKEN_ENCRYPTION_KEY (32 bytes, base64). Outside production a fixed,
// clearly-test key is used when it is not set. A stored value without the "v1:" prefix is a legacy plain value, returned as is.
// Changing the key makes old values unreadable (decrypt throws): re-enter the tokens.
"use strict";

const crypto = require("crypto");
const { getConfig } = require("../config");

const PREFIX = "v1:";
const TEST_KEY = Buffer.alloc(32, "wehdathub-test-key-not-for-production").subarray(0, 32);

/** The 32-byte key, or null when none is usable (production without the variable, or a wrong length). */
function keyOf(config = getConfig()) {
  const raw = String(config?.security?.tokenEncryptionKey || "").trim();
  if (!raw) return config?.isProd ? null : TEST_KEY;
  const k = Buffer.from(raw, "base64");
  return k.length === 32 ? k : null;
}

const hasKey = (config) => keyOf(config) !== null;

function encrypt(plain, { config } = {}) {
  const key = keyOf(config);
  if (!key) throw new Error("encryption_key");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("base64url")}:${c.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
}

function decrypt(stored, { config } = {}) {
  if (stored === null || stored === undefined) return stored;
  const s = String(stored);
  if (!s.startsWith(PREFIX)) return s;
  const key = keyOf(config);
  if (!key) throw new Error("encryption_key");
  const [iv, tag, ct] = s.slice(PREFIX.length).split(":");
  if (!iv || !tag || !ct) throw new Error("secret_format");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

module.exports = { encrypt, decrypt, hasKey };
