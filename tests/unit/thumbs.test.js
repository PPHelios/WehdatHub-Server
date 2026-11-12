// tests/unit/thumbs.test.js — The small copy of a unit photo: 360x270 JPEG.
"use strict";

const sharp = require("sharp");
const { makeThumbBuffer } = require("../../lib/images");

test("a large photo becomes a 360x270 JPEG that is much smaller", async () => {
  const big = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 120, b: 60 } } }).png().toBuffer();
  const small = await makeThumbBuffer(big);
  const meta = await sharp(small).metadata();
  expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 360, 270]);
  expect(small.length).toBeLessThan(big.length);
});
