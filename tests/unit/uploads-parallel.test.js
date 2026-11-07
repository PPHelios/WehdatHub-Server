// tests/unit/uploads-parallel.test.js — Uploads in parallel (patch 5): only a few run at once, the rest are told to retry, slots are freed.
"use strict";

const express = require("express");
const request = require("supertest");
const { uploads, PHOTO } = require("../../web/uploads");

function app(hold) {
  const a = express();
  a.post("/up", uploads([PHOTO]), (req, res) => hold.then(() => res.send("ok")));
  return a;
}

test("with 4 uploads running the fifth is refused with 503, and a slot frees when one finishes", async () => {
  let release;
  const hold = new Promise((r) => (release = r));
  const srv = app(hold).listen(0);
  try {
    const url = `http://127.0.0.1:${srv.address().port}`;
    const send = () => request(url).post("/up").attach("photos", Buffer.from("x"), { filename: "a.jpg", contentType: "image/jpeg" }).then((r) => r.status);
    const running = [send(), send(), send(), send()];
    await new Promise((r) => setTimeout(r, 400));
    expect(await send()).toBe(503);
    release();
    expect(await Promise.all(running)).toEqual([200, 200, 200, 200]);
    expect(await send()).toBe(200);
  } finally {
    srv.close();
  }
});
