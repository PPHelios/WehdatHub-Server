// tests/harness/fake-supabase.js — In-memory stand-in for lib/supabase.js (same exports)
"use strict";

const objects = new Map(); // storage path -> Buffer
const BASE = "https://storage.test/listing-images/";

const pathOf = (urlOrPath) => String(urlOrPath || "").replace(BASE, "").replace(/^\/+/, "");

module.exports = {
  // --- lib/supabase.js API ---
  supabase: null,
  uploadListingImage: async (agencyId, storagePath, buffer) => {
    if (!buffer || !storagePath) return null;
    objects.set(pathOf(storagePath), buffer);
    return pathOf(storagePath);
  },
  uploadFlyerImage: async (agencyId, storagePath, buffer) => {
    objects.set(pathOf(storagePath), buffer);
    return pathOf(storagePath);
  },
  uploadAgencyLogo: async (agencyId, storagePath, buffer) => {
    objects.set(pathOf(storagePath), buffer);
    return pathOf(storagePath);
  },
  uploadProjectFile: async (agencyId, storagePath, buffer) => {
    objects.set(pathOf(storagePath), buffer);
    return pathOf(storagePath);
  },
  photoUrl: (value) => {
    if (!value || typeof value !== "string") return null;
    if (/^https?:\/\//i.test(value)) return value;
    return BASE + pathOf(value);
  },
  downloadListingImage: async (keyOrUrl) => {
    if (typeof keyOrUrl !== "string" || !keyOrUrl) return null;
    const buffer = objects.get(pathOf(keyOrUrl));
    return buffer ? { buffer, mimeType: "image/jpeg" } : null;
  },
  deleteStorageFiles: async (paths = []) => {
    for (const p of paths) objects.delete(pathOf(p));
    return true;
  },

  // --- test controls ---
  objects,
  BASE,
  reset() {
    objects.clear();
  }
};
