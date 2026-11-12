// tests/unit/images-normalize.test.js — The server's photo fallback: a photo already at the size the browser/app send is
// stored as it is; a big one, a PNG, or one carrying EXIF/rotation still goes through sharp.
"use strict";

const sharp = require("sharp");
const { normalizeImageBuffer } = require("../../lib/images");

const jpeg = (w, h, meta) => {
  let img = sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 80, b: 40 } } }).jpeg({ quality: 82 });
  if (meta) img = img.withMetadata(meta);
  return img.toBuffer();
};

test("a 1600 px JPEG without EXIF is stored untouched", async () => {
  const raw = await jpeg(1600, 1000);
  expect(await normalizeImageBuffer(raw)).toBe(raw);
});

test("a bigger JPEG is reduced to 1600 px", async () => {
  const out = await normalizeImageBuffer(await jpeg(2400, 1800));
  expect(Math.max((await sharp(out).metadata()).width, (await sharp(out).metadata()).height)).toBe(1600);
});

test("a PNG is converted to JPEG", async () => {
  const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#fff" } }).png().toBuffer();
  const out = await normalizeImageBuffer(png);
  expect((await sharp(out).metadata()).format).toBe("jpeg");
});

test("a rotated JPEG is re-encoded with its rotation applied", async () => {
  const raw = await jpeg(1000, 600, { orientation: 6 });
  const out = await normalizeImageBuffer(raw);
  expect(out).not.toBe(raw);
  const m = await sharp(out).metadata();
  expect([m.width, m.height]).toEqual([600, 1000]);
});
