// lib/images.js — Listing photo normalization (WhatsApp and web uploads share it). In memory only.
"use strict";

const sharp = require("sharp");

// Constrain Sharp concurrency and memory for Render containers
sharp.concurrency(1);
sharp.cache({ items: 20, memory: 64 });

const MAX_PHOTOS = 15;

/**
 * Normalizes a photo buffer before storage: auto-rotates via EXIF, bounds inside 1600x1600,
 * outputs progressive JPEG Q82.
 */
async function normalizeImageBuffer(rawBuffer) {
  // The browser and the app already send photos at this size (JPEG, longest side 1600, no EXIF): stored as they are, no
  // re-encode on the server. Anything else (a big photo, a PNG, HEIC, a JPEG with EXIF or a rotation) goes through sharp below.
  try {
    const m = await sharp(rawBuffer).metadata();
    if (m.format === "jpeg" && m.width <= 1600 && m.height <= 1600 && !m.exif && !(m.orientation > 1)) return rawBuffer;
  } catch {
    /* unreadable here: sharp below decides */
  }
  return await sharp(rawBuffer)
    .rotate()
    .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, progressive: true })
    .toBuffer();
}

module.exports = { MAX_PHOTOS, normalizeImageBuffer };
